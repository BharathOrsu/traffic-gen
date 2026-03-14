# Installation Guide for SUMO and Dependencies

This guide will walk you through the step-by-step installation of SUMO (Simulation of Urban MObility) and its required dependencies.

## Step 1: Install Python

1. Download Python from the official website: [Python Downloads](https://www.python.org/downloads/).
2. Follow the installation instructions for your operating system.
3. Verify the installation by running `python --version` in your terminal.

## Step 2: Install SUMO

### Option A: Install SUMO via Package Manager
- **For Ubuntu/Debian:**
  ```bash
  sudo apt-get install sumo sumo-tools sumo-doc
  ```

- **For MacOS:**
  ```bash
  brew install sumo
  ```

### Option B: Build SUMO from Source
1. Clone the SUMO repository:
   ```bash
   git clone https://gitlab.com/sumoGST/sumo.git
   cd sumo
   ```
2. Install necessary build tools:
   ```bash
   sudo apt-get install cmake build-essential
   ```
3. To build SUMO, follow the commands:
   ```bash
   mkdir build && cd build
   cmake ..
   make
   make install
   ```

## Step 3: Install Additional Dependencies
- SUMO may require additional dependencies based on your requirements. Common dependencies include:
  - `gdal`
  - `libproj-dev`
  - `libgtk2.0-dev`


### Installing Additional Dependencies on Ubuntu
```bash
sudo apt-get install gdal-bin libgdal-dev libproj-dev libgtk2.0-dev
```

## Step 4: Verify Installation

1. To verify SUMO installation, run:
   ```bash
   sumo --version
   ```

2. You should see the version number of SUMO displayed.

## Conclusion

You have successfully installed SUMO and its dependencies. Now you can start using SUMO for your traffic simulations!