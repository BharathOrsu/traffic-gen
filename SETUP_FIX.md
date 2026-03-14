# Comprehensive Setup Instructions for SUMO/TraCI/OSM

## Introduction
This document aims to provide a detailed guide for setting up the traffic generation project using SUMO, TraCI, and OpenStreetMap.

## Setup Instructions
1. **Prerequisites**:
   - Ensure you have Python 3.x installed on your system.
   - Install SUMO from the official website: [SUMO Downloads](https://www.eclipse.org/sumo/downloads.html)
   - Make sure to have the TraCI Python library installed. You can do this via pip:
     ```bash
     pip install traci
     ```
   - Download OSM data from [OpenStreetMap](https://www.openstreetmap.org/) that you intend to use.

2. **Project Configuration**:
   - Clone the repository:
     ```bash
     git clone https://github.com/BharathOrsu/traffic-gen.git
     cd traffic-gen
     ```
   - Modify the configuration files to include the paths to your SUMO installation and downloaded OSM data.

3. **Running the Traffic Generation**:
   - Execute the main script using Python:
     ```bash
     python traffic_generator.py
     ```

4. **Verify Setup**:
   - After running the script, check the output for any errors indicating setup issues.

## Troubleshooting Guide
- **SUMO Not Found Error**:
  - If you encounter an error indicating that SUMO was not found, ensure that the SUMO bin directory is correctly specified in the configuration files.
- **TraCI Connection Issues**:
  - If TraCI fails to connect, verify that:
    - SUMO is running without any script errors.
    - You are using the correct ports as specified in the documentation.
- **OSM Import Failures**:
  - If there are issues with OSM data imports:
    - Check that the OSM file is in the correct format and is not corrupted.
    - Validate the data using tools like `osm2sumo` to ensure compatibility with SUMO.

## Summary
Following these setup instructions and troubleshooting recommendations should help you resolve the common issues you may encounter while using SUMO, TraCI, and OSM data in your traffic generation project.

For more detailed instructions, refer to the official documentation of each tool involved.