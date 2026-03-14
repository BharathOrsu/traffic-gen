# QUICK START Guide for Traffic-Gen

## Overview
This guide provides a comprehensive quick start to help you set up and run the Traffic-Gen project using SUMO.

## SUMO Installation
1. **Download SUMO**:
   - Go to the official SUMO website: [SUMO Download](https://sumo.dlr.de/download)
   - Choose the appropriate version for your operating system (Windows, macOS, Linux).

2. **Install SUMO**:
   - Follow the installation instructions provided for your OS. For Windows, there is an installer; for Linux, you may need to use package managers like `apt` or `yum`.

## Setup Steps
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/BharathOrsu/traffic-gen.git
   cd traffic-gen
   ```

2. **Install Dependencies**:
   - Make sure you have Python installed. For example, version 3.7 or newer is recommended.
   - Install required Python packages:
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure SUMO**:
   - Ensure that the SUMO path is set correctly in your environment variables or modify the configuration files in the project as necessary.

## Running Instructions
1. **Launch SUMO**:
   - Start SUMO with your configuration as follows:
   ```bash
   sumo -c <path_to_your_sumo_config_file>.sumocfg
   ```

2. **Run Traffic-Gen**:
   - Execute the following command to start generating traffic:
   ```bash
   python traffic_gen.py
   ```

## Troubleshooting
- **Common Errors**:
  - **SUMO not found**: Make sure to check your environment variable setup for SUMO.
  - **Missing dependencies**: Verify that all required Python packages are installed. Run the `pip install -r requirements.txt` command again if needed.
- For any other specific issues, consult the issues page on the GitHub repo or reach out for help.

## Configuration Reference
- **SUMO Configuration Files**:
  - Locate the configuration files in the `configs/` directory. Adjust the parameters according to your simulation requirements. Common parameters to modify include:
    - `net.xml`: Define your network layout.
    - `routes.rou.xml`: Specify the traffic routes.
    - `sumocfg`: The main configuration file for SUMO run.

- **Traffic Generator Configuration**:
  - Look into the `config.json` file for options related to traffic generation settings such as the density of vehicles, types of vehicles, and duration of the simulation.

## Conclusion
With these instructions, you should be able to get Traffic-Gen up and running efficiently with SUMO. For further details, refer to the README or the documentation sections in the repository.