// relay_server.js - WebSocket relay server for Duck Duck Goose
// This version works with the Godot client's connection pattern

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // room_code -> { host_id, players: Map<id, ws>, created }
const clients = new Map(); // ws -> { id, name, room_code }

// Generate random 4-letter room codes
function generateRoomCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += letters[Math.floor(Math.random() * letters.length)];
    }
  } while (rooms.has(code));
  return code;
}

// Generate unique player ID
function generatePlayerId() {
  return Math.random().toString(36).substr(2, 9);
}

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  // CORS headers for browser access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Duck Duck Goose Relay Server Running\nActive Rooms: ' + rooms.size);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  // Handle CORS for WebSocket
  handleProtocols: (protocols, request) => {
    // Accept any protocol for now
    return protocols[0];
  }
});

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  // Generate unique ID for this connection
  const playerId = generatePlayerId();
  
  // Store client info
  clients.set(ws, {
    id: playerId,
    name: 'Player',
    room_code: null
  });
  
  // Send connection confirmation (optional)
  ws.send(JSON.stringify({
    type: 'connected',
    player_id: playerId
  }));
  
  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received message:', data.type);
      
      switch (data.type) {
        case 'create_room':
          handleCreateRoom(ws, data);
          break;
          
        case 'join_room':
          handleJoinRoom(ws, data);
          break;
          
        case 'leave_room':
          handleLeaveRoom(ws);
          break;
          
        case 'start_game':
          handleStartGame(ws);
          break;
          
        case 'game_message':
          handleGameMessage(ws, data);
          break;
          
        default:
          console.log('Unknown message type:', data.type);
          // Relay unknown messages to room
          relayToRoom(ws, message);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      // If not JSON, treat as binary and relay
      relayToRoom(ws, message);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    handleDisconnect(ws);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleCreateRoom(ws, data) {
  const client = clients.get(ws);
  if (!client) return;
  
  // Generate room code
  const roomCode = generateRoomCode();
  
  // Update client info
  client.name = data.player_name || 'Host';
  client.room_code = roomCode;
  
  // Create room
  rooms.set(roomCode, {
    host_id: client.id,
    players: new Map([[client.id, ws]]),
    created: Date.now()
  });
  
  console.log(`Room ${roomCode} created by ${client.name} (${client.id})`);
  
  // Send confirmation
  ws.send(JSON.stringify({
    type: 'room_created',
    room_code: roomCode,
    player_id: client.id
  }));
}

function handleJoinRoom(ws, data) {
  const client = clients.get(ws);
  if (!client) return;
  
  const roomCode = data.room_code?.toUpperCase();
  const room = rooms.get(roomCode);
  
  if (!room) {
    ws.send(JSON.stringify({
      type: 'room_error',
      error: 'Room not found'
    }));
    return;
  }
  
  // Check if room is full (5 players max)
  if (room.players.size >= 5) {
    ws.send(JSON.stringify({
      type: 'room_error',
      error: 'Room is full'
    }));
    return;
  }
  
  // Update client info
  client.name = data.player_name || 'Player';
  client.room_code = roomCode;
  
  // Add to room
  room.players.set(client.id, ws);
  
  console.log(`${client.name} (${client.id}) joined room ${roomCode}`);
  
  // Send confirmation to joining player
  ws.send(JSON.stringify({
    type: 'room_joined',
    room_code: roomCode,
    player_id: client.id
  }));
  
  // Send player list to joining player
  const playerList = {};
  room.players.forEach((playerWs, playerId) => {
    const playerClient = clients.get(playerWs);
    if (playerClient && playerId !== client.id) {
      playerList[playerId] = {
        name: playerClient.name,
        is_host: playerId === room.host_id
      };
    }
  });
  
  ws.send(JSON.stringify({
    type: 'player_list',
    players: playerList
  }));
  
  // Notify other players
  room.players.forEach((playerWs, playerId) => {
    if (playerId !== client.id && playerWs.readyState === WebSocket.OPEN) {
      playerWs.send(JSON.stringify({
        type: 'player_joined',
        player_id: client.id,
        player_data: {
          name: client.name,
          is_host: false
        }
      }));
    }
  });
}

function handleLeaveRoom(ws) {
  const client = clients.get(ws);
  if (!client || !client.room_code) return;
  
  const room = rooms.get(client.room_code);
  if (!room) return;
  
  // Remove from room
  room.players.delete(client.id);
  
  // Notify other players
  room.players.forEach((playerWs) => {
    if (playerWs.readyState === WebSocket.OPEN) {
      playerWs.send(JSON.stringify({
        type: 'player_left',
        player_id: client.id
      }));
    }
  });
  
  // If host left, close room
  if (client.id === room.host_id) {
    room.players.forEach((playerWs) => {
      if (playerWs.readyState === WebSocket.OPEN) {
        playerWs.send(JSON.stringify({
          type: 'room_closed',
          reason: 'Host left'
        }));
      }
    });
    rooms.delete(client.room_code);
    console.log(`Room ${client.room_code} closed (host left)`);
  }
  
  // Clear client room info
  client.room_code = null;
  
  // Send confirmation
  ws.send(JSON.stringify({
    type: 'room_left'
  }));
}

function handleStartGame(ws) {
  const client = clients.get(ws);
  if (!client || !client.room_code) return;
  
  const room = rooms.get(client.room_code);
  if (!room) return;
  
  // Only host can start game
  if (client.id !== room.host_id) {
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Only host can start game'
    }));
    return;
  }
  
  // Notify all players
  room.players.forEach((playerWs) => {
    if (playerWs.readyState === WebSocket.OPEN) {
      playerWs.send(JSON.stringify({
        type: 'game_started'
      }));
    }
  });
  
  console.log(`Game started in room ${client.room_code}`);
}

function handleGameMessage(ws, data) {
  const client = clients.get(ws);
  if (!client || !client.room_code) return;
  
  const room = rooms.get(client.room_code);
  if (!room) return;
  
  // Handle player ready state
  if (data.message_type === 'player_ready') {
    // Broadcast to all players
    room.players.forEach((playerWs) => {
      if (playerWs.readyState === WebSocket.OPEN) {
        playerWs.send(JSON.stringify({
          type: 'game_state_updated',
          state: {
            players_ready: {
              [client.id]: data.data.ready
            }
          }
        }));
      }
    });
  } else {
    // Relay other game messages
    relayToRoom(ws, JSON.stringify(data));
  }
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client) return;
  
  console.log(`Player ${client.name} (${client.id}) disconnected`);
  
  // Leave room if in one
  if (client.room_code) {
    handleLeaveRoom(ws);
  }
  
  // Remove client
  clients.delete(ws);
}

function relayToRoom(ws, message) {
  const client = clients.get(ws);
  if (!client || !client.room_code) return;
  
  const room = rooms.get(client.room_code);
  if (!room) return;
  
  // Relay to all other players in room
  room.players.forEach((playerWs, playerId) => {
    if (playerId !== client.id && playerWs.readyState === WebSocket.OPEN) {
      playerWs.send(message);
    }
  });
}

// Clean up old rooms periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  
  rooms.forEach((room, code) => {
    if (now - room.created > maxAge) {
      console.log(`Cleaning up old room ${code}`);
      room.players.forEach((playerWs) => {
        if (playerWs.readyState === WebSocket.OPEN) {
          playerWs.send(JSON.stringify({
            type: 'room_closed',
            reason: 'Room expired'
          }));
        }
      });
      rooms.delete(code);
      roomStates.delete(code); // Clean up room state
    }
  });
}, 60000); // Check every minute

server.listen(PORT, () => {
  console.log(`Duck Duck Goose Relay Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});