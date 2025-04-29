#!/usr/bin/env python
"""
Test script for the GPS module to verify it's using real GPS data.
This script will continuously print the GPS location and indicate if it's using real GPS data.
"""

import time
import logging
from gps_module import GPSModule

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test_real_gps")

def main():
    # Use COM8 for the GPS device (based on available ports)
    gps_port = "COM9"
    
    # Try different baudrates if needed
    baudrate = 4800
    
    # Set force_real=True to only use real GPS (no simulation fallback)
    gps = GPSModule(port=gps_port, baudrate=baudrate, simulation_mode=False, force_real=True)
    
    logger.info(f"Starting GPS test with real GPS device on port {gps_port}")
    logger.info("This script will only use real GPS data and will not fall back to simulation")
    logger.info("Press Ctrl+C to exit")
    
    # Start the GPS module
    gps.start()
    
    try:
        # Monitor GPS data for 60 seconds
        start_time = time.time()
        data_received = False
        
        while (time.time() - start_time) < 60:  # Run for 60 seconds
            location = gps.get_location()
            
            if location:
                data_received = True
                logger.info("-" * 50)
                logger.info(f"GPS DATA RECEIVED!")
                logger.info(f"Using real GPS: {gps.is_using_real_gps()}")
                logger.info(f"Latitude: {location['latitude']}")
                logger.info(f"Longitude: {location['longitude']}")
                logger.info(f"Altitude: {location.get('altitude', 'N/A')} meters")
                logger.info(f"Satellites: {location.get('num_satellites', 'N/A')}")
                logger.info(f"HDOP: {location.get('hdop', 'N/A')}")
                logger.info(f"Timestamp: {location.get('timestamp', 'N/A')}")
                logger.info(f"Simulated: {location.get('simulated', 'Unknown')}")
                logger.info("-" * 50)
            else:
                logger.info("Waiting for GPS data... (Move the device to a window or outdoors for better signal)")
            
            time.sleep(1)
        
        if not data_received:
            logger.error("No GPS data received after 60 seconds")
            logger.error("Possible issues:")
            logger.error("1. GPS device needs to be outdoors to acquire satellite signal")
            logger.error("2. Incorrect port or baudrate")
            logger.error("3. GPS device not powered or connected properly")
            logger.error("4. Try a different baudrate (common values: 4800, 9600, 38400, 115200)")
    
    except KeyboardInterrupt:
        logger.info("Test interrupted by user")
    finally:
        # Stop the GPS module
        gps.stop()
        logger.info("GPS module stopped")

if __name__ == "__main__":
    main()
