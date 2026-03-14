import traci
import sys

class TraCIWrapper:
    def __init__(self, sumoBinary):
        self.sumoBinary = sumoBinary
        self.traciStarted = False

    def startTraCI(self):
        try:
            traci.start([self.sumoBinary, "-c", "your_config_file.sumocfg"])
            self.traciStarted = True
        except Exception as e:
            print(f"Error starting TraCI: {e}")
            sys.exit(1)

    def stopTraCI(self):
        if self.traciStarted:
            traci.close()
            self.traciStarted = False

# Example usage:
if __name__ == '__main__':
    wrapper = TraCIWrapper('/path/to/sumo')
    wrapper.startTraCI()
    # Your simulation code here
    wrapper.stopTraCI()