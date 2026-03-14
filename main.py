import os
import sys

class TrafficGen:
    def __init__(self):
        self.menu_options = {
            '1': 'Start Traffic Generation',
            '2': 'Stop Traffic Generation',
            '3': 'Check Status',
            '4': 'Exit'
        }

    def display_menu(self):
        print("\nTraffic Generation Tool Menu:")
        for key, value in self.menu_options.items():
            print(f"{key}. {value}")

    def validate_setup(self):
        # Placeholder for setup validation logic
        print("Validating setup...")
        # Simulate validation logic, e.g. checking required files, environment, etc.
        required_files = ['config.yaml', 'data.csv']
        for file in required_files:
            if not os.path.isfile(file):
                print(f"Missing required file: {file}")
                return False
        print("Setup is valid.")
        return True

    def run(self):
        if not self.validate_setup():
            print("Setup is invalid. Please check the above errors.")
            sys.exit(1)

        while True:
            self.display_menu()
            choice = input("Enter your choice: ")
            self.handle_choice(choice)

    def handle_choice(self, choice):
        if choice == '1':
            print("Starting traffic generation...")
            # Call the method related to starting traffic generation
        elif choice == '2':
            print("Stopping traffic generation...")
            # Call the method related to stopping traffic generation
        elif choice == '3':
            print("Checking status...")
            # Call the method related to checking status
        elif choice == '4':
            print("Exiting...")
            sys.exit(0)
        else:
            print("Invalid choice, please try again.")

if __name__ == '__main__':
    TrafficGen().run()