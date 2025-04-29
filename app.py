#!/usr/bin/env python3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
import uvicorn
import asyncio
import json
import os
import logging
import shutil
from datetime import datetime, timedelta
import random
import uuid
import time
import traceback
import numpy as np
from rf_monitor import RFMonitor
from json_utils import CustomJSONEncoder
import math
import gps_module
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from rf_monitor import RFMonitor
import os
from gps_module import GPSModule

# Initialize logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rf_monitor_app")

# Initialize the RF monitor
rf_monitor = RFMonitor()

# Initialize GPS module - update the port to match your GPS device
# Common ports: 'COM3' on Windows, '/dev/ttyUSB0' or '/dev/ttyACM0' on Linux
GPS_PORT = os.environ.get('GPS_PORT', 'COM9')  # Default to COM5, override with environment variable

# Default monitoring location (used when GPS is not available)
DEFAULT_MONITORING_LOCATION = {
    'latitude': 39.8283,  # Approximate center of US
    'longitude': -98.5795  # Approximate center of US
}

# Initialize last save time for periodic saving
last_save_time = datetime.now()

# Try to initialize the GPS module with the real device first
gps_module = GPSModule(port=GPS_PORT, simulation_mode=False, force_real=False)
gps_connected = False

# Try to start the GPS module
try:
    gps_module.start()
    logger.info(f"GPS module started on port {GPS_PORT}")
    
    # Check if GPS is actually connected
    time.sleep(3)  # Give it a moment to connect (increased to 3 seconds)
    if gps_module.is_connected():
        gps_connected = True
        if gps_module.is_using_real_gps():
            logger.info("Real GPS device successfully connected and providing data")
        else:
            logger.info("Using GPS simulation mode")
    else:
        logger.warning("GPS device not providing data yet, will continue trying in background")
except Exception as e:
    logger.error(f"Failed to start GPS module: {e}")
    logger.info("Switching to GPS simulation mode")
    gps_module = GPSModule(port=GPS_PORT, simulation_mode=True)
    gps_module.start()

# Custom JSON encoder function for FastAPI
def numpy_encoder(obj):
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj

# Create FastAPI app with custom JSON encoder
app = FastAPI()

# Configure FastAPI JSON response encoding
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder

# Override the default JSONResponse class to use our custom encoder
class CustomJSONResponse(JSONResponse):
    def render(self, content):
        return super().render(jsonable_encoder(content, custom_encoder={np.floating: float, np.integer: int}))

# Replace the default JSONResponse with our custom one
app.router.default_response_class = CustomJSONResponse

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Device model for API
class Device(BaseModel):
    name: str
    type: Optional[str] = None
    frequency: float
    power: float
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    location: Optional[Dict] = None
    simulated_id: Optional[str] = None

# Store for whitelisted devices
whitelist = {}

# File to store whitelist
WHITELIST_FILE = "whitelist.json"

# Store for all detected devices
devices_db = {}
DEVICES_DB_FILE = "devices_db.json"

# Device expiry time (in seconds)
DEVICE_EXPIRY_TIME = 3600  # 1 hour

# Time of last cleanup
last_cleanup_time = datetime.now()

def load_whitelist():
    global whitelist
    try:
        if os.path.exists(WHITELIST_FILE):
            with open(WHITELIST_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    whitelist = data
                    logger.info(f"Loaded whitelist from {WHITELIST_FILE} with {len(whitelist)} devices")
                else:
                    logger.error(f"Invalid whitelist format in {WHITELIST_FILE}")
                    whitelist = {}
        else:
            # Create a new whitelist file if it doesn't exist
            whitelist = {}
            save_whitelist()
            logger.info(f"Created new whitelist file at {WHITELIST_FILE}")
            
        # Create a backup of the whitelist after loading
        if whitelist and not os.path.exists(f"{WHITELIST_FILE}.bak"):
            try:
                with open(f"{WHITELIST_FILE}.bak", "w") as f:
                    json.dump(whitelist, f, indent=2, cls=CustomJSONEncoder)
                logger.info(f"Created backup of whitelist with {len(whitelist)} devices")
            except Exception as e:
                logger.error(f"Failed to create whitelist backup: {e}")
                
    except Exception as e:
        logger.error(f"Error loading whitelist: {e}")
        whitelist = {}
        
        # Try to restore from backup if main file is corrupted
        if os.path.exists(f"{WHITELIST_FILE}.bak"):
            try:
                with open(f"{WHITELIST_FILE}.bak", "r") as f:
                    backup_data = json.load(f)
                    if isinstance(backup_data, dict):
                        whitelist = backup_data
                        logger.info(f"Restored whitelist from backup with {len(whitelist)} devices")
                        # Save the restored whitelist to the main file
                        save_whitelist()
            except Exception as e2:
                logger.error(f"Failed to restore whitelist from backup: {e2}")

def verify_whitelist():
    global whitelist
    try:
        # Check if whitelist is empty but should have data
        if not whitelist and os.path.exists(WHITELIST_FILE):
            logger.warning("Whitelist is empty but file exists, attempting to reload")
            load_whitelist()
        
        # Check for backup if whitelist is still empty
        if not whitelist and os.path.exists(f"{WHITELIST_FILE}.bak"):
            logger.warning("Attempting to restore whitelist from backup")
            try:
                with open(f"{WHITELIST_FILE}.bak", "r") as f:
                    backup_data = json.load(f)
                    if isinstance(backup_data, dict) and backup_data:
                        whitelist = backup_data
                        logger.info(f"Restored whitelist from backup with {len(whitelist)} devices")
                        # Save the restored whitelist
                        save_whitelist()
            except Exception as e:
                logger.error(f"Failed to restore whitelist from backup: {e}")
        
        # Log whitelist status
        logger.info(f"Whitelist verification complete: {len(whitelist)} devices in whitelist")
    except Exception as e:
        logger.error(f"Error verifying whitelist: {e}")

def save_whitelist():
    try:
        # First write to a temporary file
        temp_file = f"{WHITELIST_FILE}.tmp"
        with open(temp_file, "w") as f:
            json.dump(whitelist, f, indent=2, cls=CustomJSONEncoder)
        
        # Then rename the temporary file to the actual file
        # This helps prevent data corruption if the program crashes during writing
        if os.path.exists(temp_file):
            if os.path.exists(WHITELIST_FILE):
                os.replace(temp_file, WHITELIST_FILE)
            else:
                os.rename(temp_file, WHITELIST_FILE)
            
            logger.info(f"Saved whitelist to {WHITELIST_FILE} with {len(whitelist)} devices")
        else:
            logger.error(f"Failed to save whitelist: temporary file not created")
    except Exception as e:
        logger.error(f"Error saving whitelist: {e}")
        # Try a direct save as a fallback
        try:
            with open(WHITELIST_FILE, "w") as f:
                json.dump(whitelist, f, cls=CustomJSONEncoder)
            logger.info(f"Saved whitelist directly to {WHITELIST_FILE} with {len(whitelist)} devices")
        except Exception as e2:
            logger.error(f"Error in fallback whitelist save: {e2}")

def load_devices_db():
    global devices_db
    try:
        if os.path.exists(DEVICES_DB_FILE):
            with open(DEVICES_DB_FILE, "r") as f:
                devices_db = json.load(f)
                logger.info(f"Loaded devices database from {DEVICES_DB_FILE} with {len(devices_db)} devices")
        else:
            devices_db = {}
            logger.info("No devices database file found, starting with empty database")
    except Exception as e:
        logger.error(f"Error loading devices database: {e}")
        devices_db = {}

def save_devices_db():
    try:
        with open(DEVICES_DB_FILE, "w") as f:
            json.dump(devices_db, f, cls=CustomJSONEncoder)
            logger.info(f"Saved devices database to {DEVICES_DB_FILE} with {len(devices_db)} devices")
    except Exception as e:
        logger.error(f"Error saving devices database: {e}")

def cleanup_expired_devices():
    global devices_db, last_cleanup_time
    
    # Only run cleanup every minute to avoid excessive processing
    if (datetime.now() - last_cleanup_time).total_seconds() < 60:
        return
    
    current_time = datetime.now()
    expired_devices = []
    
    for device_id, device in devices_db.items():
        last_seen = datetime.fromisoformat(device['last_seen'])
        if (current_time - last_seen).total_seconds() > DEVICE_EXPIRY_TIME:
            expired_devices.append(device_id)
    
    for device_id in expired_devices:
        del devices_db[device_id]
    
    if expired_devices:
        logger.info(f"Removed {len(expired_devices)} expired devices")
        save_devices_db()
    
    last_cleanup_time = current_time

def update_device_db(device):
    """Update the devices database with a new or updated device"""
    global devices_db
    global last_save_time
    
    try:
        device_id = device.get('id')
        if not device_id:
            return
        
        # Check if this is a new device or an update
        is_new = device_id not in devices_db
        
        if is_new:
            # New device - add to database with current timestamp
            now = datetime.now().isoformat()
            device['first_seen'] = now
            device['last_seen'] = now
            
            # Check if this device has an extracted IMEI
            if device.get('extracted_imei', False):
                logger.info(f"New device with extracted IMEI: {device.get('imei')}")
            
            # Add to database
            devices_db[device_id] = device
            logger.info(f"Added new device {device_id} to database")
        else:
            # Existing device - update last_seen and any changed properties
            existing = devices_db[device_id]
            existing['last_seen'] = datetime.now().isoformat()
            
            # Update power if provided
            if 'power' in device:
                existing['power'] = device['power']
            
            # Update frequency if provided
            if 'frequency' in device:
                existing['frequency'] = device['frequency']
            
            # Update extracted IMEI if available
            if device.get('extracted_imei', False):
                existing['imei'] = device.get('imei')
                existing['extracted_imei'] = True
                if 'all_imeis' in device:
                    existing['all_imeis'] = device.get('all_imeis')
                logger.info(f"Updated device {device_id} with extracted IMEI: {device.get('imei')}")
            
            # Update location if provided
            if 'location' in device and device['location']:
                existing['location'] = device['location']
            
            # Update type if provided
            if 'type' in device:
                existing['type'] = device['type']
            
            # Update subtype if provided
            if 'subtype' in device:
                existing['subtype'] = device['subtype']
            
            # Update manufacturer if provided
            if 'manufacturer' in device:
                existing['manufacturer'] = device['manufacturer']
            
            logger.debug(f"Updated device {device_id} in database")
        
        # Save the updated database periodically
        # Don't save on every update to avoid excessive disk I/O
        now = datetime.now()
        if (now - last_save_time).total_seconds() > 60:  # Save every minute
            save_devices_db()
            last_save_time = now
            
    except Exception as e:
        logger.error(f"Error updating device database: {e}")
        traceback.print_exc()

# Helper function to estimate device location based on signal strength
def estimate_location_from_signal(monitoring_location, signal_power, frequency_mhz, device_id=None):
    """
    Estimate device location based on signal strength using a simplified radio propagation model.
    
    Args:
        monitoring_location: Dict with latitude and longitude of the monitoring station
        signal_power: Signal power in dB
        frequency_mhz: Signal frequency in MHz
        device_id: Optional device ID to ensure consistent direction for the same device
        
    Returns:
        Dict with estimated latitude and longitude
    """
    try:
        # Normalize power to a reasonable range (-100 dB to 0 dB)
        # Weaker signals (more negative dB) are further away
        normalized_power = min(max(signal_power, -100), 0)
        
        # Convert to a distance estimate using a simplified path loss model
        # Reduce the impact of frequency to make locations more stable during frequency hopping
        # Use a much smaller frequency factor (0.1 power instead of 0.5 from sqrt)
        frequency_factor = math.pow(frequency_mhz / 900, 0.1)  # Very mild frequency adjustment
        
        # Calculate estimated distance in degrees (roughly 111km per degree at equator)
        # This is a simplified model: stronger signals = closer, weaker = further
        # Use a smaller random variation (±10% instead of ±20%) for more stability
        if device_id:  # For known devices, use even less variation for stability
            distance_variation = random.uniform(0.95, 1.05)  # Only ±5% for known devices
        else:
            distance_variation = random.uniform(0.9, 1.1)  # ±10% for unknown devices
            
        base_distance = (abs(normalized_power) / 100) * 0.03 * frequency_factor * distance_variation
        
        # Determine direction based on device_id if provided, otherwise use random direction
        if device_id:
            # Use hash of device_id to get a consistent angle
            import hashlib
            
            # Create a more stable hash that's consistent for the same device
            # Only use the first part of the device ID to ensure stability across frequency changes
            stable_id = str(device_id).split('-')[0] if '-' in str(device_id) else str(device_id)
            
            # Get a hash value and convert to an angle (0-360 degrees)
            hash_val = int(hashlib.md5(stable_id.encode()).hexdigest(), 16)
            
            # Use a much smaller angle variation (±5 degrees instead of ±30) for more stability
            # This keeps the device in roughly the same direction even when frequency hopping
            base_angle = (hash_val % 360) * (math.pi / 180)  # Convert to radians
            angle_variation = random.uniform(-5, 5) * (math.pi / 180)  # ±5 degrees in radians
            direction = (base_angle + angle_variation) % (2 * math.pi)
        else:
            # Random direction if no device_id provided
            direction = random.uniform(0, 2 * math.pi)
        
        # Add minimal randomness to prevent signals with similar power from clumping
        # But keep it much smaller for stability during frequency hopping
        # Stronger signals have less variability (more accurate positioning)
        power_factor = abs(normalized_power) / 100  # 0 to 1 scale (0 = strongest, 1 = weakest)
        
        # Reduce variability significantly for more stable positioning
        if device_id:  # Even less variability for known devices
            variability = 0.0005 + (power_factor * 0.002)  # Much smaller variation
        else:
            variability = 0.001 + (power_factor * 0.004)  # Still smaller than before
        
        # Apply smaller random offsets for more stability
        random_offset_lat = random.uniform(-variability, variability)
        random_offset_lng = random.uniform(-variability, variability)
        
        # Convert polar coordinates (distance, direction) to lat/lng offsets
        lat_offset = base_distance * math.cos(direction) + random_offset_lat
        lng_offset = base_distance * math.sin(direction) + random_offset_lng
        
        # Check if we should use a cached location for this device to maintain stability
        # This is a simple in-memory cache to keep device locations stable
        global _device_location_cache
        if not hasattr(estimate_location_from_signal, '_device_location_cache'):
            estimate_location_from_signal._device_location_cache = {}
            estimate_location_from_signal._cache_timestamp = {}
            
        # If we have a device ID and a recent cached location, blend with the new location
        current_time = time.time()
        cache_max_age = 30.0  # 30 seconds max age for cached locations
        
        if device_id and device_id in estimate_location_from_signal._device_location_cache:
            # Check if the cached location is recent enough
            if (current_time - estimate_location_from_signal._cache_timestamp.get(device_id, 0)) < cache_max_age:
                # Get cached location
                cached_loc = estimate_location_from_signal._device_location_cache[device_id]
                
                # Blend new and cached locations (80% cached, 20% new for stability)
                # Stronger signals get more weight for the new location
                # Weaker signals rely more on the cached location
                blend_factor = 0.2 * (1 - power_factor)  # 0.0 to 0.2 (more weight to new location for stronger signals)
                
                blended_lat = cached_loc["latitude"] * (1 - blend_factor) + (monitoring_location["latitude"] + lat_offset) * blend_factor
                blended_lng = cached_loc["longitude"] * (1 - blend_factor) + (monitoring_location["longitude"] + lng_offset) * blend_factor
                
                # Update the cache with the blended location
                estimate_location_from_signal._device_location_cache[device_id] = {
                    "latitude": blended_lat,
                    "longitude": blended_lng,
                    "estimated_distance_km": base_distance * 111,
                    "signal_strength_db": signal_power
                }
                estimate_location_from_signal._cache_timestamp[device_id] = current_time
                
                return estimate_location_from_signal._device_location_cache[device_id]
        
        # If no cached location or cache is too old, use the new calculated location
        new_location = {
            "latitude": monitoring_location["latitude"] + lat_offset,
            "longitude": monitoring_location["longitude"] + lng_offset,
            "estimated_distance_km": base_distance * 111,  # Rough conversion to km
            "signal_strength_db": signal_power
        }
        
        # Cache the new location if we have a device ID
        if device_id:
            estimate_location_from_signal._device_location_cache[device_id] = new_location
            estimate_location_from_signal._cache_timestamp[device_id] = current_time
            
            # Clean old cache entries
            for key in list(estimate_location_from_signal._cache_timestamp.keys()):
                if current_time - estimate_location_from_signal._cache_timestamp[key] > cache_max_age:
                    del estimate_location_from_signal._device_location_cache[key]
                    del estimate_location_from_signal._cache_timestamp[key]
        
        return new_location
    except Exception as e:
        logger.error(f"Error estimating location from signal: {e}")
        # Fall back to a small random offset if estimation fails
        lat_offset = (random.random() - 0.5) * 0.005
        lng_offset = (random.random() - 0.5) * 0.005
        return {
            "latitude": monitoring_location["latitude"] + lat_offset,
            "longitude": monitoring_location["longitude"] + lng_offset,
            "estimated": False
        }

# Helper function to get current GPS location
def get_current_gps_location():
    """Get the current GPS location from the GPS module"""
    try:
        if gps_module.is_connected():
            gps_data = gps_module.get_location()
            if gps_data:
                # Ensure all numeric values are converted to float
                try:
                    location = {
                        "latitude": float(gps_data['latitude']),
                        "longitude": float(gps_data['longitude']),
                        "altitude": float(gps_data.get('altitude', 0)),
                        "num_satellites": str(gps_data.get('num_satellites', 0)),
                        "hdop": float(gps_data.get('hdop', 0)),
                        "simulated": gps_data.get('simulated', not gps_module.is_using_real_gps())
                    }
                    return location
                except (ValueError, TypeError) as e:
                    logger.error(f"Error converting GPS data: {e}")
        
        # Fall back to default location if GPS is not available
        logger.warning("GPS data not available, using default location")
        return {
            "latitude": DEFAULT_MONITORING_LOCATION['latitude'],
            "longitude": DEFAULT_MONITORING_LOCATION['longitude'],
            "altitude": 0,
            "num_satellites": "0",
            "hdop": 99.9,  # High value indicates poor accuracy
            "simulated": True
        }
    except Exception as e:
        logger.error(f"Error getting GPS location: {e}")
        return DEFAULT_MONITORING_LOCATION

# Load whitelist and devices database on startup
load_whitelist()
verify_whitelist()
load_devices_db()

# WebSocket connections
connections = []

# Serve index.html
@app.get("/", response_class=HTMLResponse)
async def get():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/api/devices")
async def get_devices():
    try:
        # Run cleanup to remove expired devices
        cleanup_expired_devices()
        
        # Capture RF data
        samples = rf_monitor.capture_samples()
        if samples is not None:
            spectrum_data = rf_monitor.analyze_spectrum(samples)
            
            # Convert any NumPy types to Python native types to ensure JSON serialization works
            if spectrum_data and isinstance(spectrum_data, dict):
                for key, value in spectrum_data.items():
                    if isinstance(value, np.ndarray):
                        spectrum_data[key] = value.tolist()
                    elif isinstance(value, (np.integer, np.floating)):
                        spectrum_data[key] = numpy_encoder(value)
            
            # Process spectrum data to identify potential devices
            current_devices = []
            if spectrum_data and 'devices' in spectrum_data:
                # Get current GPS location for the monitoring station
                monitoring_station_location = get_current_gps_location()
                
                # First, create a mapping of device IDs to their whitelist status
                # This ensures we don't lose whitelist information during processing
                whitelisted_devices = {}
                for device_id, device_info in whitelist.items():
                    whitelisted_devices[device_id] = device_info
                
                # Use the devices directly from the spectrum_data
                for device in spectrum_data['devices']:
                    # Check if device is in whitelist and update accordingly
                    device_id = device['id']
                    
                    # Check if this device is in our whitelist
                    if device_id in whitelist:
                        # Update device with whitelist information
                        device['whitelisted'] = True
                        # Preserve important whitelist data like name and type
                        for key, value in whitelist[device_id].items():
                            if key not in ['last_seen']:  # Don't overwrite timestamp
                                device[key] = value
                    else:
                        device['whitelisted'] = False
                    
                    # Add current timestamp
                    device['last_seen'] = datetime.now().isoformat()
                    
                    # Add location information to the device (based on monitoring station)
                    if monitoring_station_location:
                        # Get signal power and frequency from the device
                        signal_power = device.get('power', -70)  # Default to -70dB if not available
                        frequency_mhz = device.get('frequency', 900) / 1e6  # Convert Hz to MHz
                        device_id = device.get('id', '')
                        
                        # Use signal strength to estimate location with device ID for consistent direction
                        estimated_location = estimate_location_from_signal(
                            monitoring_station_location, 
                            signal_power, 
                            frequency_mhz,
                            device_id
                        )
                        
                        # Add device ID as a seed for consistent direction if needed
                        device_id = device.get('id', '')
                        if device_id and 'direction_seed' not in device:
                            # Hash the device ID to get a consistent direction seed
                            import hashlib
                            direction_seed = int(hashlib.md5(device_id.encode()).hexdigest(), 16) % 360
                            device['direction_seed'] = direction_seed
                        
                        # Update the device location with the estimated location
                        device['location'] = estimated_location
                    else:
                        # If no GPS, use a default location
                        device['location'] = {
                            "latitude": 38.897957,  # Default to a location
                            "longitude": -77.036560
                        }
                    
                    # Add to current devices list
                    current_devices.append(device)
            
            # Update devices database with currently detected devices
            # Ensure we preserve whitelist status when updating the database
            for device in current_devices:
                device_id = device['id']
                # Make sure whitelist status is preserved
                if device_id in whitelist:
                    device['whitelisted'] = True
                update_device_db(device)
            
            # Get all devices from the database (includes current and previously seen devices)
            all_devices = list(devices_db.values())
            
            # Prepare response
            response = {
                "devices": all_devices,
                "spectrum": spectrum_data.get('spectrum', []) if spectrum_data else [],
                "monitoring_station": monitoring_station_location
            }
            
            return response
        else:
            return {"error": "Failed to capture RF samples"}
    except Exception as e:
        logger.error(f"Error in get_devices: {e}")
        return {"error": str(e)}

@app.post("/api/whitelist/{device_id}")
async def whitelist_device(device_id: str, device: Device):
    try:
        # Create or update the device in the whitelist
        whitelist[device_id] = {
            "name": device.name,
            "type": device.type,
            "frequency": device.frequency,
            "first_seen": device.first_seen or datetime.now().isoformat(),
            "last_seen": datetime.now().isoformat(),
            "whitelisted": True
        }
        
        # Save whitelist to file after adding a device
        save_whitelist()
        
        # Create a backup of the whitelist for additional safety
        try:
            with open(f"{WHITELIST_FILE}.bak", "w") as f:
                json.dump(whitelist, f, indent=2, cls=CustomJSONEncoder)
            logger.info(f"Created backup of whitelist with {len(whitelist)} devices")
        except Exception as e:
            logger.error(f"Failed to create whitelist backup: {e}")
        
        # Also update the device in the devices_db if it exists
        if device_id in devices_db:
            devices_db[device_id]["whitelisted"] = True
            devices_db[device_id]["name"] = device.name
            devices_db[device_id]["type"] = device.type
            # Update other important fields from the whitelist
            for key, value in whitelist[device_id].items():
                if key not in devices_db[device_id] or key in ['name', 'type', 'whitelisted']:
                    devices_db[device_id][key] = value
            save_devices_db()
        
        logger.info(f"Device {device_id} added to whitelist")
        return {"status": "success", "message": f"Device {device_id} added to whitelist"}
    except Exception as e:
        logger.error(f"Error adding device {device_id} to whitelist: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to add device to whitelist: {str(e)}")

@app.delete("/api/whitelist/{device_id}")
async def remove_from_whitelist(device_id: str):
    try:
        if device_id in whitelist:
            # Remove from whitelist
            del whitelist[device_id]
            
            # Save whitelist to file after removing a device
            save_whitelist()
            
            # Update the device in devices_db if it exists
            if device_id in devices_db:
                devices_db[device_id]["whitelisted"] = False
                save_devices_db()
            
            logger.info(f"Device {device_id} removed from whitelist")
            return {"status": "success", "message": f"Device {device_id} removed from whitelist"}
        else:
            logger.warning(f"Attempt to remove non-existent device {device_id} from whitelist")
            raise HTTPException(status_code=404, detail=f"Device {device_id} not found in whitelist")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing device {device_id} from whitelist: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to remove device from whitelist: {str(e)}")

@app.get("/api/whitelist")
async def get_whitelist():
    try:
        # Ensure whitelist is loaded
        if not whitelist and os.path.exists(WHITELIST_FILE):
            load_whitelist()
        return {"whitelist": whitelist}
    except Exception as e:
        logger.error(f"Error retrieving whitelist: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve whitelist: {str(e)}")

@app.get("/api/monitoring_station")
async def get_monitoring_station():
    """Get the current location of the monitoring station"""
    try:
        # Get current GPS location
        location = get_current_gps_location()
        
        # Add additional information about the GPS module
        return {
            "location": location,
            "using_real_gps": gps_module.is_using_real_gps(),
            "is_connected": gps_module.is_connected(),
            "num_satellites": location.get("num_satellites", "0"),
            "hdop": location.get("hdop", 99.9),
            "simulated": location.get("simulated", True)
        }
    except Exception as e:
        logger.error(f"Error getting monitoring station location: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    if websocket not in connections:
        connections.append(websocket)
    logger.info(f"WebSocket client connected. Total connections: {len(connections)}")

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in connections:
            connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Remaining connections: {len(connections)}")


# Global cache for spectrum data to reduce processing overhead
_last_spectrum_data = None
_last_spectrum_time = 0
_spectrum_update_interval = 0.5  # Update spectrum data every 0.5 seconds instead of every loop
_device_update_counter = 0
_max_device_count = 50  # Maximum devices to process in a single update

async def broadcast_data():
    """Broadcast RF data to all connected WebSocket clients with optimized performance"""
    global _last_spectrum_data, _last_spectrum_time, _device_update_counter
    
    # Get monitoring station location once at startup to reduce GPS queries
    monitoring_station_location = get_current_gps_location()
    last_location_update = time.time()
    location_update_interval = 5.0  # Only update GPS location every 5 seconds
    
    while True:
        current_time = time.time()
        
        # Skip processing completely if no clients are connected
        if not connections:
            await asyncio.sleep(0.5)  # Wait a bit longer when no clients
            continue
        
        try:
            # Update GPS location periodically instead of every time
            if current_time - last_location_update > location_update_interval:
                monitoring_station_location = get_current_gps_location()
                last_location_update = current_time
            
            # Run cleanup less frequently (once every 60 seconds)
            if int(current_time) % 60 == 0:
                cleanup_expired_devices()
                
            # Capture RF data only if needed based on timing
            update_spectrum = (current_time - _last_spectrum_time) >= _spectrum_update_interval
            
            if update_spectrum:
                # Capture new RF data
                samples = rf_monitor.capture_samples()  # Using optimized method with caching
                if samples is not None:
                    _last_spectrum_data = rf_monitor.analyze_spectrum(samples)
                    _last_spectrum_time = current_time
                    
            # Process spectrum data only if we have valid data
            current_devices = []
            if _last_spectrum_data and 'devices' in _last_spectrum_data:
                # Process a subset of devices each time to distribute load
                devices_to_process = _last_spectrum_data['devices']
                start_idx = _device_update_counter % max(1, len(devices_to_process))
                
                # Process at most _max_device_count devices per update
                subset_devices = devices_to_process[start_idx:start_idx + _max_device_count]
                if start_idx + _max_device_count > len(devices_to_process):
                    # Wrap around to the beginning
                    remaining = start_idx + _max_device_count - len(devices_to_process)
                    subset_devices.extend(devices_to_process[:remaining])
                
                _device_update_counter += _max_device_count
                
                # Use the devices directly from the spectrum_data
                for device in subset_devices:
                    # Skip devices with low power to reduce processing
                    if 'power' in device and device['power'] < -70:  # Skip weak signals
                        continue
                        
                    # Check if device is in whitelist and update accordingly
                    device_id = device['id']
                    device['whitelisted'] = device_id in whitelist
                    if device_id in whitelist:
                        device.update(whitelist[device_id])
                    
                    # Add current timestamp
                    device['last_seen'] = datetime.now().isoformat()
                    
                    # Add location information to the device (based on monitoring station)
                    if monitoring_station_location:
                        # Get signal power and frequency from the device
                        signal_power = device.get('power', -70)  # Default to -70dB if not available
                        frequency_mhz = device.get('frequency', 900) / 1e6  # Convert Hz to MHz
                        device_id = device.get('id', '')
                        
                        # Use signal strength to estimate location with device ID for consistent direction
                        estimated_location = estimate_location_from_signal(
                            monitoring_station_location, 
                            signal_power, 
                            frequency_mhz,
                            device_id
                        )
                        
                        # Add device ID as a seed for consistent direction if needed
                        device_id = device.get('id', '')
                        if device_id and 'direction_seed' not in device:
                            # Hash the device ID to get a consistent direction seed
                            import hashlib
                            direction_seed = int(hashlib.md5(device_id.encode()).hexdigest(), 16) % 360
                            device['direction_seed'] = direction_seed
                        
                        # Update the device location with the estimated location
                        device['location'] = estimated_location
                        device['location']['using_gps'] = not monitoring_station_location.get('simulated', True)
                    else:
                        device['location'] = DEFAULT_MONITORING_LOCATION
                    
                    # Add to current devices list
                    current_devices.append(device)
                
                # Update devices database - but batch updates
                if current_devices:
                    # Only update a subset of devices in DB to reduce load
                    for device in current_devices[:min(10, len(current_devices))]:
                        update_device_db(device)
            
            # Prepare data to broadcast - only include necessary data
            # Limit the number of devices sent to improve performance
            max_devices_to_send = 30  # Limit number of devices sent to client
            
            # Sort devices by last_seen timestamp to send most recent ones
            all_devices = sorted(
                list(devices_db.values()),
                key=lambda d: d.get('last_seen', ''),
                reverse=True
            )[:max_devices_to_send]
            
            # Only send spectrum data if it was updated
            spectrum_data = []
            if update_spectrum and _last_spectrum_data:
                spectrum_data = _last_spectrum_data.get('spectrum', [])
                # Downsample spectrum data to reduce payload size
                if len(spectrum_data) > 1000:  # If we have a lot of spectrum points
                    step = len(spectrum_data) // 500  # Keep around 500 points
                    spectrum_data = spectrum_data[::step]
            
            data = {
                "devices": all_devices,
                "spectrum": spectrum_data,
                "monitoring_station": monitoring_station_location
            }
            
            # Broadcast to all connected clients
            if connections:
                # Serialize JSON data once instead of for each connection
                json_data = json.dumps(data, cls=CustomJSONEncoder)
                
                # Broadcast to all connected clients
                for connection in connections.copy():  # Use a copy to avoid modification during iteration
                    try:
                        await connection.send_text(json_data)
                    except Exception as e:
                        # Remove failed connection
                        logger.error(f"Error sending data to WebSocket client: {e}")
                        if connection in connections:
                            connections.remove(connection)
                            
        except Exception as e:
            logger.error(f"Error in broadcast_data: {e}")
            import traceback
            logger.error(traceback.format_exc())
        
        # Adaptive sleep - use shorter intervals when there are active connections
        sleep_time = 0.2 if len(connections) > 0 else 0.5
        await asyncio.sleep(sleep_time)

async def periodic_save():
    """Periodically save whitelist and devices database to ensure data persistence"""
    while True:
        try:
            # Save whitelist and devices_db every 5 minutes
            save_whitelist()
            save_devices_db()
            logger.info("Periodic save of whitelist and devices database completed")
        except Exception as e:
            logger.error(f"Error in periodic save: {e}")
        
        # Wait for 5 minutes
        await asyncio.sleep(300)

@app.on_event("startup")
async def startup_event():
    # Load and verify whitelist
    load_whitelist()
    verify_whitelist()
    
    # Start the broadcast task
    asyncio.create_task(broadcast_data())
    # Start the periodic save task
    asyncio.create_task(periodic_save())

@app.on_event("shutdown")
async def shutdown_event():
    # Stop the GPS module when the app shuts down
    if gps_module:
        gps_module.stop()
        logger.info("GPS module stopped during shutdown")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
