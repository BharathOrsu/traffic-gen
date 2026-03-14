# osm_importer_fixed.py

"""
A robust implementation for importing OSM data using SUMO's netconvert and TraCI.
Handles various errors in the process of data conversion.
"""

import os
import subprocess
import sys

class OSMImporter:
    def __init__(self, osm_file, sumo_net_file):
        self.osm_file = osm_file
        self.sumo_net_file = sumo_net_file

    def run_netconvert(self):
        try:
            command = ['netconvert', '-c', self.sumo_net_file]
            subprocess.check_call(command)
        except subprocess.CalledProcessError as e:
            print(f'Error during SUMO netconvert: {e}')
            sys.exit(1)
        except FileNotFoundError:
            print("Error: netconvert command not found. Please ensure SUMO is installed.")
            sys.exit(1)

    def import_osm(self):
        if not os.path.exists(self.osm_file):
            print(f'Error: OSM file {self.osm_file} does not exist.')
            sys.exit(1)
        
        try:
            self.run_netconvert()
            print('OSM Import successful!')
        except Exception as e:
            print(f'An unexpected error occurred: {e}')
            sys.exit(1)

if __name__ == '__main__':
    osm_file = 'path_to_your_osm_file.osm'
    sumo_net_file = 'path_to_your_sumo_net.net.xml'
    importer = OSMImporter(osm_file, sumo_net_file)
    importer.import_osm()
