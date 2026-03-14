"""
osm_importer.py
---------------
OpenStreetMap → SUMO pipeline for IUTMS.

Workflow
--------
1. Nominatim geocoding → bounding box
2. Overpass API → .osm file
3. netconvert → .net.xml
4. randomTrips.py (or duarouter fallback) → .rou.xml
5. Generate .sumocfg

All tools are resolved via SUMO_HOME or PATH automatically.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL  = "https://overpass-api.de/api/interpreter"

_USER_AGENT = os.environ.get(
    "IUTMS_USER_AGENT",
    "IUTMS-TrafficSim/1.0 (https://github.com/tbadrinath/MARLTSOIOSU)",
)

BBOX_MARGIN     = 0.005
MAX_BBOX_SIDE   = 0.08
DEFAULT_NUM_VEHICLES = 400
DEFAULT_ROUTE_PERIOD = 1.0

# Auto-detect SUMO_HOME
def _detect_sumo_home() -> str:
    sumo_home = os.environ.get("SUMO_HOME", "")
    if sumo_home and os.path.isdir(sumo_home):
        return sumo_home
    for candidate in ["/usr/share/sumo", "/opt/sumo", "/usr/local/share/sumo"]:
        if os.path.isdir(candidate):
            os.environ["SUMO_HOME"] = candidate
            return candidate
    return sumo_home


SUMO_HOME = _detect_sumo_home()


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _get(url: str, params: dict, timeout: float = 30.0):
    try:
        import requests
    except ImportError as exc:
        raise RuntimeError("'requests' package required: pip install requests") from exc

    headers = {"User-Agent": _USER_AGENT}
    resp = requests.get(url, params=params, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def search_location(query: str, limit: int = 5) -> List[Dict]:
    params = {"q": query, "format": "json", "limit": str(max(1, min(limit, 10)))}
    resp = _get(NOMINATIM_URL, params, timeout=15.0)
    results = resp.json()
    if not results:
        raise RuntimeError(f"No results found for location: {query!r}")
    return [
        {
            "display_name": r.get("display_name", ""),
            "lat":          float(r.get("lat", 0)),
            "lon":          float(r.get("lon", 0)),
            "boundingbox":  r.get("boundingbox", []),
            "osm_type":     r.get("osm_type", ""),
            "osm_id":       r.get("osm_id", ""),
        }
        for r in results
    ]


def _clamp_bbox(
    min_lat: float, max_lat: float, min_lon: float, max_lon: float
) -> Tuple[float, float, float, float]:
    min_lat -= BBOX_MARGIN
    max_lat += BBOX_MARGIN
    min_lon -= BBOX_MARGIN
    max_lon += BBOX_MARGIN
    lat_span = max_lat - min_lat
    lon_span = max_lon - min_lon
    if lat_span > MAX_BBOX_SIDE:
        mid = (min_lat + max_lat) / 2.0
        min_lat = mid - MAX_BBOX_SIDE / 2.0
        max_lat = mid + MAX_BBOX_SIDE / 2.0
    if lon_span > MAX_BBOX_SIDE:
        mid = (min_lon + max_lon) / 2.0
        min_lon = mid - MAX_BBOX_SIDE / 2.0
        max_lon = mid + MAX_BBOX_SIDE / 2.0
    return min_lat, max_lat, min_lon, max_lon


def download_osm(
    min_lat: float, max_lat: float, min_lon: float, max_lon: float,
    output_file: str,
) -> str:
    min_lat, max_lat, min_lon, max_lon = _clamp_bbox(min_lat, max_lat, min_lon, max_lon)
    bbox_str = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    query = (
        f"[out:xml][timeout:90];"
        f"("
        f'  way["highway"]({bbox_str});'
        f"  >;"
        f");"
        f"out body;"
    )
    logger.info("Downloading OSM data for bbox %s …", bbox_str)
    resp = _get(OVERPASS_URL, {"data": query}, timeout=120.0)
    out = Path(output_file)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    logger.info("OSM data saved → %s (%d bytes)", out, out.stat().st_size)
    return str(out.resolve())


def _find_sumo_tool(tool_name: str) -> Optional[str]:
    """Find a SUMO binary or Python tool."""
    sumo_home = _detect_sumo_home()
    candidates: List[str] = []
    if sumo_home:
        candidates += [
            os.path.join(sumo_home, "bin",   tool_name),
            os.path.join(sumo_home, "tools", tool_name),
            os.path.join(sumo_home, "bin",   tool_name + ".exe"),
            os.path.join(sumo_home, "tools", tool_name + ".py"),
        ]
    path_tool = shutil.which(tool_name)
    if path_tool:
        candidates.append(path_tool)
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def convert_to_sumo(
    osm_file: str,
    net_file: str,
    extra_netconvert_args: Optional[List[str]] = None,
) -> str:
    netconvert = _find_sumo_tool("netconvert") or shutil.which("netconvert")
    if not netconvert:
        raise RuntimeError(
            "SUMO's 'netconvert' tool was not found.  "
            "Install SUMO and ensure it is on PATH or set SUMO_HOME."
        )
    out = Path(net_file)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        netconvert,
        "--osm-files", osm_file,
        "--output-file", str(out),
        "--geometry.remove",
        "--roundabouts.guess",
        "--ramps.guess",
        "--junctions.join",
        "--tls.guess-signals",
        "--tls.discard-simple",
        "--tls.join",
        "--no-turnarounds.except-deadend",
        "--keep-edges.by-vclass", "passenger",
        "--remove-edges.isolated",
        "--no-warnings",
    ]
    if extra_netconvert_args:
        cmd.extend(extra_netconvert_args)
    logger.info("Running netconvert: %s", " ".join(cmd[:4]) + " ...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"netconvert failed:\n{result.stderr[:2000]}")
    if not out.exists():
        raise RuntimeError("netconvert produced no output file.")
    logger.info("Network written → %s", out)
    return str(out.resolve())


def generate_routes(
    net_file: str,
    route_file: str,
    num_vehicles: int = DEFAULT_NUM_VEHICLES,
    seed: int = 42,
    end_time: float = 3600.0,
) -> str:
    """Generate random vehicle routes using randomTrips.py or duarouter fallback."""
    out = Path(route_file)
    out.parent.mkdir(parents=True, exist_ok=True)

    # Try randomTrips.py first (bundled with sumo-tools)
    random_trips = _find_sumo_tool("randomTrips.py") or _find_sumo_tool("randomTrips")
    duarouter    = _find_sumo_tool("duarouter") or shutil.which("duarouter")

    period = max(end_time / max(num_vehicles, 1), 0.5)

    if random_trips:
        python = sys.executable
        trips_file = str(out.parent / "trips.xml")
        # Step 1: generate trips
        cmd_trips = [
            python, random_trips,
            "-n", net_file,
            "-o", trips_file,
            "-b", "0",
            "-e", str(int(end_time)),
            "-p", f"{period:.2f}",
            "--seed", str(seed),
            "--vehicle-class", "passenger",
            "--validate",
        ]
        logger.info("Generating trips with randomTrips.py …")
        r = subprocess.run(cmd_trips, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            logger.warning("randomTrips.py failed: %s", r.stderr[:500])
            # fall through to duarouter-only
        elif Path(trips_file).exists():
            # Step 2: route trips
            if duarouter:
                cmd_route = [
                    duarouter,
                    "--net-file", net_file,
                    "--route-files", trips_file,
                    "--output-file", str(out),
                    "--seed", str(seed),
                    "--ignore-errors",
                    "--no-warnings",
                ]
                logger.info("Routing trips with duarouter …")
                r2 = subprocess.run(cmd_route, capture_output=True, text=True, timeout=120)
                if r2.returncode == 0 and out.exists():
                    logger.info("Routes written → %s", out)
                    return str(out.resolve())
                logger.warning("duarouter failed: %s", r2.stderr[:500])
            # if duarouter failed, use trips directly as routes
            shutil.copy(trips_file, str(out))
            logger.info("Using trips file directly as routes → %s", out)
            return str(out.resolve())

    # Last resort: generate a minimal route file with duarouter from scratch
    if duarouter:
        # Write a minimal trips file
        trips_file = str(out.parent / "trips_fallback.xml")
        veh_lines = []
        for i in range(min(num_vehicles, 200)):
            depart = i * period
            veh_lines.append(
                f'  <trip id="veh{i}" depart="{depart:.1f}" departLane="best" '
                f'departSpeed="max" from="" to=""/>'
            )
        Path(trips_file).write_text(
            f'<routes>\n' + "\n".join(veh_lines) + "\n</routes>\n"
        )
        logger.warning("Using duarouter direct route generation …")
        cmd_dr = [
            duarouter,
            "--net-file", net_file,
            "--output-file", str(out),
            "--seed", str(seed),
            "--no-warnings",
            "--ignore-errors",
            "--random-depart-offset", "1",
            "--begin", "0",
            "--end", str(int(end_time)),
            "--period", f"{period:.2f}",
            "--vehicle-class", "passenger",
        ]
        r3 = subprocess.run(cmd_dr, capture_output=True, text=True, timeout=120)
        if r3.returncode == 0 and out.exists():
            return str(out.resolve())

    raise RuntimeError(
        "Could not generate routes. randomTrips.py and duarouter both failed. "
        "Check SUMO installation."
    )


def write_sumocfg(
    net_file: str,
    route_file: str,
    cfg_file: str,
    end_time: float = 3600.0,
) -> str:
    cfg = Path(cfg_file)
    cfg.parent.mkdir(parents=True, exist_ok=True)
    net_rel   = os.path.relpath(net_file,   str(cfg.parent))
    route_rel = os.path.relpath(route_file, str(cfg.parent))
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <input>
    <net-file value="{net_rel}"/>
    <route-files value="{route_rel}"/>
  </input>
  <time>
    <begin value="0"/>
    <end value="{int(end_time)}"/>
  </time>
  <processing>
    <ignore-route-errors value="true"/>
    <time-to-teleport value="300"/>
    <waiting-time-memory value="1000"/>
  </processing>
  <report>
    <no-step-log value="true"/>
    <no-warnings value="true"/>
  </report>
</configuration>
"""
    cfg.write_text(content)
    logger.info("sumocfg written → %s", cfg)
    return str(cfg.resolve())


def import_map(
    location: str,
    output_dir: str = "maps/osm_import",
    num_vehicles: int = DEFAULT_NUM_VEHICLES,
    seed: int = 42,
    end_time: float = 3600.0,
) -> Dict:
    """
    Full pipeline: location string → SUMO-ready files.

    Returns dict with keys:
      display_name, net_file, route_file, cfg_file, bbox
    """
    _detect_sumo_home()

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 1. Geocode
    logger.info("Geocoding '%s' …", location)
    results = search_location(location, limit=1)
    place   = results[0]
    bb = place["boundingbox"]
    min_lat, max_lat = float(bb[0]), float(bb[1])
    min_lon, max_lon = float(bb[2]), float(bb[3])
    logger.info("Bounding box: %s", bb)

    # 2. Download OSM
    osm_file = str(out / "map.osm")
    download_osm(min_lat, max_lat, min_lon, max_lon, osm_file)

    # 3. Convert to SUMO network
    net_file = str(out / "map.net.xml")
    convert_to_sumo(osm_file, net_file)

    # 4. Generate routes
    route_file = str(out / "map.rou.xml")
    generate_routes(net_file, route_file, num_vehicles=num_vehicles,
                    seed=seed, end_time=end_time)

    # 5. Write .sumocfg
    cfg_file = str(out / "simulation.sumocfg")
    write_sumocfg(net_file, route_file, cfg_file, end_time=end_time)

    return {
        "display_name": place["display_name"],
        "net_file":     net_file,
        "route_file":   route_file,
        "cfg_file":     cfg_file,
        "bbox":         [min_lat, max_lat, min_lon, max_lon],
    }
