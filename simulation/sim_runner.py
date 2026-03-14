"""
sim_runner.py
-------------
Standalone TraCI-based simulation runner for IUTMS.

Runs a SUMO simulation on any imported map (OSM or grid) and
streams real step-level metrics to the Node.js telemetry server
via HTTP POST and/or a callback function.

Usage (CLI):
    python -m simulation.sim_runner \
        --net-file  maps/osm/tirupati/map.net.xml \
        --route-file maps/osm/tirupati/map.rou.xml \
        --steps 3600 \
        --telemetry-url http://localhost:3001/api/metrics

Usage (programmatic):
    from simulation.sim_runner import run_simulation
    run_simulation(net_file=..., route_file=..., on_step=my_callback)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── SUMO_HOME auto-detect ────────────────────────────────────────────────────
def _ensure_sumo_home():
    if os.environ.get("SUMO_HOME"):
        return
    for candidate in ["/usr/share/sumo", "/opt/sumo", "/usr/local/share/sumo"]:
        if os.path.isdir(candidate):
            os.environ["SUMO_HOME"] = candidate
            return

_ensure_sumo_home()

try:
    import traci
    import traci.constants as tc
    TRACI_AVAILABLE = True
except ImportError:
    traci = None
    TRACI_AVAILABLE = False

try:
    import requests as _requests
    REQUESTS_AVAILABLE = True
except ImportError:
    _requests = None
    REQUESTS_AVAILABLE = False


# ---------------------------------------------------------------------------
# Default configuration
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "net_file":      "maps/grid.net.xml",
    "route_file":    "maps/grid.rou.xml",
    "max_steps":     3600,
    "step_length":   1.0,          # seconds per simulation step
    "emit_every":    10,           # emit metrics every N steps
    "telemetry_url": "http://localhost:3001/api/metrics",
    "sumo_port":     8813,
    "seed":          42,
    "use_gui":       False,
    "location_name": "",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post_metrics(url: str, payload: dict, timeout: float = 2.0) -> None:
    if not REQUESTS_AVAILABLE or not url:
        return
    try:
        _requests.post(url, json=payload, timeout=timeout)
    except Exception:
        pass


def _collect_step_metrics(step: int, episode: int = 1, location: str = "") -> Dict:
    """Read real metrics from the live SUMO simulation via TraCI."""
    try:
        vehicle_ids = list(traci.vehicle.getIDList())
    except Exception:
        vehicle_ids = []

    n_vehicles = len(vehicle_ids)

    # Average speed (m/s)
    if vehicle_ids:
        try:
            speeds = [traci.vehicle.getSpeed(v) for v in vehicle_ids]
            avg_speed = float(np.mean(speeds))
        except Exception:
            avg_speed = 0.0
    else:
        avg_speed = 0.0

    # Total CO₂ emissions (mg/s)
    try:
        co2 = float(sum(traci.vehicle.getCO2Emission(v) for v in vehicle_ids))
    except Exception:
        co2 = 0.0

    # Waiting / halted vehicles
    try:
        halted = sum(
            1 for v in vehicle_ids
            if traci.vehicle.getSpeed(v) < 0.1
        )
    except Exception:
        halted = 0

    # Mean waiting time (s)
    if vehicle_ids:
        try:
            wait_times = [traci.vehicle.getWaitingTime(v) for v in vehicle_ids]
            mean_wait = float(np.mean(wait_times))
        except Exception:
            mean_wait = 0.0
    else:
        mean_wait = 0.0

    # Cumulative departed / arrived
    try:
        departed = int(traci.simulation.getDepartedNumber())
        arrived  = int(traci.simulation.getArrivedNumber())
    except Exception:
        departed = arrived = 0

    # Traffic signal info
    try:
        tls_ids   = list(traci.trafficlight.getIDList())
        n_signals = len(tls_ids)
    except Exception:
        n_signals = 0

    # Compute a simple "reward" proxy: high speed + low wait = better
    reward = avg_speed * 0.5 - mean_wait * 0.01 - halted * 0.05

    return {
        "episode":             episode,
        "step":                step,
        "total_reward":        round(reward, 4),
        "avg_speed":           round(avg_speed, 3),
        "vehicles_in_network": n_vehicles,
        "co2_emissions":       round(co2, 2),
        "halted_vehicles":     halted,
        "mean_wait_time":      round(mean_wait, 2),
        "departed":            departed,
        "arrived":             arrived,
        "n_signals":           n_signals,
        "location":            location,
        "source":              "sumo_traci",
    }


# ---------------------------------------------------------------------------
# Core simulation loop
# ---------------------------------------------------------------------------

def run_simulation(
    net_file:      str,
    route_file:    str,
    max_steps:     int = 3600,
    step_length:   float = 1.0,
    emit_every:    int = 10,
    telemetry_url: str = "http://localhost:3001/api/metrics",
    sumo_port:     int = 8813,
    seed:          int = 42,
    use_gui:       bool = False,
    location_name: str = "",
    episode:       int = 1,
    on_step:       Optional[Callable[[Dict], None]] = None,
    stop_event=None,
) -> Dict:
    """
    Run one full SUMO simulation episode and stream metrics.

    Parameters
    ----------
    net_file, route_file : paths to SUMO network and route files
    max_steps            : number of simulation steps
    emit_every           : POST metrics every N steps
    telemetry_url        : where to POST metrics
    on_step              : optional callback called with each metrics dict
    stop_event           : threading.Event – set to stop early

    Returns
    -------
    dict  – final summary statistics
    """
    if not TRACI_AVAILABLE:
        raise RuntimeError(
            "TraCI not available. Install SUMO and run: pip install traci"
        )

    _ensure_sumo_home()

    binary = "sumo-gui" if use_gui else "sumo"
    sumo_cmd = [
        binary,
        "-n", net_file,
        "-r", route_file,
        "--step-length", str(step_length),
        "--no-step-log", "true",
        "--waiting-time-memory", "1000",
        "--time-to-teleport", "300",
        "--collision.action", "teleport",
        "--ignore-route-errors", "true",
        "--seed", str(seed),
        "--quit-on-end", "true",
        "--no-warnings", "true",
    ]

    logger.info(
        "Starting SUMO: net=%s  routes=%s  steps=%d",
        Path(net_file).name, Path(route_file).name, max_steps
    )

    traci.start(sumo_cmd, port=sumo_port)

    try:
        step = 0
        t_start = time.time()
        all_speeds: list = []
        all_waits:  list = []

        while step < max_steps:
            if stop_event and stop_event.is_set():
                logger.info("Simulation stopped by stop_event at step %d", step)
                break

            traci.simulationStep()
            step += 1

            # Collect and emit metrics every `emit_every` steps
            if step % emit_every == 0:
                metrics = _collect_step_metrics(step, episode, location_name)
                all_speeds.append(metrics["avg_speed"])
                all_waits.append(metrics["mean_wait_time"])

                _post_metrics(telemetry_url, metrics)
                if on_step:
                    on_step(metrics)

            # Stop if all vehicles have left
            try:
                if step > 60 and traci.simulation.getMinExpectedNumber() == 0:
                    logger.info("All vehicles cleared at step %d", step)
                    break
            except Exception:
                pass

        elapsed = time.time() - t_start
        summary = {
            "steps_run":     step,
            "elapsed_sec":   round(elapsed, 1),
            "mean_speed":    round(float(np.mean(all_speeds)) if all_speeds else 0.0, 3),
            "mean_wait":     round(float(np.mean(all_waits))  if all_waits  else 0.0, 2),
            "location":      location_name,
        }
        logger.info("Simulation complete: %s", summary)
        return summary

    finally:
        try:
            traci.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="IUTMS standalone SUMO simulation runner")
    p.add_argument("--net-file",       default=DEFAULT_CONFIG["net_file"])
    p.add_argument("--route-file",     default=DEFAULT_CONFIG["route_file"])
    p.add_argument("--steps",          type=int,   default=DEFAULT_CONFIG["max_steps"])
    p.add_argument("--step-length",    type=float, default=DEFAULT_CONFIG["step_length"])
    p.add_argument("--emit-every",     type=int,   default=DEFAULT_CONFIG["emit_every"])
    p.add_argument("--telemetry-url",  default=DEFAULT_CONFIG["telemetry_url"])
    p.add_argument("--port",           type=int,   default=DEFAULT_CONFIG["sumo_port"])
    p.add_argument("--seed",           type=int,   default=DEFAULT_CONFIG["seed"])
    p.add_argument("--gui",            action="store_true")
    p.add_argument("--location",       default="", help="Human-readable location name for telemetry")
    return p.parse_args()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    args = _parse_args()
    run_simulation(
        net_file      = args.net_file,
        route_file    = args.route_file,
        max_steps     = args.steps,
        step_length   = args.step_length,
        emit_every    = args.emit_every,
        telemetry_url = args.telemetry_url,
        sumo_port     = args.port,
        seed          = args.seed,
        use_gui       = args.gui,
        location_name = args.location,
    )
