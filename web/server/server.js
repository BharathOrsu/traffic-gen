/**
 * server.js
 * ---------
 * Express + Socket.io telemetry server for IUTMS.
 *
 * Endpoints:
 *  POST /api/metrics            – ingest step metrics from Python sim
 *  GET  /api/metrics/history    – fetch buffered history
 *  GET  /api/status             – health check
 *  GET  /api/export/codebase    – download project ZIP
 *  GET  /api/download/project   – download pre-built project ZIP
 *  GET  /api/osm/search         – Nominatim geocode proxy
 *  POST /api/osm/import         – OSM → SUMO pipeline (netconvert + routes)
 *  POST /api/simulation/start   – start a real SUMO/TraCI simulation
 *  POST /api/simulation/stop    – stop running simulation
 *  GET  /api/simulation/status  – current simulation state
 *  POST /api/demo/start         – start synthetic demo
 *  POST /api/demo/stop          – stop synthetic demo
 *  GET  /api/demo/status        – demo state
 */

"use strict";

const http        = require("http");
const https       = require("https");
const path        = require("path");
const { execFile, spawn } = require("child_process");
const os          = require("os");
const fs          = require("fs");

const cors      = require("cors");
const express   = require("express");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT        = process.env.PORT || 3001;
const MAX_HISTORY = 500;
const REPO_ROOT   = path.resolve(__dirname, "..", "..");
const PYTHON_BIN  = process.env.PYTHON_BIN || "python3";
const REPO_NAME   = path.basename(REPO_ROOT);
const SUMO_HOME   = process.env.SUMO_HOME || "/usr/share/sumo";

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Ring-buffer for metrics history
// ---------------------------------------------------------------------------

const metricsRing = new Array(MAX_HISTORY).fill(null);
let ringHead  = 0;
let ringCount = 0;

function appendMetric(payload) {
  metricsRing[ringHead] = { ...payload, serverTs: Date.now() };
  ringHead  = (ringHead + 1) % MAX_HISTORY;
  if (ringCount < MAX_HISTORY) ringCount++;
}

function getRecentHistory(limit) {
  const count  = Math.min(limit, ringCount);
  const result = new Array(count);
  const start  = (ringHead - count + MAX_HISTORY) % MAX_HISTORY;
  for (let i = 0; i < count; i++) {
    result[i] = metricsRing[(start + i) % MAX_HISTORY];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

let _simProcess  = null;   // running Python child process
let _simRunning  = false;
let _simLocation = "";
let _simNetFile  = "";
let _simRouteFile = "";
let _simStep     = 0;
let _simEpisode  = 1;
let _simStarted  = null;

function setSimState(running, location, netFile, routeFile) {
  _simRunning   = running;
  _simLocation  = location  || "";
  _simNetFile   = netFile   || "";
  _simRouteFile = routeFile || "";
  if (running) { _simStep = 0; _simStarted = Date.now(); }
  io.emit("simulation_status", getSimStatus());
}

function getSimStatus() {
  return {
    running:   _simRunning,
    location:  _simLocation,
    net_file:  _simNetFile,
    route_file: _simRouteFile,
    step:      _simStep,
    episode:   _simEpisode,
    started:   _simStarted,
  };
}

// ---------------------------------------------------------------------------
// Core metric endpoints
// ---------------------------------------------------------------------------

app.post("/api/metrics", (req, res) => {
  const payload = req.body;
  if (!payload || payload.step === undefined) {
    return res.status(400).json({ error: "Missing field: step" });
  }
  // update running step counter
  if (typeof payload.step === "number") _simStep = payload.step;

  appendMetric(payload);
  io.emit("step_metrics", { ...payload, serverTs: Date.now() });
  return res.status(200).json({ ok: true });
});

app.get("/api/metrics/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || MAX_HISTORY, MAX_HISTORY);
  const data  = getRecentHistory(limit);
  return res.json({ count: data.length, data });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status:           "ok",
    uptime:           process.uptime(),
    metricsBuffered:  ringCount,
    connectedClients: io.engine.clientsCount,
    demoRunning:      _demoTimer !== null,
    simRunning:       _simRunning,
    simLocation:      _simLocation,
    simStep:          _simStep,
  });
});

// ---------------------------------------------------------------------------
// Real SUMO simulation endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/simulation/start
 * --------------------------
 * Launch a real SUMO/TraCI simulation in a background Python process.
 * Body: { net_file, route_file, location, steps, emit_every, port }
 */
app.post("/api/simulation/start", (req, res) => {
  if (_simRunning) {
    return res.status(409).json({ error: "A simulation is already running. Stop it first." });
  }

  const {
    net_file,
    route_file,
    location  = "",
    steps     = 3600,
    emit_every = 10,
    port      = 8814,
  } = req.body || {};

  if (!net_file || !route_file) {
    return res.status(400).json({ error: "net_file and route_file are required." });
  }

  // Stop demo if running
  stopServerDemo();

  // Build Python inline script
  const pyCode = [
    "import sys, os",
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    `os.environ['SUMO_HOME'] = ${JSON.stringify(SUMO_HOME)}`,
    "from simulation.sim_runner import run_simulation",
    `run_simulation(`,
    `  net_file=${JSON.stringify(net_file)},`,
    `  route_file=${JSON.stringify(route_file)},`,
    `  max_steps=${Math.min(Math.max(parseInt(steps) || 3600, 100), 7200)},`,
    `  emit_every=${Math.min(Math.max(parseInt(emit_every) || 10, 5), 50)},`,
    `  telemetry_url="http://localhost:${PORT}/api/metrics",`,
    `  sumo_port=${parseInt(port) || 8814},`,
    `  location_name=${JSON.stringify(location)},`,
    `)`,
  ].join("\n");

  console.log(`[Simulation] Starting SUMO sim for '${location}'  net=${path.basename(net_file)}`);

  _simProcess = spawn(PYTHON_BIN, ["-c", pyCode], {
    cwd: REPO_ROOT,
    env: { ...process.env, SUMO_HOME },
  });

  setSimState(true, location, net_file, route_file);

  _simProcess.stdout.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[Sim stdout] ${line}`);
  });

  _simProcess.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line && !line.startsWith("Warning") && !line.startsWith("Loading")) {
      console.log(`[Sim stderr] ${line}`);
    }
  });

  _simProcess.on("exit", (code) => {
    console.log(`[Simulation] Process exited with code ${code}`);
    setSimState(false, _simLocation, "", "");
    _simProcess = null;
    io.emit("simulation_ended", { code, location: _simLocation });
  });

  return res.json({
    ok: true,
    message: `Simulation started for '${location}'.`,
    status: getSimStatus(),
  });
});

/**
 * POST /api/simulation/stop
 * -------------------------
 * Kill the running simulation process.
 */
app.post("/api/simulation/stop", (_req, res) => {
  if (!_simRunning || !_simProcess) {
    return res.status(400).json({ error: "No simulation is currently running." });
  }
  _simProcess.kill("SIGTERM");
  setTimeout(() => {
    if (_simProcess) _simProcess.kill("SIGKILL");
  }, 3000);
  setSimState(false, _simLocation, "", "");
  _simProcess = null;
  return res.json({ ok: true, message: "Simulation stopped." });
});

/**
 * GET /api/simulation/status
 * --------------------------
 * Current simulation state.
 */
app.get("/api/simulation/status", (_req, res) => {
  res.json(getSimStatus());
});

// ---------------------------------------------------------------------------
// OSM import → auto-start simulation
// ---------------------------------------------------------------------------

function parseEnvInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const OSM_RATE_LIMIT     = parseEnvInt(process.env.OSM_RATE_LIMIT,     5);
const OSM_RATE_WINDOW_MS = parseEnvInt(process.env.OSM_RATE_WINDOW_MS, 60_000);
const _osmRateMap = new Map();

function osmRateLimiter(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = _osmRateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + OSM_RATE_WINDOW_MS };
    _osmRateMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > OSM_RATE_LIMIT) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many requests. Please wait." });
  }
  next();
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "IUTMS-TrafficSim/1.0" } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("Invalid JSON: " + e.message)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
  });
}

/**
 * GET /api/osm/search?q=<location>
 */
app.get("/api/osm/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Missing: q" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 10);
  try {
    const params = new URLSearchParams({ q: query, format: "json", limit: String(limit) });
    const data   = await httpsGetJson(`https://nominatim.openstreetmap.org/search?${params}`);
    const results = (Array.isArray(data) ? data : []).map((r) => ({
      display_name: r.display_name || "",
      lat:          parseFloat(r.lat) || 0,
      lon:          parseFloat(r.lon) || 0,
      boundingbox:  r.boundingbox  || [],
      osm_type:     r.osm_type     || "",
      osm_id:       r.osm_id       || "",
    }));
    return res.json({ count: results.length, results });
  } catch (err) {
    console.error("[OSM search]", err.message);
    return res.status(502).json({ error: "Nominatim request failed: " + err.message });
  }
});

/**
 * POST /api/osm/import
 * --------------------
 * Download OSM data, convert to SUMO net+routes, then optionally
 * auto-start the simulation.
 *
 * Body: { location, num_vehicles, seed, auto_simulate, steps }
 */
app.post("/api/osm/import", osmRateLimiter, (req, res) => {
  const {
    location,
    num_vehicles   = 400,
    seed           = 42,
    auto_simulate  = true,
    steps          = 3600,
  } = req.body || {};

  if (!location || !location.trim()) {
    return res.status(400).json({ error: "Missing: location" });
  }

  const sanitised = location.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const outputDir = path.join(REPO_ROOT, "maps", "osm", sanitised);

  // Emit progress to clients
  io.emit("osm_import_progress", { status: "started", location });

  const pyCode = [
    "import sys, os, json",
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    `os.environ['SUMO_HOME'] = ${JSON.stringify(SUMO_HOME)}`,
    "from simulation.osm_importer import import_map",
    `result = import_map(`,
    `  ${JSON.stringify(location)},`,
    `  ${JSON.stringify(outputDir)},`,
    `  num_vehicles=${parseInt(num_vehicles) || 400},`,
    `  seed=${parseInt(seed) || 42},`,
    `)`,
    "print(json.dumps(result))",
  ].join("\n");

  execFile(
    PYTHON_BIN,
    ["-c", pyCode],
    {
      cwd: REPO_ROOT,
      timeout: parseEnvInt(process.env.OSM_IMPORT_TIMEOUT_MS, 180_000),
      env: { ...process.env, SUMO_HOME },
    },
    (err, stdout, stderr) => {
      if (err) {
        console.error("[OSM import] Error:", stderr || err.message);
        io.emit("osm_import_progress", { status: "error", location, error: (stderr || err.message).slice(0, 500) });
        return res.status(500).json({
          error: "OSM import failed",
          detail: (stderr || err.message || "").slice(0, 1000),
        });
      }

      let result;
      try { result = JSON.parse(stdout.trim()); }
      catch (e) {
        return res.status(500).json({ error: "Failed to parse output", detail: stdout.slice(0, 500) });
      }

      io.emit("osm_import_complete", result);
      console.log(`[OSM import] Complete: ${result.display_name}`);

      // Auto-start SUMO simulation
      if (auto_simulate && result.net_file && result.route_file) {
        if (_simRunning && _simProcess) {
          _simProcess.kill("SIGTERM");
          _simProcess = null;
          setSimState(false, "", "", "");
        }
        stopServerDemo();

        const autoSteps = Math.min(parseInt(steps) || 3600, 7200);
        const simPyCode = [
          "import sys, os",
          `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
          `os.environ['SUMO_HOME'] = ${JSON.stringify(SUMO_HOME)}`,
          "from simulation.sim_runner import run_simulation",
          `run_simulation(`,
          `  net_file=${JSON.stringify(result.net_file)},`,
          `  route_file=${JSON.stringify(result.route_file)},`,
          `  max_steps=${autoSteps},`,
          `  emit_every=10,`,
          `  telemetry_url="http://localhost:${PORT}/api/metrics",`,
          `  sumo_port=8814,`,
          `  location_name=${JSON.stringify(result.display_name)},`,
          `)`,
        ].join("\n");

        _simProcess = spawn(PYTHON_BIN, ["-c", simPyCode], {
          cwd: REPO_ROOT,
          env: { ...process.env, SUMO_HOME },
        });
        setSimState(true, result.display_name, result.net_file, result.route_file);

        _simProcess.stdout.on("data", (d) => { const l = d.toString().trim(); if(l) console.log("[Sim]", l); });
        _simProcess.stderr.on("data", (d) => { const l = d.toString().trim(); if(l && !l.startsWith("Warning") && !l.startsWith("Loading")) console.log("[Sim err]", l); });
        _simProcess.on("exit", (code) => {
          console.log(`[Simulation] Exited code=${code}`);
          const loc = _simLocation;
          setSimState(false, loc, "", "");
          _simProcess = null;
          io.emit("simulation_ended", { code, location: loc });
        });

        result.simulation_started = true;
      }

      return res.json(result);
    }
  );
});

// ---------------------------------------------------------------------------
// Demo endpoints
// ---------------------------------------------------------------------------

const DEMO_INTERVAL_MS = 150;
const DEMO_STEP_SIZE   = 10;
const DEMO_MAX_STEPS   = 3600;
const DEMO_TOTAL_EP    = 50;

let _demoTimer   = null;
let _demoStep    = 0;
let _demoEpisode = 1;

function generateServerDemoMetric(step, episode) {
  const ep  = Math.min((episode - 1) / DEMO_TOTAL_EP, 1);
  const ph  = step / DEMO_MAX_STEPS;
  const r   = () => (Math.random() - 0.5);
  return {
    step, episode,
    source:              "demo",
    total_reward:        +(-12 + ep*20 + Math.sin(ph*Math.PI*4)*2 + r()*3).toFixed(3),
    avg_speed:           +(6  + ep*8  + Math.sin(ph*Math.PI*3)*1.5 + r()*0.8).toFixed(2),
    vehicles_in_network: Math.max(0, Math.round(120 - ep*80 - Math.sin(ph*Math.PI*2)*10 + r()*15)),
    co2_emissions:       +(800 - ep*400 + Math.sin(ph*Math.PI*2)*60 + r()*40).toFixed(1),
    halted_vehicles:     Math.max(0, Math.round(40 - ep*30 + r()*5)),
    mean_wait_time:      +(60  - ep*45  + r()*5).toFixed(1),
  };
}

function startServerDemo() {
  if (_demoTimer) return;
  _demoStep = 0; _demoEpisode = 1;
  _demoTimer = setInterval(() => {
    const m = generateServerDemoMetric(_demoStep, _demoEpisode);
    appendMetric(m);
    io.emit("step_metrics", { ...m, serverTs: Date.now() });
    _demoStep += DEMO_STEP_SIZE;
    if (_demoStep >= DEMO_MAX_STEPS) {
      _demoStep = 0;
      _demoEpisode = (_demoEpisode >= DEMO_TOTAL_EP) ? 1 : _demoEpisode + 1;
    }
  }, DEMO_INTERVAL_MS);
  console.log("[Demo] Started.");
}

function stopServerDemo() {
  if (!_demoTimer) return;
  clearInterval(_demoTimer);
  _demoTimer = null;
  console.log("[Demo] Stopped.");
}

app.post("/api/demo/start", (_req, res) => { startServerDemo(); res.json({ ok: true }); });
app.post("/api/demo/stop",  (_req, res) => { stopServerDemo();  res.json({ ok: true }); });
app.get("/api/demo/status", (_req, res) => {
  res.json({ running: _demoTimer !== null, episode: _demoEpisode, step: _demoStep });
});

// ---------------------------------------------------------------------------
// Download endpoints
// ---------------------------------------------------------------------------

function buildCodebaseArchive(outputPath, callback) {
  execFile(
    PYTHON_BIN,
    ["-m", "simulation.codebase_exporter", "--output", outputPath, "--repo-root", REPO_ROOT],
    { cwd: REPO_ROOT, timeout: parseEnvInt(process.env.CODEBASE_EXPORT_TIMEOUT_MS, 120_000) },
    callback
  );
}

const codebaseExportRateLimiter = rateLimit({
  windowMs: parseEnvInt(process.env.CODEBASE_EXPORT_RATE_WINDOW_MS, 60_000),
  limit:    parseEnvInt(process.env.CODEBASE_EXPORT_RATE_LIMIT, 5),
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many export requests." },
});

app.get("/api/export/codebase", codebaseExportRateLimiter, (_req, res) => {
  const tempDir    = fs.mkdtempSync(path.join(os.tmpdir(), "iutms-export-"));
  const archiveName = `${REPO_NAME}-codebase-${new Date().toISOString().replace(/[:.]/g,"-")}.zip`;
  const archivePath = path.join(tempDir, archiveName);
  buildCodebaseArchive(archivePath, (err, _stdout, stderr) => {
    if (err) {
      fs.rm(tempDir, { recursive:true, force:true }, ()=>{});
      return res.status(500).json({ error: "Export failed: " + (stderr||err.message).slice(0,200) });
    }
    res.download(archivePath, archiveName, () => {
      fs.rm(tempDir, { recursive:true, force:true }, ()=>{});
    });
  });
});

app.get("/api/download/project", (_req, res) => {
  const zipPath = path.join(__dirname, "IUTMS-full-project.zip");
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: "ZIP not found." });
  }
  res.download(zipPath, "IUTMS-full-project.zip");
});

// ---------------------------------------------------------------------------
// Static file serving (pre-built React app)
// ---------------------------------------------------------------------------

const CLIENT_BUILD = path.join(__dirname, "..", "client", "build");
const CLIENT_INDEX = path.join(CLIENT_BUILD, "index.html");

if (fs.existsSync(CLIENT_BUILD)) {
  app.use(express.static(CLIENT_BUILD));
  const indexHtml = fs.existsSync(CLIENT_INDEX) ? fs.readFileSync(CLIENT_INDEX) : null;
  if (indexHtml) {
    app.get(/^(?!\/api\/).*/, (_req, res) => res.type("html").send(indexHtml));
  }
  console.log(`[Static] Serving React build from ${CLIENT_BUILD}`);
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`[Socket.io] Connected: ${socket.id}`);
  // Send history and current simulation state to new client
  socket.emit("history", { count: ringCount, data: getRecentHistory(MAX_HISTORY) });
  socket.emit("simulation_status", getSimStatus());
  socket.on("disconnect", () => console.log(`[Socket.io] Disconnected: ${socket.id}`));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\nIUTMS server running on http://localhost:${PORT}`);
  console.log(`  POST /api/metrics              – ingest step metrics`);
  console.log(`  GET  /api/metrics/history      – fetch history`);
  console.log(`  GET  /api/status               – health check`);
  console.log(`  GET  /api/osm/search           – geocode (Nominatim)`);
  console.log(`  POST /api/osm/import           – OSM → SUMO + auto-simulate`);
  console.log(`  POST /api/simulation/start     – start SUMO simulation`);
  console.log(`  POST /api/simulation/stop      – stop simulation`);
  console.log(`  GET  /api/simulation/status    – simulation state`);
  console.log(`  GET  /api/export/codebase      – download source ZIP`);
  console.log(`  GET  /api/download/project     – download full project ZIP`);
  console.log(`  POST /api/demo/start|stop      – synthetic demo`);

  if (process.env.DEMO === "true") {
    startServerDemo();
    console.log(`[Demo] Auto-started (DEMO=true)`);
  }
});

module.exports = { app, server, io, startServerDemo, stopServerDemo };
