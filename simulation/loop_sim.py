"""Continuous looping simulation for live dashboard demo."""
import sys, os, time, logging
sys.path.insert(0, '/home/user/webapp')
os.environ['SUMO_HOME'] = '/usr/share/sumo'
logging.basicConfig(level=logging.INFO)
from simulation.sim_runner import run_simulation

episode = 1
while True:
    try:
        run_simulation(
            net_file='maps/osm/tirupati/map.net.xml',
            route_file='maps/osm/tirupati/map.rou.xml',
            max_steps=3600,
            emit_every=5,
            telemetry_url='http://localhost:3001/api/metrics',
            sumo_port=8817,
            location_name='Tirupati, Andhra Pradesh',
            episode=episode,
        )
        episode += 1
        time.sleep(2)
    except Exception as e:
        print(f"Episode {episode} error: {e}")
        time.sleep(5)
