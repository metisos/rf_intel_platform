// Global variables
let ws = null;
let spectrumChart = null;
let showWhitelistedOnly = false;
let deviceModal = null;
let currentDevices = [];
let map = null;
let deviceMarkers = {};
let geofenceCircle = null;
let geofenceEnabled = false;
let userMarker = null;
let userLocation = { lat: 37.7749, lng: -122.4194 }; // Default location (San Francisco)
let mapInitialized = false;
let usingGPS = false; // Flag to indicate if we're using GPS data from the server

// Device status tracking
const deviceStatus = {
    active: {},    // Currently detected devices
    inactive: {}   // Previously detected devices that are no longer active
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM Content Loaded - Initializing application");
    
    // Initialize map first to ensure it's available
    initializeMap();
    
    // Initialize other components
    initializeWebSocket();
    initializeChart();
    initializeModal();
    
    // Get user's browser location as fallback
    getUserLocation();
    
    // Set up event listeners
    document.getElementById('toggleGeofenceBtn').addEventListener('click', toggleGeofence);
    document.getElementById('setGeofenceBtn').addEventListener('click', setGeofence);
    document.getElementById('toggleWhitelistBtn').addEventListener('click', toggleWhitelistView);
    document.getElementById('addWhitelistBtn').addEventListener('click', addToWhitelist);
    document.getElementById('removeWhitelistBtn').addEventListener('click', removeFromWhitelist);
    
    // Initialize the whitelist toggle button text
    const toggleBtn = document.getElementById('toggleWhitelistBtn');
    if (toggleBtn) {
        toggleBtn.textContent = showWhitelistedOnly ? 'Show All Devices' : 'Show Whitelisted Only';
        toggleBtn.classList.toggle('btn-success', showWhitelistedOnly);
        toggleBtn.classList.toggle('btn-outline-success', !showWhitelistedOnly);
    }
    
    // Initialize the whitelist status element
    const whitelistStatus = document.getElementById('whitelistStatus');
    if (whitelistStatus) {
        whitelistStatus.innerHTML = 'WHITELIST: <span class="badge">Loading...</span>';
    }
    
    // Initialize the whitelist filter status
    const filterStatus = document.getElementById('whitelistFilterStatus');
    if (filterStatus) {
        filterStatus.textContent = showWhitelistedOnly ? 'Showing Whitelisted Only' : 'Showing All';
        filterStatus.className = showWhitelistedOnly ? 'badge bg-warning ms-2' : 'badge bg-success ms-2';
    }
    
    // Fetch initial device data
    fetch('/api/devices')
        .then(response => response.json())
        .then(data => {
            // Process device data to ensure all required properties exist
            if (data.devices && Array.isArray(data.devices)) {
                data.devices.forEach(device => {
                    // Make sure frequency_mhz property exists or create it from frequency
                    if (!device.frequency_mhz && device.frequency) {
                        device.frequency_mhz = device.frequency;
                    }
                });
            }
            
            currentDevices = data.devices || [];
            updateDeviceList(currentDevices);
            updateWhitelistCount();
            updateDeviceStatusCount();
        })
        .catch(error => {
            console.error('Error fetching initial device data:', error);
        });
});

// Initialize WebSocket connection
function initializeWebSocket() {
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        console.log(`Connecting to WebSocket at ${wsUrl}`);
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('WebSocket connection established');
            document.getElementById('status').textContent = 'Status: Connected';
            document.getElementById('status').classList.add('connected');
            document.getElementById('status').classList.remove('disconnected');
        };
        
        ws.onclose = (event) => {
            console.log(`WebSocket closed with code: ${event.code}, reason: ${event.reason}`);
            document.getElementById('status').textContent = 'Status: Disconnected';
            document.getElementById('status').classList.remove('connected');
            document.getElementById('status').classList.add('disconnected');
            // Try to reconnect after 5 seconds
            setTimeout(initializeWebSocket, 5000);
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log("Received data:", data);
                
                // Store current devices
                currentDevices = data.devices || [];
                
                // Process device data to ensure all required properties exist
                if (currentDevices && Array.isArray(currentDevices)) {
                    currentDevices.forEach(device => {
                        // Make sure frequency_mhz property exists or create it from frequency
                        if (!device.frequency_mhz && device.frequency) {
                            device.frequency_mhz = device.frequency;
                        }
                    });
                }
                
                // Track active and inactive devices
                const now = new Date();
                const activeDeviceIds = new Set();
                
                // First, mark all devices as inactive
                for (const deviceId in deviceStatus.active) {
                    deviceStatus.inactive[deviceId] = deviceStatus.active[deviceId];
                    delete deviceStatus.active[deviceId];
                }
                
                // Then update with current data
                currentDevices.forEach(device => {
                    const deviceId = device.id;
                    const lastSeen = new Date(device.last_seen);
                    const timeDiff = now - lastSeen; // Time difference in milliseconds
                    
                    // Consider a device active if it was seen in the last 30 seconds
                    if (timeDiff < 30000) {
                        deviceStatus.active[deviceId] = device;
                        if (deviceStatus.inactive[deviceId]) {
                            delete deviceStatus.inactive[deviceId];
                        }
                        activeDeviceIds.add(deviceId);
                    } else {
                        deviceStatus.inactive[deviceId] = device;
                    }
                });
                
                // Add visual indicators for active/inactive status
                currentDevices.forEach(device => {
                    device.isActive = activeDeviceIds.has(device.id);
                });
                
                // Update UI components
                updateDeviceList(currentDevices);
                updateSpectrum(data);
                updateWhitelistCount();
                updateDeviceStatusCount();
                
                // Update map markers if map is initialized
                if (mapInitialized && map) {
                    updateMarkers(currentDevices);
                }
                
                // Check if we have monitoring station location
                if (data.monitoring_station) {
                    const gpsLocation = {
                        lat: data.monitoring_station.latitude,
                        lng: data.monitoring_station.longitude
                    };
                    
                    console.log("Monitoring station location received:", data.monitoring_station);
                    
                    // Update user location with GPS data
                    userLocation = gpsLocation;
                    usingGPS = true;
                    
                    // Update status to show we're using GPS
                    const statusElement = document.getElementById('status');
                    if (statusElement) {
                        // Check if this is real GPS data or simulated
                        const isSimulated = data.monitoring_station.simulated === true;
                        const numSatellites = data.monitoring_station.num_satellites || 0;
                        const hdop = parseFloat(data.monitoring_station.hdop) || 0;
                        
                        // Create a more detailed status message
                        let statusText = isSimulated ? 
                            'Status: Connected (Simulated GPS)' : 
                            `Status: Connected (Real GPS - Satellites: ${numSatellites}, HDOP: ${hdop.toFixed(1)})`;
                        
                        statusElement.textContent = statusText;
                        
                        // Add a class to indicate simulated vs real
                        if (isSimulated) {
                            statusElement.classList.add('simulated');
                            statusElement.classList.remove('real-gps');
                        } else {
                            statusElement.classList.add('real-gps');
                            statusElement.classList.remove('simulated');
                        }
                    }
                    
                    // Update user marker with GPS data
                    if (map && userMarker) {
                        userMarker.setLatLng([userLocation.lat, userLocation.lng]);
                        
                        // Update the popup content with GPS details
                        const popupContent = createMonitoringStationPopup(data.monitoring_station);
                        userMarker.setPopupContent(popupContent);
                        
                        // Only center map on GPS location if it's the first time or significant change
                        if (!mapInitialized || getDistance(userMarker.getLatLng(), [userLocation.lat, userLocation.lng]) > 100) {
                            map.setView([userLocation.lat, userLocation.lng], 13);
                        }
                    } else if (!mapInitialized) {
                        // Initialize map with the location data
                        initializeMap(data.devices || []);
                    }
                }
                
                // Initialize map after we get the first data if not already initialized
                if (!mapInitialized && data.devices && data.devices.length > 0) {
                    initializeMap(data.devices);
                }
                
                // Update device markers on the map
                if (data.devices && data.devices.length > 0) {
                    updateMarkers(data.devices);
                }
                
                // Store the latest data for reference
                window.latestData = data;
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
            }
        };
    } catch (error) {
        console.error('Error initializing WebSocket:', error);
    }
}

// Process incoming device data
function processDeviceData(data) {
    if (!data.devices) return;
    
    // Process device data to ensure all required properties exist
    if (data.devices && Array.isArray(data.devices)) {
        data.devices.forEach(device => {
            // Make sure frequency_mhz property exists or create it from frequency
            if (!device.frequency_mhz && device.frequency) {
                device.frequency_mhz = device.frequency;
            }
        });
    }
    
    // Process each device
    data.devices.forEach(device => {
        // Set device status (active/inactive)
        const now = new Date();
        const lastSeen = new Date(device.last_seen);
        const diffSeconds = Math.floor((now - lastSeen) / 1000);
        
        // Consider device active if seen in the last 30 seconds
        device.isActive = diffSeconds <= 30;
        
        // Update device status tracking
        if (device.isActive) {
            deviceStatus.active[device.id] = device;
            delete deviceStatus.inactive[device.id];
        } else {
            deviceStatus.inactive[device.id] = device;
            delete deviceStatus.active[device.id];
        }
        
        // Check if device is inside geofence
        if (geofenceCircle && map) {
            const deviceLatLng = L.latLng(
                device.location.latitude || device.location.lat,
                device.location.longitude || device.location.lng
            );
            
            const geofenceLatLng = geofenceCircle.getLatLng();
            const distance = deviceLatLng.distanceTo(geofenceLatLng);
            device.insideGeofence = distance <= geofenceCircle.getRadius();
            
            // Update marker appearance
            updateMarkerForDevice(device);
        }
    });
    
    // Update current devices list
    currentDevices = data.devices;
    
    // Update UI
    updateDeviceList(currentDevices);
    updateSpectrum(data);
    updateWhitelistCount();
    updateDeviceStatusCount();
    
    // Update map if initialized
    if (mapInitialized) {
        updateMarkers(currentDevices);
    }
}

// Calculate distance between two points in meters
function getDistance(point1, point2) {
    if (!map) return 0;
    return map.distance(point1, point2);
}

// Get user's current location from browser (as fallback)
function getUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function(position) {
                // Only use browser location if we're not using GPS
                if (!usingGPS) {
                    userLocation = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    };
                    
                    console.log("Browser location detected:", userLocation);
                    
                    // If map is already initialized, update the user marker
                    if (map && userMarker) {
                        userMarker.setLatLng([userLocation.lat, userLocation.lng]);
                        map.setView([userLocation.lat, userLocation.lng], 13);
                    } else if (!mapInitialized) {
                        // Initialize map with browser location if we haven't received device data yet
                        initializeMap();
                    }
                }
            },
            function(error) {
                console.error("Error getting browser location:", error);
            }
        );
    } else {
        console.log("Geolocation is not supported by this browser");
    }
}

// Initialize the spectrum chart
function initializeChart() {
    const ctx = document.getElementById('spectrumChart').getContext('2d');
    spectrumChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'RF Spectrum',
                data: [],
                borderColor: 'rgb(75, 192, 192)',
                tension: 0.1,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Frequency (MHz)'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Power (dB)'
                    }
                }
            },
            animation: false
        }
    });
}

// Initialize Leaflet map
function initializeMap(devices) {
    console.log("Initializing map...");
    
    // Wait for DOM to be fully loaded
    setTimeout(() => {
        const mapContainer = document.getElementById('map');
        
        if (!mapContainer) {
            console.error("Map container not found");
            return;
        }
        
        console.log("Map container found, dimensions:", mapContainer.offsetWidth, "x", mapContainer.offsetHeight);
        
        try {
            // Force any existing map to be removed
            if (map) {
                map.remove();
                console.log("Removed existing map instance");
            }
            
            // Force map container to be visible
            mapContainer.style.height = "800px";
            mapContainer.style.width = "100%";
            mapContainer.style.display = "block";
            mapContainer.style.visibility = "visible";
            mapContainer.style.position = "relative";
            mapContainer.style.zIndex = "1";
            
            // Initialize the map with the user's location
            map = L.map('map', {
                zoomControl: true,
                attributionControl: true,
                maxZoom: 19,
                minZoom: 3
            }).setView([userLocation.lat, userLocation.lng], 13);
            
            console.log("Map object created:", map);
            
            // Define multiple base map layers
            const baseLayers = {
                'Street': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                    maxZoom: 19
                }),
                
                'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
                    maxZoom: 19
                }),
                
                'Terrain': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
                    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
                    maxZoom: 17
                }),
                
                'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                    subdomains: 'abcd',
                    maxZoom: 19
                })
            };
            
            // Add the dark layer by default to match the black background theme
            baseLayers['Dark'].addTo(map);
            
            // Create layer controls and add to map
            L.control.layers(baseLayers, {}, {
                position: 'topright',
                collapsed: false
            }).addTo(map);
            
            console.log("Tile layer added to map");
            
            // Add user marker at location
            userMarker = L.marker([userLocation.lat, userLocation.lng], {
                icon: L.divIcon({
                    className: 'user-marker',
                    html: '<div class="user-marker-icon"></div>',
                    iconSize: [20, 20]
                })
            }).addTo(map);
            
            console.log("User marker added to map");
            
            // Add a popup with detailed GPS information
            if (window.latestData && window.latestData.monitoring_station) {
                const popupContent = createMonitoringStationPopup(window.latestData.monitoring_station);
                userMarker.bindPopup(popupContent).openPopup();
            } else {
                // Fallback if we don't have the latest data
                const locationSource = usingGPS ? "GPS" : "Browser";
                userMarker.bindPopup(`Monitoring Station (${locationSource})`).openPopup();
            }
            
            // Listen for map clicks to set geofence
            map.on('click', function(e) {
                if (window.settingGeofence) {
                    setGeofenceAtPosition(e.latlng);
                    window.settingGeofence = false;
                }
            });
            
            // Force a map resize to ensure it renders properly
            map.invalidateSize(true);
            
            mapInitialized = true;
            console.log("Map initialized successfully with center:", userLocation);
            
            // Update markers for all devices if provided
            if (devices && devices.length > 0) {
                updateMarkers(devices);
            }
            
            // Add a resize handler to ensure map stays visible when window is resized
            window.addEventListener('resize', function() {
                if (map) {
                    console.log("Window resized, invalidating map size");
                    map.invalidateSize(true);
                }
            });
        } catch (error) {
            console.error("Error initializing map:", error);
        }
    }, 500); // Increased timeout to ensure DOM is ready
}

// Set geofence at the clicked position
function setGeofenceAtPosition(latlng) {
    // Remove existing geofence
    if (geofenceCircle) {
        map.removeLayer(geofenceCircle);
    }
    
    // Create new geofence (500m radius)
    geofenceCircle = L.circle(latlng, {
        color: 'red',
        fillColor: '#f03',
        fillOpacity: 0.2,
        radius: 500
    }).addTo(map);
    
    geofenceEnabled = true;
    
    // Check existing devices against new geofence
    checkDevicesAgainstGeofence();
}

// Toggle geofence visibility
function toggleGeofence() {
    if (!geofenceCircle) return;
    
    geofenceEnabled = !geofenceEnabled;
    
    if (geofenceEnabled) {
        map.addLayer(geofenceCircle);
    } else {
        map.removeLayer(geofenceCircle);
    }
    
    // Update device status
    checkDevicesAgainstGeofence();
}

// Enable geofence creation mode
function setGeofence() {
    window.settingGeofence = true;
    alert("Click on the map to place a geofence");
}

// Check if devices are inside the geofence
function checkDevicesAgainstGeofence() {
    if (!geofenceCircle || !geofenceEnabled) return;
    
    const geofenceCenter = geofenceCircle.getLatLng();
    const geofenceRadius = geofenceCircle.getRadius();
    
    currentDevices.forEach(device => {
        if (device.location) {
            // Convert location format if needed
            let deviceLat = device.location.lat;
            let deviceLng = device.location.lng;
            
            if (device.location.latitude !== undefined) {
                deviceLat = device.location.latitude;
                deviceLng = device.location.longitude;
            }
            
            const deviceLatLng = L.latLng(deviceLat, deviceLng);
            const distance = deviceLatLng.distanceTo(geofenceCenter);
            device.insideGeofence = distance <= geofenceRadius;
            
            // Update marker appearance
            updateMarkerForDevice(device);
        }
    });
    
    // Update device list display
    updateDeviceList(currentDevices);
}

// Update markers on the map
function updateMarkers(devices) {
    if (!map || !mapInitialized) {
        console.warn("Map not initialized yet, can't update markers");
        return;
    }
    
    console.log("Updating map markers for", devices.length, "devices");
    
    // Keep track of device locations for map centering
    let validLocations = [];
    
    devices.forEach(device => {
        // If device doesn't have location, skip it
        if (!device.location) {
            console.warn("Device missing location:", device.id);
            return;
        }
        
        // Convert location format if needed
        let deviceLat, deviceLng;
        
        if (device.location.latitude !== undefined && device.location.longitude !== undefined) {
            deviceLat = device.location.latitude;
            deviceLng = device.location.longitude;
            device.location = {
                lat: deviceLat,
                lng: deviceLng
            };
        } else if (device.location.lat !== undefined && device.location.lng !== undefined) {
            deviceLat = device.location.lat;
            deviceLng = device.location.lng;
        } else {
            console.warn("Invalid location format for device:", device.id, device.location);
            return;
        }
        
        // Validate coordinates
        if (isNaN(deviceLat) || isNaN(deviceLng) || 
            deviceLat < -90 || deviceLat > 90 || 
            deviceLng < -180 || deviceLng > 180) {
            console.warn("Invalid coordinates for device:", device.id, deviceLat, deviceLng);
            return;
        }
        
        // Add to valid locations for map centering
        validLocations.push([deviceLat, deviceLng]);
        
        // Check if device is inside geofence
        if (geofenceCircle && geofenceEnabled) {
            const geofenceCenter = geofenceCircle.getLatLng();
            const geofenceRadius = geofenceCircle.getRadius();
            const deviceLatLng = L.latLng(deviceLat, deviceLng);
            device.insideGeofence = deviceLatLng.distanceTo(geofenceCenter) <= geofenceRadius;
        }
        
        // Update or create marker
        updateMarkerForDevice(device);
    });
    
    console.log("Valid device locations:", validLocations.length);
    
    // Clean up markers for devices that no longer exist
    Object.keys(deviceMarkers).forEach(id => {
        if (!devices.find(d => d.id === id)) {
            map.removeLayer(deviceMarkers[id]);
            delete deviceMarkers[id];
        }
    });
}

// Update or create marker for a device
function updateMarkerForDevice(device) {
    try {
        // Skip if device has no location
        if (!device.location) return;
        
        // Get coordinates
        let lat, lng;
        if (device.location.latitude !== undefined && device.location.longitude !== undefined) {
            lat = device.location.latitude;
            lng = device.location.longitude;
        } else if (device.location.lat !== undefined && device.location.lng !== undefined) {
            lat = device.location.lat;
            lng = device.location.lng;
        } else {
            console.warn("Invalid location format for device:", device.id);
            return;
        }
        
        // Determine marker color based on whitelist status, activity status, and geofence
        let markerColor = 'blue';
        let markerOpacity = 1.0;
        
        if (device.whitelisted) {
            markerColor = 'green';
        } else if (device.insideGeofence) {
            markerColor = 'red';
        }
        
        // Reduce opacity for inactive devices
        if (!device.isActive) {
            markerOpacity = 0.5;
        }
        
        // Create marker icon with enhanced visibility for dark backgrounds
        const signalStrength = getSignalStrength(device.power);
        const markerIcon = L.divIcon({
            className: `device-marker signal-${signalStrength}`,
            html: `<div class="device-marker-icon ${markerColor}" style="opacity: ${markerOpacity}; border: 2px solid white; box-shadow: 0 0 5px rgba(255, 255, 255, 0.5);"></div>`,
            iconSize: [24, 24]
        });
        
        // Create or update marker
        if (device.id in deviceMarkers) {
            // Update existing marker
            deviceMarkers[device.id].setLatLng([lat, lng]);
            deviceMarkers[device.id].setIcon(markerIcon);
            
            // Create device details HTML with expanded cell phone information
            const detailsHTML = `
                <div class="device-details">
                    <div class="device-detail"><strong>Phone Type:</strong> ${device.subtype || device.type || 'Cell Phone'}</div>
                    <div class="device-detail"><strong>Manufacturer:</strong> ${device.manufacturer || 'Unknown'}</div>
                    <div class="device-detail"><strong>Technology:</strong> ${device.tech || 'Cellular'}</div>
                    <div class="device-detail"><strong>Frequency:</strong> ${device.frequency_mhz ? `${device.frequency_mhz.toFixed(2)} MHz` : device.frequency ? `${device.frequency.toFixed(2)} MHz` : 'Unknown'}</div>
                    <div class="device-detail"><strong>Signal Strength:</strong> ${device.power ? device.power.toFixed(1) + ' dB' : 'Unknown'}</div>
                    ${device.band ? `<div class="device-detail"><strong>Band:</strong> ${device.band}</div>` : ''}
                    ${device.link_type ? `<div class="device-detail"><strong>Link Type:</strong> ${device.link_type}</div>` : ''}
                    ${device.simulated_id ? `<div class="device-detail"><strong>Phone ID:</strong> ${device.simulated_id}</div>` : ''}
                    <div class="device-detail"><strong>First Seen:</strong> ${new Date(device.first_seen).toLocaleString()}</div>
                    <div class="device-detail"><strong>Last Seen:</strong> ${new Date(device.last_seen).toLocaleString()}</div>
                    <div class="device-detail"><strong>Status:</strong> 
                        <span class="badge ${device.isActive ? 'bg-success' : 'bg-secondary'}">                
                            ${device.isActive ? 'Active' : 'Inactive'}
                        </span>
                    </div>
                    <div class="device-detail"><strong>Whitelisted:</strong> 
                        <span class="badge ${device.whitelisted ? 'bg-success' : 'bg-danger'}">                
                            ${device.whitelisted ? 'Yes' : 'No'}
                        </span>
                    </div>
                    ${device.confidence ? `<div class="device-detail"><strong>Detection Confidence:</strong> ${(device.confidence * 100).toFixed(0)}%</div>` : ''}
                </div>
            `;
            
            // Update popup content
            const popupContent = `
                <strong>${device.name || `Device at ${(device.frequency_mhz ? device.frequency_mhz.toFixed(2) : device.frequency ? device.frequency.toFixed(2) : '0.00')} MHz`}</strong><br>
                Type: ${device.type || 'Unknown'}<br>
                Frequency: ${device.frequency_mhz ? `${device.frequency_mhz.toFixed(2)} MHz` : device.frequency ? `${device.frequency.toFixed(2)} MHz` : 'Unknown'}<br>
                Signal: ${device.power ? device.power.toFixed(1) + ' dB' : 'Unknown'}<br>
                ${device.whitelisted ? '<span class="text-success">Whitelisted</span><br>' : ''}
                ${device.isActive ? '<span class="text-primary">Active</span>' : '<span class="text-secondary">Inactive</span>'}
            `;
            deviceMarkers[device.id].getPopup().setContent(detailsHTML + popupContent);
        } else {
            // Create new marker
            const marker = L.marker([lat, lng], {
                icon: markerIcon
            });
            
            // Create device details HTML with expanded cell phone information
            const detailsHTML = `
                <div class="device-details">
                    <div class="device-detail"><strong>Phone Type:</strong> ${device.subtype || device.type || 'Cell Phone'}</div>
                    <div class="device-detail"><strong>Manufacturer:</strong> ${device.manufacturer || 'Unknown'}</div>
                    <div class="device-detail"><strong>Technology:</strong> ${device.tech || 'Cellular'}</div>
                    <div class="device-detail"><strong>Frequency:</strong> ${device.frequency_mhz ? `${device.frequency_mhz.toFixed(2)} MHz` : device.frequency ? `${device.frequency.toFixed(2)} MHz` : 'Unknown'}</div>
                    <div class="device-detail"><strong>Signal Strength:</strong> ${device.power ? device.power.toFixed(1) + ' dB' : 'Unknown'}</div>
                    ${device.band ? `<div class="device-detail"><strong>Band:</strong> ${device.band}</div>` : ''}
                    ${device.link_type ? `<div class="device-detail"><strong>Link Type:</strong> ${device.link_type}</div>` : ''}
                    ${device.simulated_id ? `<div class="device-detail"><strong>Phone ID:</strong> ${device.simulated_id}</div>` : ''}
                    <div class="device-detail"><strong>First Seen:</strong> ${new Date(device.first_seen).toLocaleString()}</div>
                    <div class="device-detail"><strong>Last Seen:</strong> ${new Date(device.last_seen).toLocaleString()}</div>
                    <div class="device-detail"><strong>Status:</strong> 
                        <span class="badge ${device.isActive ? 'bg-success' : 'bg-secondary'}">                
                            ${device.isActive ? 'Active' : 'Inactive'}
                        </span>
                    </div>
                    <div class="device-detail"><strong>Whitelisted:</strong> 
                        <span class="badge ${device.whitelisted ? 'bg-success' : 'bg-danger'}">                
                            ${device.whitelisted ? 'Yes' : 'No'}
                        </span>
                    </div>
                    ${device.confidence ? `<div class="device-detail"><strong>Detection Confidence:</strong> ${(device.confidence * 100).toFixed(0)}%</div>` : ''}
                </div>
            `;
            
            // Add popup
            const popupContent = `
                <strong>${device.name || `Device at ${(device.frequency_mhz ? device.frequency_mhz.toFixed(2) : device.frequency ? device.frequency.toFixed(2) : '0.00')} MHz`}</strong><br>
                Type: ${device.type || 'Unknown'}<br>
                Frequency: ${device.frequency_mhz ? `${device.frequency_mhz.toFixed(2)} MHz` : device.frequency ? `${device.frequency.toFixed(2)} MHz` : 'Unknown'}<br>
                Signal: ${device.power ? device.power.toFixed(1) + ' dB' : 'Unknown'}<br>
                ${device.whitelisted ? '<span class="text-success">Whitelisted</span><br>' : ''}
                ${device.isActive ? '<span class="text-primary">Active</span>' : '<span class="text-secondary">Inactive</span>'}
            `;
            marker.bindPopup(detailsHTML + popupContent);
            
            // Add click event to show device details
            marker.on('click', function() {
                showDeviceDetails(device);
            });
            
            // Add to map and store in deviceMarkers
            marker.addTo(map);
            deviceMarkers[device.id] = marker;
        }
    } catch (error) {
        console.error("Error updating marker for device:", error, device);
    }
}

// Initialize Bootstrap modal
function initializeModal() {
    deviceModal = new bootstrap.Modal(document.getElementById('deviceModal'));
}

// Update the device list
function updateDeviceList(devices) {
    currentDevices = devices;
    const deviceList = document.getElementById('deviceList');
    deviceList.innerHTML = '';
    
    devices
        .filter(device => !showWhitelistedOnly || device.whitelisted)
        .forEach(device => {
            const deviceElement = document.createElement('a');
            deviceElement.className = `list-group-item list-group-item-action d-flex justify-content-between align-items-center 
                ${device.whitelisted ? 'whitelisted' : ''} 
                ${device.insideGeofence === false ? 'geofence-alert' : ''}
                ${!device.isActive ? 'inactive-device' : ''}`;
            deviceElement.onclick = () => showDeviceDetails(device);
            
            const signalStrength = getSignalStrength(device.power);
            
            // Format last seen time
            let lastSeenText = '';
            if (device.last_seen) {
                const lastSeen = new Date(device.last_seen);
                const now = new Date();
                const diffSeconds = Math.floor((now - lastSeen) / 1000);
                
                if (diffSeconds < 60) {
                    lastSeenText = `${diffSeconds}s ago`;
                } else if (diffSeconds < 3600) {
                    lastSeenText = `${Math.floor(diffSeconds / 60)}m ago`;
                } else if (diffSeconds < 86400) {
                    lastSeenText = `${Math.floor(diffSeconds / 3600)}h ago`;
                } else {
                    lastSeenText = `${Math.floor(diffSeconds / 86400)}d ago`;
                }
            }
            
            deviceElement.innerHTML = `
                <div>
                    <div class="d-flex align-items-center">
                        <span class="signal-indicator ${signalStrength.class}"></span>
                        <strong>${device.name || `Device at ${(device.frequency_mhz ? device.frequency_mhz.toFixed(2) : device.frequency ? device.frequency.toFixed(2) : '0.00')} MHz`}</strong>
                        ${device.whitelisted ? '<span class="badge bg-success ms-2">Whitelisted</span>' : ''}
                        ${device.insideGeofence === false ? '<span class="badge bg-danger ms-2">Outside Geofence</span>' : ''}
                        ${!device.isActive ? '<span class="badge bg-secondary ms-2">Inactive</span>' : ''}
                    </div>
                    <div class="device-frequency">
                        <strong>${device.manufacturer || 'Unknown'} ${device.subtype || device.type || 'Cell Phone'}</strong> 
                        ${device.simulated_id ? `• ID: ${device.simulated_id}` : ''}
                        • Band: ${device.band || 'Unknown'}
                        • Last seen: ${lastSeenText}
                    </div>
                </div>
                <span class="badge bg-primary rounded-pill signal-strength">${device.power.toFixed(1)} dB</span>
            `;
            
            deviceList.appendChild(deviceElement);
        });
    
    // Show message if no devices
    if (devices.length === 0) {
        const noDevices = document.createElement('div');
        noDevices.className = 'text-center p-3 text-muted';
        noDevices.style.backgroundColor = 'var(--secondary-color)';
        noDevices.style.border = '1px solid var(--border-color)';
        noDevices.style.fontStyle = 'italic';
        noDevices.textContent = showWhitelistedOnly ? 'No whitelisted devices found' : 'No devices detected';
        deviceList.appendChild(noDevices);
    }
}

// Update the spectrum chart
function updateSpectrum(data) {
    if (!data.devices || !data.devices.length) return;
    
    const frequencies = data.devices.map(d => d.frequency_mhz ? d.frequency_mhz : d.frequency);
    const powers = data.devices.map(d => d.power);
    
    spectrumChart.data.labels = frequencies;
    spectrumChart.data.datasets[0].data = powers;
    spectrumChart.update();
}

// Show device details in modal
function showDeviceDetails(device) {
    // Show device details in modal
    const modal = new bootstrap.Modal(document.getElementById('deviceModal'));
    
    // Set device ID in hidden field
    document.getElementById('deviceId').value = device.id;
    
    // Set device name
    document.getElementById('deviceName').value = device.name || '';
    
    // Set device type
    const typeSelect = document.getElementById('deviceType');
    if (typeSelect) {
        // Find the option that matches the device type
        const options = Array.from(typeSelect.options);
        const matchingOption = options.find(option => option.value === device.type);
        
        if (matchingOption) {
            matchingOption.selected = true;
        } else {
            // If no matching option, select "Unknown"
            const unknownOption = options.find(option => option.value === 'Unknown');
            if (unknownOption) {
                unknownOption.selected = true;
            }
        }
    }
    
    // Set device frequency
    document.getElementById('deviceFreq').value = device.frequency_mhz ? device.frequency_mhz.toFixed(2) : (device.frequency ? (device.frequency / 1e6).toFixed(2) : '');
    
    // Set device IMSI/IMEI
    const imeiField = document.getElementById('deviceImsi');
    if (imeiField) {
        // Check if this is an extracted IMEI or simulated
        if (device.extracted_imei) {
            imeiField.value = `${device.imei} `;
            imeiField.classList.add('verified-imei');
            // Add tooltip
            imeiField.title = 'Verified IMEI extracted from device';
        } else {
            imeiField.value = device.imei || device.simulated_id || '';
            imeiField.classList.remove('verified-imei');
            imeiField.title = 'Estimated identifier';
        }
    }
    
    // Set device location
    if (device.location) {
        document.getElementById('deviceLat').value = device.location.latitude || device.location.lat || '';
        document.getElementById('deviceLng').value = device.location.longitude || device.location.lng || '';
    } else {
        document.getElementById('deviceLat').value = '';
        document.getElementById('deviceLng').value = '';
    }
    
    // Set first seen and last seen times
    if (device.first_seen) {
        const firstSeen = new Date(device.first_seen);
        document.getElementById('deviceFirstSeen').value = firstSeen.toLocaleString();
    } else {
        document.getElementById('deviceFirstSeen').value = '';
    }
    
    if (device.last_seen) {
        const lastSeen = new Date(device.last_seen);
        document.getElementById('deviceLastSeen').value = lastSeen.toLocaleString();
    } else {
        document.getElementById('deviceLastSeen').value = '';
    }
    
    // Set whitelisted status
    document.getElementById('deviceWhitelisted').checked = device.whitelisted || false;
    
    // Set active status
    document.getElementById('deviceActive').checked = device.isActive || false;
    
    // Show/hide whitelist buttons based on current status
    if (device.whitelisted) {
        document.getElementById('addWhitelistBtn').style.display = 'none';
        document.getElementById('removeWhitelistBtn').style.display = 'inline-block';
    } else {
        document.getElementById('addWhitelistBtn').style.display = 'inline-block';
        document.getElementById('removeWhitelistBtn').style.display = 'none';
    }
    
    // Show the modal
    modal.show();
}

function updateDeviceList(devices) {
    // Update the device list
    const deviceList = document.getElementById('deviceList');
    if (!deviceList) return;
    
    // Clear the list
    deviceList.innerHTML = '';
    
    // Filter devices based on whitelist setting
    const filteredDevices = showWhitelistedOnly 
        ? devices.filter(device => device.whitelisted) 
        : devices;
    
    // Sort devices: active first, then by signal strength
    filteredDevices.sort((a, b) => {
        // Active devices first
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        
        // Then by signal strength (higher power = stronger signal)
        return (b.power || -100) - (a.power || -100);
    });
    
    // Add devices to the list
    filteredDevices.forEach(device => {
        const deviceItem = document.createElement('a');
        deviceItem.href = '#';
        deviceItem.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
        deviceItem.dataset.id = device.id;
        
        // Add active/inactive class
        if (device.isActive) {
            deviceItem.classList.add('device-active');
        } else {
            deviceItem.classList.add('device-inactive');
        }
        
        // Add whitelisted class if applicable
        if (device.whitelisted) {
            deviceItem.classList.add('device-whitelisted');
        }
        
        // Format frequency
        const freq = device.frequency_mhz ? device.frequency_mhz.toFixed(2) : (device.frequency ? (device.frequency / 1e6).toFixed(2) : 'Unknown');
        
        // Get signal strength class
        const signalStrength = getSignalStrength(device.power || -100);
        
        // Format device type
        const deviceType = formatDeviceType(device);
        
        // Format device ID (IMEI/IMSI)
        const deviceId = formatDeviceId(device);
        
        // Create main content div
        const contentDiv = document.createElement('div');
        contentDiv.className = 'device-info';
        
        // Add device name or type as main heading
        const nameHeading = document.createElement('h6');
        nameHeading.className = 'mb-0';
        nameHeading.textContent = device.name || deviceType;
        contentDiv.appendChild(nameHeading);
        
        // Add frequency info
        const freqInfo = document.createElement('small');
        freqInfo.className = 'text-muted';
        freqInfo.textContent = `${freq} MHz`;
        contentDiv.appendChild(freqInfo);
        
        // Add IMEI/ID info with verification badge if applicable
        const idInfo = document.createElement('small');
        idInfo.className = 'device-id';
        
        // Check if this is an extracted IMEI
        if (device.extracted_imei) {
            idInfo.innerHTML = `<span class="verified-id">${deviceId}</span>`;
            idInfo.title = 'Verified IMEI extracted from device';
        } else {
            idInfo.textContent = deviceId;
            idInfo.title = 'Estimated identifier';
        }
        
        contentDiv.appendChild(idInfo);
        
        // Add content div to item
        deviceItem.appendChild(contentDiv);
        
        // Add signal strength indicator
        const signalIndicator = document.createElement('span');
        signalIndicator.className = `signal-indicator ${signalStrength.class}`;
        signalIndicator.title = `Signal: ${signalStrength.text} (${device.power ? device.power.toFixed(1) : 'Unknown'} dB)`;
        deviceItem.appendChild(signalIndicator);
        
        // Add click handler
        deviceItem.addEventListener('click', function(e) {
            e.preventDefault();
            showDeviceDetails(device);
        });
        
        // Add to list
        deviceList.appendChild(deviceItem);
    });
    
    // Show message if no devices
    if (filteredDevices.length === 0) {
        const noDevices = document.createElement('div');
        noDevices.className = 'text-center p-3 text-muted';
        noDevices.style.backgroundColor = 'var(--secondary-color)';
        noDevices.style.border = '1px solid var(--border-color)';
        noDevices.style.fontStyle = 'italic';
        noDevices.textContent = showWhitelistedOnly ? 'No whitelisted devices found' : 'No devices detected';
        deviceList.appendChild(noDevices);
    }
}

// Update whitelist count in the header
function updateWhitelistCount() {
    console.log("Updating whitelist count");
    
    // Count whitelisted devices
    const whitelistedDevices = currentDevices.filter(device => device.whitelisted);
    console.log(`Found ${whitelistedDevices.length} whitelisted devices`);
    
    // Update the counter in the header
    const whitelistStatus = document.getElementById('whitelistStatus');
    if (whitelistStatus) {
        const badgeClass = whitelistedDevices.length > 0 ? 'bg-success' : 'bg-secondary';
        const plural = whitelistedDevices.length !== 1 ? 's' : '';
        whitelistStatus.innerHTML = `WHITELIST: <span class="badge ${badgeClass}">${whitelistedDevices.length} device${plural}</span>`;
        console.log("Updated whitelist status element");
    } else {
        console.error("Could not find whitelistStatus element");
    }
    
    // Also update the filter status badge
    const filterStatus = document.getElementById('whitelistFilterStatus');
    if (filterStatus) {
        if (showWhitelistedOnly) {
            filterStatus.textContent = 'Showing Whitelisted Only';
            filterStatus.className = 'badge bg-warning ms-2';
        } else {
            filterStatus.textContent = 'Showing All';
            filterStatus.className = 'badge bg-success ms-2';
        }
    }
}

// Update device status counter in the header
function updateDeviceStatusCount() {
    const activeCount = Object.keys(deviceStatus.active).length;
    const inactiveCount = Object.keys(deviceStatus.inactive).length;
    
    console.log(`Device status: ${activeCount} active, ${inactiveCount} inactive`);
    
    const deviceStatusElement = document.getElementById('deviceStatus');
    if (deviceStatusElement) {
        deviceStatusElement.innerHTML = `Devices: <span class="badge bg-primary">${activeCount} active</span> / <span class="badge bg-secondary">${inactiveCount} inactive</span>`;
    }
}

// Toggle between all devices and whitelisted only
function toggleWhitelistView() {
    showWhitelistedOnly = !showWhitelistedOnly;
    
    // Update the button text and badge
    const toggleBtn = document.getElementById('toggleWhitelistBtn');
    const statusBadge = document.getElementById('whitelistFilterStatus');
    
    if (showWhitelistedOnly) {
        toggleBtn.textContent = 'Show All Devices';
        toggleBtn.classList.remove('btn-outline-success');
        toggleBtn.classList.add('btn-success');
        statusBadge.textContent = 'Showing Whitelisted Only';
        statusBadge.classList.remove('bg-success');
        statusBadge.classList.add('bg-warning');
    } else {
        toggleBtn.textContent = 'Show Whitelisted Only';
        toggleBtn.classList.remove('btn-success');
        toggleBtn.classList.add('btn-outline-success');
        statusBadge.textContent = 'Showing All';
        statusBadge.classList.remove('bg-warning');
        statusBadge.classList.add('bg-success');
    }
    
    // Update the device list
    updateDeviceList(currentDevices);
}

// Helper function to determine signal strength
function getSignalStrength(power) {
    if (power > -30) {
        return { class: 'signal-excellent', text: 'Excellent' };
    } else if (power > -50) {
        return { class: 'signal-good', text: 'Good' };
    } else if (power > -70) {
        return { class: 'signal-medium', text: 'Medium' };
    } else if (power > -90) {
        return { class: 'signal-weak', text: 'Weak' };
    } else {
        return { class: 'signal-poor', text: 'Poor' };
    }
}

// Format device type for display
function formatDeviceType(device) {
    // Check if device has a subtype
    if (device.subtype) {
        return device.subtype;
    }
    
    // Fall back to type
    if (device.type) {
        // Capitalize first letter
        return device.type.charAt(0).toUpperCase() + device.type.slice(1);
    }
    
    // Default
    return 'Unknown Device';
}

// Format device ID based on type (IMEI for phones, Network ID for equipment)
function formatDeviceId(device) {
    // Check if we have an IMEI or simulated_id
    if (device.imei) {
        return device.imei;
    }
    
    if (device.simulated_id) {
        return device.simulated_id;
    }
    
    // Fall back to device ID
    return device.id ? device.id.substring(0, 8) : 'Unknown';
}

// Helper function to create a detailed popup for the monitoring station
function createMonitoringStationPopup(stationData) {
    if (!stationData) return "Monitoring Station";
    
    const isSimulated = stationData.simulated === true;
    const sourceText = isSimulated ? "Simulated GPS" : "Real GPS";
    const satellites = stationData.num_satellites || 0;
    const hdop = parseFloat(stationData.hdop) || 0;
    const altitude = parseFloat(stationData.altitude) || 0;
    
    let popupContent = `<div class="station-popup">
        <h4>Monitoring Station</h4>
        <p><strong>Source:</strong> ${sourceText}</p>
        <p><strong>Coordinates:</strong> ${stationData.latitude.toFixed(6)}, ${stationData.longitude.toFixed(6)}</p>`;
    
    if (!isSimulated) {
        popupContent += `
        <p><strong>Satellites:</strong> ${satellites}</p>
        <p><strong>HDOP:</strong> ${hdop.toFixed(1)}</p>
        <p><strong>Altitude:</strong> ${altitude.toFixed(1)} m</p>`;
    }
    
    popupContent += `</div>`;
    
    return popupContent;
}

function showDeviceDetails(device) {
    // Show device details in modal
    const modal = new bootstrap.Modal(document.getElementById('deviceModal'));
    
    // Set device ID in hidden field
    document.getElementById('deviceId').value = device.id;
    
    // Set device name
    document.getElementById('deviceName').value = device.name || '';
    
    // Set device type
    const typeSelect = document.getElementById('deviceType');
    if (typeSelect) {
        // Find the option that matches the device type
        const options = Array.from(typeSelect.options);
        const matchingOption = options.find(option => option.value === device.type);
        
        if (matchingOption) {
            matchingOption.selected = true;
        } else {
            // If no matching option, select "Unknown"
            const unknownOption = options.find(option => option.value === 'Unknown');
            if (unknownOption) {
                unknownOption.selected = true;
            }
        }
    }
    
    // Set device frequency
    document.getElementById('deviceFreq').value = device.frequency_mhz ? device.frequency_mhz.toFixed(2) : (device.frequency ? (device.frequency / 1e6).toFixed(2) : '');
    
    // Set device IMSI/IMEI
    const imeiField = document.getElementById('deviceImsi');
    if (imeiField) {
        // Check if this is an extracted IMEI or simulated
        if (device.extracted_imei) {
            imeiField.value = `${device.imei} `;
            imeiField.classList.add('verified-imei');
            // Add tooltip
            imeiField.title = 'Verified IMEI extracted from device';
        } else {
            imeiField.value = device.imei || device.simulated_id || '';
            imeiField.classList.remove('verified-imei');
            imeiField.title = 'Estimated identifier';
        }
    }
    
    // Set device location
    if (device.location) {
        document.getElementById('deviceLat').value = device.location.latitude || device.location.lat || '';
        document.getElementById('deviceLng').value = device.location.longitude || device.location.lng || '';
    } else {
        document.getElementById('deviceLat').value = '';
        document.getElementById('deviceLng').value = '';
    }
    
    // Set first seen and last seen times
    if (device.first_seen) {
        const firstSeen = new Date(device.first_seen);
        document.getElementById('deviceFirstSeen').value = firstSeen.toLocaleString();
    } else {
        document.getElementById('deviceFirstSeen').value = '';
    }
    
    if (device.last_seen) {
        const lastSeen = new Date(device.last_seen);
        document.getElementById('deviceLastSeen').value = lastSeen.toLocaleString();
    } else {
        document.getElementById('deviceLastSeen').value = '';
    }
    
    // Set whitelisted status
    document.getElementById('deviceWhitelisted').checked = device.whitelisted || false;
    
    // Set active status
    document.getElementById('deviceActive').checked = device.isActive || false;
    
    // Show/hide whitelist buttons based on current status
    if (device.whitelisted) {
        document.getElementById('addWhitelistBtn').style.display = 'none';
        document.getElementById('removeWhitelistBtn').style.display = 'inline-block';
    } else {
        document.getElementById('addWhitelistBtn').style.display = 'inline-block';
        document.getElementById('removeWhitelistBtn').style.display = 'none';
    }
    
    // Show the modal
    modal.show();
}

function updateDeviceList(devices) {
    // Update the device list
    const deviceList = document.getElementById('deviceList');
    if (!deviceList) return;
    
    // Clear the list
    deviceList.innerHTML = '';
    
    // Filter devices based on whitelist setting
    const filteredDevices = showWhitelistedOnly 
        ? devices.filter(device => device.whitelisted) 
        : devices;
    
    // Sort devices: active first, then by signal strength
    filteredDevices.sort((a, b) => {
        // Active devices first
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        
        // Then by signal strength (higher power = stronger signal)
        return (b.power || -100) - (a.power || -100);
    });
    
    // Add devices to the list
    filteredDevices.forEach(device => {
        const deviceItem = document.createElement('a');
        deviceItem.href = '#';
        deviceItem.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
        deviceItem.dataset.id = device.id;
        
        // Add active/inactive class
        if (device.isActive) {
            deviceItem.classList.add('device-active');
        } else {
            deviceItem.classList.add('device-inactive');
        }
        
        // Add whitelisted class if applicable
        if (device.whitelisted) {
            deviceItem.classList.add('device-whitelisted');
        }
        
        // Format frequency
        const freq = device.frequency_mhz ? device.frequency_mhz.toFixed(2) : (device.frequency ? (device.frequency / 1e6).toFixed(2) : 'Unknown');
        
        // Get signal strength class
        const signalClass = getSignalStrength(device.power || -100);
        
        // Format device type
        const deviceType = formatDeviceType(device);
        
        // Format device ID (IMEI/IMSI)
        const deviceId = formatDeviceId(device);
        
        // Create main content div
        const contentDiv = document.createElement('div');
        contentDiv.className = 'device-info';
        
        // Add device name or type as main heading
        const nameHeading = document.createElement('h6');
        nameHeading.className = 'mb-0';
        nameHeading.textContent = device.name || deviceType;
        contentDiv.appendChild(nameHeading);
        
        // Add frequency info
        const freqInfo = document.createElement('small');
        freqInfo.className = 'text-muted';
        freqInfo.textContent = `${freq} MHz`;
        contentDiv.appendChild(freqInfo);
        
        // Add IMEI/ID info with verification badge if applicable
        const idInfo = document.createElement('small');
        idInfo.className = 'device-id';
        
        // Check if this is an extracted IMEI
        if (device.extracted_imei) {
            idInfo.innerHTML = `<span class="verified-id">${deviceId} </span>`;
            idInfo.title = 'Verified IMEI extracted from device';
        } else {
            idInfo.textContent = deviceId;
            idInfo.title = 'Estimated identifier';
        }
        
        contentDiv.appendChild(idInfo);
        
        // Add content div to item
        deviceItem.appendChild(contentDiv);
        
        // Add signal strength indicator
        const signalIndicator = document.createElement('span');
        signalIndicator.className = `signal-indicator ${signalClass}`;
        signalIndicator.title = `Signal: ${signalClass.text} (${device.power ? device.power.toFixed(1) : 'Unknown'} dB)`;
        deviceItem.appendChild(signalIndicator);
        
        // Add click handler
        deviceItem.addEventListener('click', function(e) {
            e.preventDefault();
            showDeviceDetails(device);
        });
        
        // Add to list
        deviceList.appendChild(deviceItem);
    });
    
    // Show message if no devices
    if (filteredDevices.length === 0) {
        const noDevices = document.createElement('div');
        noDevices.className = 'text-center p-3 text-muted';
        noDevices.style.backgroundColor = 'var(--secondary-color)';
        noDevices.style.border = '1px solid var(--border-color)';
        noDevices.style.fontStyle = 'italic';
        noDevices.textContent = showWhitelistedOnly ? 'No whitelisted devices found' : 'No devices detected';
        deviceList.appendChild(noDevices);
    }
}

// Add device to whitelist
async function addToWhitelist() {
    const deviceIdElement = document.getElementById('deviceId');
    if (!deviceIdElement) {
        console.error("Device ID element not found");
        alert("Error: Could not find device ID element");
        return;
    }
    
    const deviceId = deviceIdElement.value;
    
    if (!deviceId) {
        console.error("No device ID found");
        return;
    }
    
    // Find the device in the currentDevices array
    const device = currentDevices.find(d => d.id === deviceId);
    
    if (!device) {
        console.error("Device not found in currentDevices array");
        alert("Error: Device not found in the current devices list");
        return;
    }
    
    try {
        console.log("Adding device to whitelist:", deviceId);
        
        const deviceNameElement = document.getElementById('deviceName');
        const deviceTypeElement = document.getElementById('deviceType');
        const deviceFreqElement = document.getElementById('deviceFreq');
        
        if (!deviceNameElement || !deviceTypeElement || !deviceFreqElement) {
            console.error("One or more device form elements not found");
            alert("Error: Could not find all required form elements");
            return;
        }
        
        const updatedDevice = {
            name: deviceNameElement.value,
            type: deviceTypeElement.value,
            frequency: parseFloat(deviceFreqElement.value),
            power: device.power || 0,
            first_seen: device.first_seen || new Date().toISOString(),
            last_seen: device.last_seen || new Date().toISOString()
        };
        
        console.log("Device data to send:", updatedDevice);
        
        const response = await fetch(`/api/whitelist/${deviceId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedDevice)
        });
        
        console.log("Response status:", response.status);
        
        if (response.ok) {
            const responseData = await response.json();
            console.log("Device added to whitelist successfully:", responseData);
            
            // Update the device in the current devices list
            const deviceIndex = currentDevices.findIndex(d => d.id === deviceId);
            if (deviceIndex !== -1) {
                currentDevices[deviceIndex].whitelisted = true;
                currentDevices[deviceIndex].name = updatedDevice.name;
                currentDevices[deviceIndex].type = updatedDevice.type;
            }
            
            // Close the modal first
            if (deviceModal) {
                deviceModal.hide();
            }
            
            // Update the device list and markers
            updateDeviceList(currentDevices);
            if (mapInitialized && map) {
                updateMarkers(currentDevices);
            }
            
            // Update whitelist count
            updateWhitelistCount();
        } else {
            let errorMessage = "Unknown error";
            try {
                const errorData = await response.json();
                errorMessage = errorData.detail || "Failed to add device to whitelist";
                console.error('Failed to add device to whitelist:', errorData);
            } catch (e) {
                console.error('Error parsing error response:', e);
            }
            alert('Failed to add device to whitelist: ' + errorMessage);
        }
    } catch (error) {
        console.error('Error adding to whitelist:', error);
        alert('Failed to add device to whitelist: ' + error.message);
    }
}

// Remove device from whitelist
async function removeFromWhitelist() {
    const deviceIdElement = document.getElementById('deviceId');
    if (!deviceIdElement) {
        console.error("Device ID element not found");
        alert("Error: Could not find device ID element");
        return;
    }
    
    const deviceId = deviceIdElement.value;
    
    if (!deviceId) {
        console.error("No device ID found");
        return;
    }
    
    try {
        console.log("Removing device from whitelist:", deviceId);
        
        const deviceNameElement = document.getElementById('deviceName');
        const deviceTypeElement = document.getElementById('deviceType');
        const deviceFreqElement = document.getElementById('deviceFreq');
        
        if (!deviceNameElement || !deviceTypeElement || !deviceFreqElement) {
            console.error("One or more device form elements not found");
            alert("Error: Could not find all required form elements");
            return;
        }
        
        const response = await fetch(`/api/whitelist/${deviceId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log("Response status:", response.status);
        
        if (response.ok) {
            const responseData = await response.json();
            console.log("Device removed from whitelist successfully:", responseData);
            
            // Update the device in the current devices list
            const deviceIndex = currentDevices.findIndex(d => d.id === deviceId);
            if (deviceIndex !== -1) {
                currentDevices[deviceIndex].whitelisted = false;
            }
            
            // Update the device list and markers
            updateDeviceList(currentDevices);
            if (mapInitialized && map) {
                updateMarkers(currentDevices);
            }
            
            // Update whitelist count
            updateWhitelistCount();
            
            // Close the modal
            if (deviceModal) {
                deviceModal.hide();
            }
            
            // Show success message
            alert("Device removed from whitelist successfully");
        } else {
            let errorMessage = "Unknown error";
            try {
                const errorData = await response.json();
                errorMessage = errorData.detail || "Failed to remove device from whitelist";
                console.error('Failed to remove device from whitelist:', errorData);
            } catch (e) {
                console.error('Error parsing error response:', e);
            }
            alert('Failed to remove device from whitelist: ' + errorMessage);
        }
    } catch (error) {
        console.error('Error removing from whitelist:', error);
        alert('Failed to remove device from whitelist: ' + error.message);
    }
}
