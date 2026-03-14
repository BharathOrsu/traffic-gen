/**
 * App.js – IUTMS Real-Time Dashboard
 * Full rewrite with:
 *  - Real SUMO/TraCI metrics from live simulation
 *  - OSM import with progress + auto-launch simulation
 *  - Simulation start/stop control panel
 *  - All 6 live charts: reward, speed, congestion, CO2, halted vehicles, wait time
 *  - Live KPI cards
 *  - Source badge (SUMO Live vs Demo)
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Title, Tooltip, Legend, Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { io } from "socket.io-client";

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend, Filler
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER_URL = process.env.REACT_APP_SERVER_URL || "http://localhost:3001";
const MAX_POINTS = 300;

// ---------------------------------------------------------------------------
// Chart colours
// ---------------------------------------------------------------------------
const C = {
  reward:     { border: "#00e5ff", bg: "rgba(0,229,255,0.10)" },
  speed:      { border: "#69ff47", bg: "rgba(105,255,71,0.10)" },
  congestion: { border: "#ff9800", bg: "rgba(255,152,0,0.10)" },
  co2:        { border: "#ff4d6d", bg: "rgba(255,77,109,0.10)" },
  halted:     { border: "#e040fb", bg: "rgba(224,64,251,0.10)" },
  wait:       { border: "#ffd600", bg: "rgba(255,214,0,0.10)" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function push(arr, val, maxLen = MAX_POINTS) {
  const next = [...arr, val];
  return next.length > maxLen ? next.slice(next.length - maxLen) : next;
}

function makeDataset(label, color, data) {
  return {
    label, data,
    borderColor: color.border,
    backgroundColor: color.bg,
    borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true,
  };
}

function chartOptions(title, yLabel, color) {
  return {
    responsive: true, animation: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: title, color: "#c0c0d0", font: { size: 13, weight: "600" } },
      tooltip: { mode: "index", intersect: false, backgroundColor: "rgba(10,10,30,0.92)" },
    },
    scales: {
      x: { ticks: { color: "#555", maxTicksLimit: 6 }, grid: { color: "rgba(255,255,255,0.04)" } },
      y: {
        title: { display: true, text: yLabel, color: "#777", font: { size: 11 } },
        ticks: { color: "#555" }, grid: { color: "rgba(255,255,255,0.04)" },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------
function KpiCard({ label, value, unit, color = "#00e5ff", badge }) {
  return (
    <div style={kpiCard}>
      <div style={{ fontSize: 26, fontWeight: 700, color, letterSpacing: -1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
        {label}{unit && <span style={{ color: "#555" }}> {unit}</span>}
      </div>
      {badge && <div style={{ marginTop: 4, ...sourceBadge(badge) }}>{badge}</div>}
    </div>
  );
}

function sourceBadge(src) {
  const live = src === "sumo_traci";
  return {
    display: "inline-block", fontSize: 9, fontWeight: 700,
    padding: "2px 7px", borderRadius: 999,
    background: live ? "rgba(105,255,71,0.18)" : "rgba(0,229,255,0.14)",
    color: live ? "#69ff47" : "#00e5ff", textTransform: "uppercase", letterSpacing: 1,
  };
}

// ---------------------------------------------------------------------------
// SimStatus banner
// ---------------------------------------------------------------------------
function SimBanner({ status, onStop }) {
  if (!status) return null;
  const { running, location, step, net_file } = status;
  if (!running) return null;
  const netName = net_file ? net_file.split("/").pop() : "";
  return (
    <div style={{
      background: "rgba(105,255,71,0.08)", border: "1px solid rgba(105,255,71,0.3)",
      borderRadius: 10, padding: "10px 18px", marginBottom: 16,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      flexWrap: "wrap", gap: 8,
    }}>
      <div>
        <span style={{ color: "#69ff47", fontWeight: 700, marginRight: 10 }}>
          🟢 SUMO Simulation Running
        </span>
        <span style={{ color: "#aaa", fontSize: 13 }}>
          {location && <span>📍 {location} · </span>}
          <span>Step {step} · {netName}</span>
        </span>
      </div>
      <button onClick={onStop} style={{
        background: "rgba(255,77,109,0.2)", border: "1px solid #ff4d6d",
        color: "#ff4d6d", borderRadius: 7, padding: "5px 14px",
        cursor: "pointer", fontSize: 12, fontWeight: 700,
      }}>⏹ Stop</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OSM Import panel
// ---------------------------------------------------------------------------
function OsmPanel({ serverUrl, onImportDone }) {
  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState([]);
  const [selected, setSelected]   = useState(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [importErr, setImportErr] = useState("");
  const [steps, setSteps]         = useState(3600);
  const [vehicles, setVehicles]   = useState(400);

  const search = async () => {
    if (!query.trim()) return;
    setResults([]); setImportErr(""); setImportMsg("");
    try {
      const r = await fetch(`${serverUrl}/api/osm/search?q=${encodeURIComponent(query)}&limit=5`);
      const d = await r.json();
      setResults(d.results || []);
      if (!d.results?.length) setImportErr("No locations found.");
    } catch (e) {
      setImportErr("Search failed: " + e.message);
    }
  };

  const doImport = async () => {
    if (!selected) return;
    setImporting(true); setImportErr(""); setImportMsg("⏳ Downloading OSM data & converting to SUMO network…");
    try {
      const r = await fetch(`${serverUrl}/api/osm/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: selected.display_name,
          num_vehicles: vehicles,
          steps,
          auto_simulate: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setImportErr("❌ " + (d.detail || d.error || "Import failed"));
      } else {
        setImportMsg(`✅ Imported: ${d.display_name}${d.simulation_started ? " — SUMO simulation started!" : ""}`);
        if (onImportDone) onImportDone(d);
      }
    } catch (e) {
      setImportErr("❌ Network error: " + e.message);
    } finally {
      setImporting(false);
    }
  };

  const mapUrl = selected
    ? `https://www.openstreetmap.org/?bbox=${selected.boundingbox?.[2]},${selected.boundingbox?.[0]},${selected.boundingbox?.[3]},${selected.boundingbox?.[1]}&mlat=${selected.lat}&mlon=${selected.lon}#map=13/${selected.lat}/${selected.lon}`
    : null;

  return (
    <div style={panel}>
      <h3 style={panelTitle}>🗺️ OSM Map Import + SUMO Simulation</h3>
      <p style={{ color: "#888", fontSize: 12, marginBottom: 12 }}>
        Search any city, import its road network, and launch a real SUMO/TraCI simulation streaming live metrics.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          style={inputStyle}
          placeholder="e.g. Tirupati, Andhra Pradesh"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
        />
        <button style={btnBlue} onClick={search}>🔍 Search</button>
      </div>

      {results.length > 0 && (
        <select
          style={{ ...inputStyle, marginBottom: 10 }}
          value={selected?.display_name || ""}
          onChange={e => setSelected(results.find(r => r.display_name === e.target.value))}
        >
          <option value="">— Select a location —</option>
          {results.map(r => (
            <option key={r.osm_id} value={r.display_name}>{r.display_name}</option>
          ))}
        </select>
      )}

      {selected && mapUrl && (
        <div style={{ marginBottom: 10 }}>
          <a href={mapUrl} target="_blank" rel="noreferrer"
            style={{ color: "#00e5ff", fontSize: 12 }}>
            🔗 View on OpenStreetMap: {selected.display_name.slice(0, 60)}
          </a>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <label style={labelStyle}>
          Vehicles
          <input type="number" style={{ ...inputStyle, width: 90, marginLeft: 6 }}
            value={vehicles} min={50} max={2000}
            onChange={e => setVehicles(parseInt(e.target.value) || 400)} />
        </label>
        <label style={labelStyle}>
          Sim Steps
          <input type="number" style={{ ...inputStyle, width: 90, marginLeft: 6 }}
            value={steps} min={600} max={7200} step={600}
            onChange={e => setSteps(parseInt(e.target.value) || 3600)} />
        </label>
      </div>

      <button
        style={{ ...btnGreen, opacity: (!selected || importing) ? 0.5 : 1 }}
        onClick={doImport}
        disabled={!selected || importing}
      >
        {importing ? "⏳ Importing…" : "🚀 Import & Simulate"}
      </button>

      {importMsg && <div style={{ marginTop: 10, color: "#69ff47", fontSize: 13 }}>{importMsg}</div>}
      {importErr && (
        <div style={{ marginTop: 10, background: "rgba(255,77,109,0.1)", border: "1px solid #ff4d6d",
          borderRadius: 8, padding: "10px 14px", color: "#ff4d6d", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {importErr}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual sim start panel
// ---------------------------------------------------------------------------
function SimStartPanel({ serverUrl }) {
  const [netFile, setNetFile]   = useState("maps/grid.net.xml");
  const [routeFile, setRouteFile] = useState("maps/grid.rou.xml");
  const [location, setLocation] = useState("Grid Network");
  const [steps, setSteps]       = useState(3600);
  const [msg, setMsg]           = useState("");
  const [err, setErr]           = useState("");
  const [loading, setLoading]   = useState(false);

  const start = async () => {
    setLoading(true); setMsg(""); setErr("");
    try {
      const r = await fetch(`${serverUrl}/api/simulation/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ net_file: netFile, route_file: routeFile, location, steps }),
      });
      const d = await r.json();
      if (!r.ok) setErr("❌ " + (d.error || "Failed"));
      else setMsg("✅ " + d.message);
    } catch (e) {
      setErr("❌ " + e.message);
    } finally { setLoading(false); }
  };

  return (
    <div style={panel}>
      <h3 style={panelTitle}>⚙️ Manual Simulation Control</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input style={inputStyle} placeholder="Net file path" value={netFile} onChange={e => setNetFile(e.target.value)} />
        <input style={inputStyle} placeholder="Route file path" value={routeFile} onChange={e => setRouteFile(e.target.value)} />
        <input style={inputStyle} placeholder="Location label" value={location} onChange={e => setLocation(e.target.value)} />
        <label style={labelStyle}>
          Steps:
          <input type="number" style={{ ...inputStyle, width: 100, marginLeft: 8 }}
            value={steps} min={100} max={7200}
            onChange={e => setSteps(parseInt(e.target.value) || 3600)} />
        </label>
        <button style={{ ...btnGreen, opacity: loading ? 0.5 : 1 }} onClick={start} disabled={loading}>
          {loading ? "Starting…" : "▶️ Start SUMO Simulation"}
        </button>
      </div>
      {msg && <div style={{ marginTop: 8, color: "#69ff47", fontSize: 12 }}>{msg}</div>}
      {err && <div style={{ marginTop: 8, color: "#ff4d6d", fontSize: 12 }}>{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
export default function App() {
  // Chart data series
  const [labels,     setLabels]     = useState([]);
  const [rewards,    setRewards]    = useState([]);
  const [speeds,     setSpeeds]     = useState([]);
  const [congestion, setCongestion] = useState([]);
  const [co2,        setCo2]        = useState([]);
  const [halted,     setHalted]     = useState([]);
  const [waitTime,   setWaitTime]   = useState([]);

  // Latest KPI values
  const [latest, setLatest]     = useState(null);
  const [source,  setSource]    = useState("demo");
  const [simStatus, setSimStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState("charts"); // charts | osm | control | about

  const socketRef = useRef(null);

  const handleMetric = useCallback((m) => {
    const label = `${m.episode ? `E${m.episode} ` : ""}S${m.step}`;
    setLabels(prev     => push(prev, label));
    setRewards(prev    => push(prev, m.total_reward ?? 0));
    setSpeeds(prev     => push(prev, m.avg_speed ?? 0));
    setCongestion(prev => push(prev, m.vehicles_in_network ?? 0));
    setCo2(prev        => push(prev, m.co2_emissions ?? 0));
    setHalted(prev     => push(prev, m.halted_vehicles ?? 0));
    setWaitTime(prev   => push(prev, m.mean_wait_time ?? 0));
    setLatest(m);
    setSource(m.source || "demo");
  }, []);

  // Socket.io connection
  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("history", ({ data }) => {
      if (!data?.length) return;
      data.forEach(handleMetric);
    });

    socket.on("step_metrics", handleMetric);

    socket.on("simulation_status", (s) => setSimStatus(s));
    socket.on("simulation_ended",  () => {
      setSimStatus(prev => prev ? { ...prev, running: false } : null);
    });

    return () => socket.disconnect();
  }, [handleMetric]);

  // Stop simulation
  const stopSim = useCallback(async () => {
    try {
      await fetch(`${SERVER_URL}/api/simulation/stop`, { method: "POST" });
    } catch { /* ignore */ }
  }, []);

  // Export CSV
  const exportCsv = () => {
    const rows = [
      ["Step", "Reward", "Speed(m/s)", "Vehicles", "CO2(mg/s)", "Halted", "Wait(s)"],
      ...labels.map((l, i) => [
        l, rewards[i]??0, speeds[i]??0, congestion[i]??0,
        co2[i]??0, halted[i]??0, waitTime[i]??0,
      ]),
    ];
    const csv = rows.map(r => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv," + encodeURIComponent(csv);
    a.download = "iutms_metrics.csv";
    a.click();
  };

  // Chart datasets
  const rewardData     = useMemo(() => ({ labels, datasets: [makeDataset("Reward",       C.reward,     rewards)]    }), [labels, rewards]);
  const speedData      = useMemo(() => ({ labels, datasets: [makeDataset("Speed",        C.speed,      speeds)]     }), [labels, speeds]);
  const congestionData = useMemo(() => ({ labels, datasets: [makeDataset("Vehicles",     C.congestion, congestion)] }), [labels, congestion]);
  const co2Data        = useMemo(() => ({ labels, datasets: [makeDataset("CO₂",          C.co2,        co2)]        }), [labels, co2]);
  const haltedData     = useMemo(() => ({ labels, datasets: [makeDataset("Halted",       C.halted,     halted)]     }), [labels, halted]);
  const waitData       = useMemo(() => ({ labels, datasets: [makeDataset("Wait Time",    C.wait,       waitTime)]   }), [labels, waitTime]);

  const isLive = source === "sumo_traci";

  return (
    <div style={appStyle}>
      {/* ── Header ── */}
      <div style={header}>
        <div>
          <h1 style={titleStyle}>🚦 IUTMS Dashboard</h1>
          <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
            Intelligent Urban Traffic Management System
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, ...sourceBadge(isLive ? "sumo_traci" : "demo") }}>
            {isLive ? "🟢 SUMO Live" : "🔵 Demo Mode"}
          </span>
          <span style={{ width: 8, height: 8, borderRadius: "50%",
            background: connected ? "#69ff47" : "#ff4d6d", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: connected ? "#69ff47" : "#ff4d6d" }}>
            {connected ? "Connected" : "Disconnected"}
          </span>
          <button style={btnSmall} onClick={exportCsv}>📥 CSV</button>
          <a href={`${SERVER_URL}/api/download/project`} style={{ ...btnSmall, textDecoration: "none" }}>
            📦 ZIP
          </a>
        </div>
      </div>

      {/* ── Simulation banner ── */}
      <SimBanner status={simStatus} onStop={stopSim} />

      {/* ── KPI Row ── */}
      {latest && (
        <div style={kpiRow}>
          <KpiCard label="Reward"   value={(latest.total_reward??0).toFixed(3)}            color={C.reward.border}     badge={latest.source} />
          <KpiCard label="Speed"    value={(latest.avg_speed??0).toFixed(2)}   unit="m/s"  color={C.speed.border} />
          <KpiCard label="Vehicles" value={latest.vehicles_in_network??0}                  color={C.congestion.border} />
          <KpiCard label="CO₂"      value={((latest.co2_emissions??0)/1000).toFixed(1)} unit="g/s" color={C.co2.border} />
          <KpiCard label="Halted"   value={latest.halted_vehicles??0}          unit="veh"  color={C.halted.border} />
          <KpiCard label="Wait"     value={(latest.mean_wait_time??0).toFixed(1)} unit="s" color={C.wait.border} />
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {[["charts","📊 Charts"],["osm","🗺️ Import Map"],["control","⚙️ Control"],["about","ℹ️ About"]].map(([k,l]) => (
          <button key={k} style={{ ...tabBtn, ...(activeTab===k ? tabActive : {}) }} onClick={() => setActiveTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {/* ── Charts tab ── */}
      {activeTab === "charts" && (
        <div style={grid}>
          <div style={chartCard}><Line data={rewardData}     options={chartOptions("Reward per Step",       "Reward",   C.reward)}     /></div>
          <div style={chartCard}><Line data={speedData}      options={chartOptions("Avg Vehicle Speed",     "m/s",      C.speed)}      /></div>
          <div style={chartCard}><Line data={congestionData} options={chartOptions("Vehicles in Network",   "Count",    C.congestion)} /></div>
          <div style={chartCard}><Line data={co2Data}        options={chartOptions("CO₂ Emissions",         "mg/s",     C.co2)}        /></div>
          <div style={chartCard}><Line data={haltedData}     options={chartOptions("Halted Vehicles",       "Count",    C.halted)}     /></div>
          <div style={chartCard}><Line data={waitData}       options={chartOptions("Mean Wait Time",        "seconds",  C.wait)}       /></div>
        </div>
      )}

      {/* ── OSM import tab ── */}
      {activeTab === "osm" && (
        <OsmPanel serverUrl={SERVER_URL} onImportDone={() => setActiveTab("charts")} />
      )}

      {/* ── Control tab ── */}
      {activeTab === "control" && (
        <div>
          <SimStartPanel serverUrl={SERVER_URL} />
          <div style={{ ...panel, marginTop: 16 }}>
            <h3 style={panelTitle}>🎮 Demo Mode</h3>
            <p style={{ color: "#777", fontSize: 12, marginBottom: 12 }}>
              Run synthetic MARL training data without SUMO installed.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={btnBlue}
                onClick={() => fetch(`${SERVER_URL}/api/demo/start`, { method: "POST" })}>
                ▶️ Start Demo
              </button>
              <button style={{ ...btnBlue, borderColor: "#ff4d6d", color: "#ff4d6d" }}
                onClick={() => fetch(`${SERVER_URL}/api/demo/stop`, { method: "POST" })}>
                ⏹ Stop Demo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── About tab ── */}
      {activeTab === "about" && (
        <div style={panel}>
          <h3 style={panelTitle}>🚦 About IUTMS</h3>
          <div style={{ color: "#aaa", fontSize: 13, lineHeight: 1.7 }}>
            <p><strong style={{ color: "#e0e0ff" }}>IUTMS</strong> — Intelligent Urban Traffic Management System applies
              <strong> Multi-Agent Reinforcement Learning (MARL)</strong> to adaptive traffic signal control.</p>
            <p>Each signalised intersection runs an independent RL agent (DQN or PPO).
              Agents observe lane queue density, vehicle speed, and downstream occupancy,
              and learn to coordinate green phases to minimise congestion and emissions.</p>
            <h4 style={{ color: "#00e5ff", marginTop: 16 }}>How to use</h4>
            <ol style={{ paddingLeft: 20 }}>
              <li>Click <strong>🗺️ Import Map</strong> to search and import any city via OpenStreetMap.</li>
              <li>IUTMS automatically runs <code>netconvert</code> + <code>randomTrips.py</code> + <code>duarouter</code>.</li>
              <li>A real SUMO/TraCI simulation launches immediately, streaming actual traffic metrics.</li>
              <li>Charts update in real-time as vehicles move through the simulated road network.</li>
            </ol>
            <h4 style={{ color: "#00e5ff", marginTop: 16 }}>Metrics explained</h4>
            <ul style={{ paddingLeft: 20 }}>
              <li><strong style={{ color: C.reward.border }}>Reward</strong> — RL agent reward proxy (speed × 0.5 − wait × 0.01 − halted × 0.05)</li>
              <li><strong style={{ color: C.speed.border }}>Speed</strong> — Mean vehicle speed across the network (m/s)</li>
              <li><strong style={{ color: C.congestion.border }}>Vehicles</strong> — Total vehicles currently in the simulation</li>
              <li><strong style={{ color: C.co2.border }}>CO₂</strong> — Total emissions per step (mg/s, SUMO HBEFA model)</li>
              <li><strong style={{ color: C.halted.border }}>Halted</strong> — Vehicles stopped (speed &lt; 0.1 m/s)</li>
              <li><strong style={{ color: C.wait.border }}>Wait Time</strong> — Mean cumulative waiting time per vehicle (s)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const appStyle = {
  minHeight: "100vh", background: "#080812", color: "#e0e0f0",
  fontFamily: "'Inter', system-ui, sans-serif", padding: "20px 24px",
  boxSizing: "border-box",
};
const header = {
  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
  marginBottom: 20, flexWrap: "wrap", gap: 12,
};
const titleStyle = { margin: 0, fontSize: 22, fontWeight: 800, color: "#fff" };

const kpiRow = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
  gap: 12, marginBottom: 20,
};
const kpiCard = {
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12, padding: "14px 16px",
};

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  gap: 16,
};
const chartCard = {
  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 14, padding: 16,
};

const panel = {
  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14, padding: 20,
};
const panelTitle = { margin: "0 0 14px", fontSize: 16, color: "#e0e0ff" };

const inputStyle = {
  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8, color: "#e0e0f0", padding: "8px 12px", fontSize: 13,
  outline: "none", flex: 1, minWidth: 0,
};
const labelStyle = {
  color: "#aaa", fontSize: 12, display: "flex", alignItems: "center",
};

const btnBlue = {
  background: "rgba(0,229,255,0.12)", border: "1px solid #00e5ff",
  color: "#00e5ff", borderRadius: 8, padding: "8px 18px",
  cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
};
const btnGreen = {
  background: "rgba(105,255,71,0.12)", border: "1px solid #69ff47",
  color: "#69ff47", borderRadius: 8, padding: "8px 18px",
  cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
};
const btnSmall = {
  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
  color: "#aaa", borderRadius: 6, padding: "5px 12px",
  cursor: "pointer", fontSize: 11, fontWeight: 600,
};
const tabBtn = {
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
  color: "#888", borderRadius: 8, padding: "7px 16px",
  cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const tabActive = {
  background: "rgba(0,229,255,0.12)", borderColor: "#00e5ff", color: "#00e5ff",
};
