import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, FeatureGroup, useMap, CircleMarker } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import axios from 'axios';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import L from 'leaflet';

// Fix for default marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
});

// Component to handle map events
const MapEvents = ({ setMap }) => {
    const map = useMap();
    useEffect(() => {
        setMap(map);
    }, [map, setMap]);
    return null;
};

const MapController = () => {
    const [map, setMap] = useState(null);
    const [startPoint, setStartPoint] = useState(null);
    const [endPoint, setEndPoint] = useState(null);
    const [hazardZones, setHazardZones] = useState([]);
    const [route, setRoute] = useState(null);
    const [isRouteSafe, setIsRouteSafe] = useState(true);
    const [progressRoute, setProgressRoute] = useState(null);
    const [unsafeProgressRoute, setUnsafeProgressRoute] = useState(null);
    const [statusMessage, setStatusMessage] = useState('');
    const mapCenter = [51.505, -0.09];

    // WebSocket connection for real-time progress
    useEffect(() => {
        const ws = new WebSocket('ws://localhost:3000');

        ws.onopen = () => {
            console.log('WebSocket connected');
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'progress') {
                setProgressRoute(data.path);
            } else if (data.type === 'progress-unsafe') {
                setUnsafeProgressRoute(data.path);
            } else if (data.type === 'status') {
                setStatusMessage(data.message);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
        };

        // Clean up the connection when the component unmounts
        return () => {
            ws.close();
        };
    }, []); // Empty dependency array ensures this runs only once

    const calculateRoute = async () => {
        // Clear previous routes and status
        setRoute(null);
        setIsRouteSafe(true);
        setProgressRoute(null);
        setUnsafeProgressRoute(null);
        setStatusMessage('Starting route calculation...');

        try {
            // Validate start and end points
            if (!startPoint?.lat || !startPoint?.lng || !endPoint?.lat || !endPoint?.lng) {
                setStatusMessage('Please set a start and end point.');
                return;
            }

            // Format coordinates
            const start = {
                lat: Number(startPoint.lat),
                lng: Number(startPoint.lng)
            };
            const end = {
                lat: Number(endPoint.lat),
                lng: Number(endPoint.lng)
            };

            if (isNaN(start.lat) || isNaN(start.lng) || isNaN(end.lat) || isNaN(end.lng)) {
                setStatusMessage('Error: Invalid coordinates.');
                return;
            }

            console.log('Requesting route from backend...', { start, end, hazardZones });

            // Always use the backend for routing
            const backendResponse = await axios.post('http://localhost:3000/api/v1/route', {
                start,
                end,
                hazards: hazardZones,
            });

            // Clear progress routes once final response is received
            setProgressRoute(null);
            setUnsafeProgressRoute(null);

            if (backendResponse.data?.path) {
                setRoute(backendResponse.data.path);
                setIsRouteSafe(backendResponse.data.isSafe);

                if (!backendResponse.data.isSafe) {
                    setStatusMessage('Warning: Route crosses a hazard zone!');
                } else {
                    // Message is already "Route Found!" from server, clear it after a delay
                    setTimeout(() => setStatusMessage(''), 4000);
                }
            } else {
                setRoute(null);
                setStatusMessage('Could not find a route.');
            }
        } catch (error) {
            console.error('Error calculating route:', error);
            setRoute(null);
            setProgressRoute(null);
            setUnsafeProgressRoute(null);
            setStatusMessage('Error: Could not connect to the routing server.');
        }
    };

    useEffect(() => {
        calculateRoute();
    }, [startPoint, endPoint, hazardZones]);

    const handleMarkerDragEnd = (setter) => (e) => {
        const { lat, lng } = e.target.getLatLng();
        setter({ lat, lng });
    };

    const handleDrawCreated = (e) => {
        const { layerType, layer } = e;
        if (layerType === 'polygon') {
            const coordinates = layer.getLatLngs()[0].map(latLng => ({
                lat: latLng.lat,
                lng: latLng.lng
            }));
            setHazardZones([...hazardZones, coordinates]);
        }
    };

    const handleDrawEdited = (e) => {
        const layers = e.layers;
        const updatedHazards = [];
        layers.eachLayer((layer) => {
            const coordinates = layer.getLatLngs()[0].map(latLng => ({
                lat: latLng.lat,
                lng: latLng.lng
            }));
            updatedHazards.push(coordinates);
        });
        setHazardZones(updatedHazards);
    };

    const handleDrawDeleted = () => {
        setHazardZones([]);
    };

    return (
        <MapContainer
            center={mapCenter}
            zoom={13}
            style={{ height: "100vh", width: "100%" }}
        >
            <MapEvents setMap={setMap} />
            <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />

            {startPoint && (
                <Marker
                    position={[startPoint.lat, startPoint.lng]}
                    draggable={true}
                    eventHandlers={{
                        dragend: handleMarkerDragEnd(setStartPoint)
                    }}
                />
            )}

            {endPoint && (
                <Marker
                    position={[endPoint.lat, endPoint.lng]}
                    draggable={true}
                    eventHandlers={{
                        dragend: handleMarkerDragEnd(setEndPoint)
                    }}
                />
            )}

            <FeatureGroup>
                <EditControl
                    position="topright"
                    onCreated={handleDrawCreated}
                    onEdited={handleDrawEdited}
                    onDeleted={handleDrawDeleted}
                    draw={{
                        rectangle: false,
                        circle: false,
                        circlemarker: false,
                        marker: false,
                        polyline: false
                    }}
                />
            </FeatureGroup>

            {/* Real-time progress route */}
            {progressRoute && (
                <Polyline
                    positions={progressRoute}
                    pathOptions={{
                        color: 'gray',
                        weight: 5,
                        opacity: 0.7,
                        dashArray: '10, 10'
                    }}
                />
            )}
            {/* Real-time unsafe progress route */}
            {unsafeProgressRoute && (
                <Polyline
                    positions={unsafeProgressRoute}
                    pathOptions={{
                        color: '#ff8c00', // Dark Orange
                        weight: 5,
                        opacity: 0.8,
                        dashArray: '10, 10'
                    }}
                />
            )}

            {map && route && Array.isArray(route) && route.length > 0 && (
                <>
                    {/* White outline for better visibility */}
                    <Polyline
                        positions={route}
                        pathOptions={{
                            color: "white",
                            weight: 9,
                            opacity: 0.8,
                            lineCap: 'round',
                            lineJoin: 'round'
                        }}
                    />
                    {/* Main route line */}
                    <Polyline
                        positions={route}
                        pathOptions={{
                            color: isRouteSafe ? "#3388ff" : "#ff0000", // Blue for safe, Red for unsafe
                            weight: 6,
                            opacity: 1,
                            lineCap: 'round',
                            lineJoin: 'round',
                            dashArray: null
                        }}
                    />
                    {/* Route endpoints for visibility */}
                    {route.length > 1 && (
                        <>
                            <CircleMarker
                                center={route[0]}
                                radius={5}
                                pathOptions={{
                                    color: isRouteSafe ? "#3388ff" : "#ff0000",
                                    fillColor: "white",
                                    fillOpacity: 1,
                                    weight: 2
                                }}
                            />
                            <CircleMarker
                                center={route[route.length - 1]}
                                radius={5}
                                pathOptions={{
                                    color: isRouteSafe ? "#3388ff" : "#ff0000",
                                    fillColor: "white",
                                    fillOpacity: 1,
                                    weight: 2
                                }}
                            />
                        </>
                    )}
                </>
            )}

            <div className="map-controls" style={{ position: "absolute", top: 10, left: 10, zIndex: 400 }}>
                <button
                    onClick={() => {
                        if (map) {
                            const center = map.getCenter();
                            console.log('Setting start point at:', center);
                            setStartPoint({
                                lat: center.lat,
                                lng: center.lng
                            });
                        } else {
                            console.error('Map not initialized');
                        }
                    }}
                    style={{
                        padding: '8px 16px',
                        marginRight: '10px',
                        backgroundColor: startPoint ? '#ccc' : '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                    }}
                    disabled={startPoint !== null}
                >
                    Place Start
                </button>
                <button
                    onClick={() => {
                        if (map) {
                            const center = map.getCenter();
                            console.log('Setting end point at:', center);
                            setEndPoint({
                                lat: center.lat,
                                lng: center.lng
                            });
                        } else {
                            console.error('Map not initialized');
                        }
                    }}
                    style={{
                        padding: '8px 16px',
                        backgroundColor: endPoint ? '#ccc' : '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                    }}
                    disabled={endPoint !== null}
                >
                    Place End
                </button>
            </div>

            {statusMessage && (
                <div style={{
                    position: 'absolute',
                    bottom: 20,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 1000,
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    color: 'white',
                    padding: '10px 20px',
                    borderRadius: '5px',
                    fontSize: '16px',
                    textAlign: 'center'
                }}>
                    {statusMessage}
                </div>
            )}
        </MapContainer>
    );
};

export default MapController;
