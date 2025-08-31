// relay_server.js - WebSocket relay server for Duck Duck Goose
// Deploy this to Heroku, Render.com, or Railway.app (all have free tiers)

const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // room_code -> { host: ws, clients: Set<ws> }

// Create HTTP server
const server = http.createServer((req, res) => {
  // Basic health check endpoint
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Duck Duck Goose Relay Server Running\nActive Rooms: ' + rooms.size);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const query = url.parse(req.url, true);
  const pathParts = query.pathname.split('/');
  
  // Extract room code and role from URL
  // Format: /room/ABCD?role=host or /room/ABCD?role=client
  if (pathParts.length < 3 || pathParts[1] !== 'room') {
    ws.close(1002, 'Invalid path format');
    return;
  }
  
  const roomCode = pathParts[2].toUpperCase();
  const role = query.query.role || 'client';
  
  console.log(`New connection: Room ${roomCode}, Role: ${role}`);
  
  // Store connection info
  ws.roomCode = roomCode;
  ws.role = role;
  ws.id = Math.random().toString(36).substr(2, 9);
  
  // Handle room creation or joining
  if (role === 'host') {
    if (rooms.has(roomCode)) {
      ws.close(1002, 'Room already exists');
      return;
    }
    
    // Create new room
    rooms.set(roomCode, {
      host: ws,
      clients: new Set(),
      created: Date.now()
    });
    
    console.log(`Room ${roomCode} created by host ${ws.id}`);
    
    // Send confirmation to host
    ws.send(JSON.stringify({
      type: 'room_created',
      roomCode: roomCode,
      hostId: ws.id
    }));
    
  } else {
    // Join existing room
    const room = rooms.get(roomCode);
    
    if (!room) {
      ws.close(1002, 'Room not found');
      return;
    }
    
    room.clients.add(ws);
    console.log(`Client ${ws.id} joined room ${roomCode}`);
    
    // Notify host of new client
    if (room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'client_joined',
        clientId: ws.id
      }));
    }
    
    // Send confirmation to client
    ws.send(JSON.stringify({
      type: 'room_joined',
      roomCode: roomCode,
      clientId: ws.id
    }));
  }
  
  // Handle incoming messages - relay between host and clients
  ws.on('message', (message) => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    try {
      // For Godot multiplayer, we need to relay raw binary data
      if (ws.role === 'host') {
        // Host -> All clients
        room.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
      } else {
        // Client -> Host and other clients
        if (room.host.readyState === WebSocket.OPEN) {
          room.host.send(message);
        }
        room.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
      }
    } catch (error) {
      console.error('Error relaying message:', error);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    console.log(`${ws.role} ${ws.id} disconnected from room ${ws.roomCode}`);
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    if (ws.role === 'host') {
      // Host disconnected - close room
      room.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1000, 'Host disconnected');
        }
      });
      rooms.delete(ws.roomCode);
      console.log(`Room ${ws.roomCode} closed`);
      
    } else {
      // Client disconnected
      room.clients.delete(ws);
      
      // Notify host
      if (room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'client_left',
          clientId: ws.id
        }));
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${ws.role} ${ws.id}:`, error);
  });
});

// Clean up old rooms periodically (rooms older than 2 hours)
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  
  rooms.forEach((room, code) => {
    if (now - room.created > maxAge) {
      console.log(`Cleaning up old room ${code}`);
      if (room.host.readyState === WebSocket.OPEN) {
        room.host.close(1000, 'Room expired');
      }
      room.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1000, 'Room expired');
        }
      });
      rooms.delete(code);
    }
  });
}, 60000); // Check every minute

server.listen(PORT, () => {
  console.log(`Duck Duck Goose Relay Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/room/[ROOM_CODE]?role=[host|client]`);
});