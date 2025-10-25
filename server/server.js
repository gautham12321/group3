const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const TinyQueue = require('tinyqueue').default;
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = 3000;

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let activeSocket = null;
wss.on('connection', ws => {
    console.log('Client connected to WebSocket');
    activeSocket = ws;
    ws.on('close', () => {
        console.log('Client disconnected');
        activeSocket = null;
    });
});

function sendStatus(message) {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'status', message }));
    }
}

// --- CACHING ---
let cachedGraph = null;
let cachedBounds = null;

// Function to check if new bounds are contained within cached bounds
function isBoundsInCache(newBounds) {
    if (!cachedBounds) return false;
    return newBounds.minLat >= cachedBounds.minLat &&
           newBounds.maxLat <= cachedBounds.maxLat &&
           newBounds.minLng >= cachedBounds.minLng &&
           newBounds.maxLng <= cachedBounds.maxLng;
}

app.use(cors({
    origin: 'http://localhost:5173'
}));

app.use(bodyParser.json({ limit: '10mb' }));

// --- GEOMETRY HELPER FUNCTIONS ---

// Checks if a point is inside a polygon.
function isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].lat, yi = polygon[i].lng;
        const xj = polygon[j].lat, yj = polygon[j].lng;
        const intersect = ((yi > point.lng) !== (yj > point.lng))
            && (point.lat < (xj - xi) * (point.lng - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Calculates the distance between two lat/lng points in meters.
function distance(p1, p2) {
    const R = 6371e3; // Earth's radius in meters
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const deltaLat = (p2.lat - p1.lat) * Math.PI / 180;
    const deltaLng = (p2.lng - p1.lng) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// --- OSM & GRAPH FUNCTIONS ---

// Fetches road network data from the Overpass API.
async function getRoadNetwork(bounds) {
    const overpassQuery = `
        [out:json][timeout:25];
        (
            way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service)$"]
               (${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng});
        );
        out body;
        >;
        out skel qt;
    `;
    try {
        console.log('Fetching road network from Overpass API...');
        const response = await axios.post('https://overpass-api.de/api/interpreter', overpassQuery, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log('Successfully fetched road network.');
        return response.data;
    } catch (error) {
        console.error('Overpass API error:', error.response ? error.response.data : error.message);
        throw new Error('Failed to fetch road network data.');
    }
}

// Creates a graph from the OSM data.
function createGraphFromOSM(osmData) {
    const graph = { nodes: new Map(), adj: new Map() };

    // First, add all nodes to the graph
    osmData.elements.forEach(el => {
        if (el.type === 'node') {
            graph.nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
            graph.adj.set(el.id, []);
        }
    });

    // Then, create edges from ways
    osmData.elements.forEach(el => {
        if (el.type === 'way' && el.nodes) {
            for (let i = 0; i < el.nodes.length - 1; i++) {
                const u = el.nodes[i];
                const v = el.nodes[i + 1];
                const nodeU = graph.nodes.get(u);
                const nodeV = graph.nodes.get(v);

                if (nodeU && nodeV) {
                    const weight = distance({ lat: nodeU.lat, lng: nodeU.lon }, { lat: nodeV.lat, lng: nodeV.lon });
                    graph.adj.get(u).push({ node: v, weight });
                    graph.adj.get(v).push({ node: u, weight });
                }
            }
        }
    });
    console.log(`Graph created with ${graph.nodes.size} nodes.`);
    return graph;
}

// Finds the closest node in the graph to a given point.
function findClosestNode(point, graph) {
    let closestNode = null;
    let minDistance = Infinity;

    for (const node of graph.nodes.values()) {
        const d = distance(point, { lat: node.lat, lng: node.lon });
        if (d < minDistance) {
            minDistance = d;
            closestNode = node.id;
        }
    }
    return closestNode;
}

// Deep copies the graph structure, preserving Map objects.
function deepCopyGraph(graph) {
    const newGraph = { nodes: new Map(), adj: new Map() };
    // Deep copy nodes
    for (const [nodeId, nodeData] of graph.nodes.entries()) {
        newGraph.nodes.set(nodeId, { ...nodeData });
    }
    // Deep copy adjacency lists
    for (const [nodeId, adjList] of graph.adj.entries()) {
        newGraph.adj.set(nodeId, adjList.map(edge => ({ ...edge })));
    }
    return newGraph;
}

// --- A* PATHFINDING ALGORITHM ---

function findPath(startNodeId, endNodeId, graph, progressCallback) {
    const queue = new TinyQueue([], (a, b) => a.fScore - b.fScore);
    const cameFrom = new Map(); // {nodeId -> nodeId}
    const gScore = new Map(); // {nodeId -> score}
    const closedSet = new Set(); // Keep track of processed nodes
    let iterations = 0;

    // Heuristic function (Euclidean distance)
    const heuristic = (nodeIdA, nodeIdB) => {
        const nodeA = graph.nodes.get(nodeIdA);
        const nodeB = graph.nodes.get(nodeIdB);
        return distance({ lat: nodeA.lat, lng: nodeA.lon }, { lat: nodeB.lat, lng: nodeB.lon });
    };

    // Initialize scores
    for (const nodeId of graph.nodes.keys()) {
        gScore.set(nodeId, Infinity);
    }

    gScore.set(startNodeId, 0);
    queue.push({ id: startNodeId, fScore: heuristic(startNodeId, endNodeId) });

    while (queue.length > 0) {
        const { id: currentId } = queue.pop();

        if (currentId === endNodeId) {
            // Reconstruct path
            const path = [];
            let current = endNodeId;
            while (current) {
                const node = graph.nodes.get(current);
                path.unshift([node.lat, node.lon]);
                current = cameFrom.get(current);
            }
            return path;
        }

        // Send progress update every 500 iterations
        iterations++;
        if (iterations % 500 === 0 && progressCallback) {
            const partialPath = [];
            let current = currentId;
            while (current) {
                const node = graph.nodes.get(current);
                partialPath.unshift([node.lat, node.lon]);
                current = cameFrom.get(current);
            }
            progressCallback(partialPath);
        }

        closedSet.add(currentId); // Mark the current node as processed

        const neighbors = graph.adj.get(currentId) || [];
        for (const neighbor of neighbors) {
            const neighborId = neighbor.node;

            // Skip if the neighbor is already processed
            if (closedSet.has(neighborId)) {
                continue;
            }

            const tentativeGScore = gScore.get(currentId) + neighbor.weight;

            if (tentativeGScore < (gScore.get(neighborId) || Infinity)) {
                cameFrom.set(neighborId, currentId);
                gScore.set(neighborId, tentativeGScore);
                const fScore = tentativeGScore + heuristic(neighborId, endNodeId);
                queue.push({ id: neighborId, fScore: fScore });
            }
        }
    }

    return null; // No path found
}


// --- API ENDPOINT ---

app.post('/api/v1/route', async (req, res) => {
    try {
        const { start, end, hazards = [] } = req.body;
        if (!start || !end) {
            return res.status(400).json({ error: 'Invalid start or end points' });
        }

        // 1. Define bounding box & get base graph
        const padding = 0.01;
        const bounds = {
            minLat: Math.min(start.lat, end.lat) - padding,
            maxLat: Math.max(start.lat, end.lat) + padding,
            minLng: Math.min(start.lng, end.lng) - padding,
            maxLng: Math.max(start.lng, end.lng) + padding,
        };

        let fullGraph;
        if (isBoundsInCache(bounds)) {
            console.log("Using cached graph.");
            fullGraph = deepCopyGraph(cachedGraph);
        } else {
            console.log("Cache miss. Fetching new graph.");
            sendStatus('Fetching road network...');
            const osmData = await getRoadNetwork(bounds);
            sendStatus('Creating road graph...');
            fullGraph = createGraphFromOSM(osmData);
            cachedGraph = deepCopyGraph(fullGraph);
            cachedBounds = bounds;
        }

        // --- Attempt 1: Find path with hazard avoidance ---
        let path = null;
        let isSafe = true;

        if (hazards.length > 0) {
            sendStatus('Analyzing hazards...');
            const prunedGraph = deepCopyGraph(fullGraph);
            const nodesToRemove = new Set();
            for (const node of prunedGraph.nodes.values()) {
                for (const hazard of hazards) {
                    if (isPointInPolygon({ lat: node.lat, lng: node.lon }, hazard)) {
                        nodesToRemove.add(node.id);
                        break;
                    }
                }
            }

            if (nodesToRemove.size > 0) {
                sendStatus(`Pruning ${nodesToRemove.size} hazardous road sections...`);
                nodesToRemove.forEach(nodeId => {
                    prunedGraph.nodes.delete(nodeId);
                    prunedGraph.adj.delete(nodeId);
                });
                for (const adjList of prunedGraph.adj.values()) {
                    for (let i = adjList.length - 1; i >= 0; i--) {
                        if (nodesToRemove.has(adjList[i].node)) {
                            adjList.splice(i, 1);
                        }
                    }
                }
            }

            const startNodeId = findClosestNode(start, prunedGraph);
            const endNodeId = findClosestNode(end, prunedGraph);

            if (startNodeId && endNodeId) {
                sendStatus('Searching for the safest path...');
                path = findPath(startNodeId, endNodeId, prunedGraph, (p) => sendProgress(p, 'progress'));
            }
        }

        // --- Attempt 2: Find path ignoring hazards if the first attempt failed ---
        if (!path) {
            if (hazards.length > 0) {
                sendStatus('Safe path not found. Searching for any road path...');
                isSafe = false;
            } else {
                sendStatus('Searching for the best path...');
            }

            const startNodeId = findClosestNode(start, fullGraph);
            const endNodeId = findClosestNode(end, fullGraph);

            if (startNodeId && endNodeId) {
                path = findPath(startNodeId, endNodeId, fullGraph, (p) => sendProgress(p, 'progress-unsafe'));
            }
        }

        // --- Attempt 3: Return straight line as a last resort ---
        if (!path) {
            sendStatus('Could not find a road path. Returning a direct line.');
            isSafe = false;
            path = [[start.lat, start.lng], [end.lat, end.lng]];
        }

        // --- Final Response ---
        sendStatus('Route found!');
        const finalPath = [
            [start.lat, start.lng],
            ...path,
            [end.lat, end.lng]
        ];
        res.json({ path: finalPath, isSafe });

    } catch (error) {
        console.error('Error processing route request:', error);
        sendStatus(`Error: ${error.message}`);
        res.status(500).json({ error: 'Server error while calculating route.' });
    }
});

function sendProgress(path, type) {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type, path }));
    }
}

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
