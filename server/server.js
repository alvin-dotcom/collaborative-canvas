// server/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createRoomManager } = require('./rooms');

const app = express();
const server = http.createServer(app);

// `noServer: true` means we'll hook WebSocket upgrades manually on the HTTP server.
// This lets us read query params / route upgrades as needed.
const wss = new WebSocket.Server({ noServer: true });
const rooms = createRoomManager();

// Serve static client assets from ../client
app.use(express.static(path.join(__dirname, '../client')));

/**
 * HTTP -> WS upgrade handling
 * - Parse the request URL to read query params (room, username, color, etc.)
 * - Call wss.handleUpgrade to let the ws library create a socket, then emit a
 *   custom 'connection' with our additional request metadata (room + meta).
 */
server.on('upgrade', (request, socket, head) => {
  // Build absolute URL so URLSearchParams works in Node
  const url = new URL(request.url, `http://${request.headers.host}`);
  const room = url.searchParams.get('room') || 'default';

  // Attach room + all query params (meta) to the connection event
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, { room, meta: Object.fromEntries(url.searchParams.entries()) });
  });
});

/**
 * WebSocket connection handling
 * - Each connection is associated with a room (from query param).
 * - We create a lightweight server-side client wrapper (here we reuse `ws` and
 *   attach metadata directly to the socket object).
 */
wss.on('connection', (ws, reqInfo) => {
  const room = reqInfo.room || 'default';
  const meta = reqInfo.meta || {};

  const client = ws; // rename for clarity — we're treating ws as the client object
  // generate a server-side id for this client (useful for presence & cursor messages)
  const userId = 's_' + Math.random().toString(36).slice(2,9);

  // Attach public metadata directly to the ws object for easy access later
  client.userId = userId;
  client.username = meta.username || 'Anon';
  client.color = meta.color || '#000000';

  // Get (or create) the room object from the room manager
  const roomObj = rooms.getOrCreate(room);

  // Add client to the room and broadcast updated presence to everyone
  roomObj.join(client);

  // Immediately send the connecting client the current user list and authoritative canvas state
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify({ type: 'user-list', payload: roomObj.userList() }));
    client.send(JSON.stringify({ type: 'state', payload: roomObj.getState() }));
  }

  /**
   * Message handling
   * - Expect incoming messages as JSON with shape: { type: '...', payload: {...} }
   * - Delegate to handleMessage() for business logic / broadcasting
   */
  client.on('message', (msg) => {
    try {
      const { type, payload } = JSON.parse(msg);
      handleMessage(roomObj, client, type, payload);
    } catch (e) {
      console.error('[WS] malformed message', e);
    }
  });

  /**
   * Clean-up on close:
   * - Remove client from room
   * - Broadcast updated user-list and optional 'user-left' message so UI can react
   */
  client.on('close', () => {
    roomObj.leave(client);
    rooms.broadcast(room, { type: 'user-list', payload: roomObj.userList() });
    rooms.broadcast(room, { type: 'user-left', payload: { userId: client.userId } });
  });
});

/**
 * handleMessage
 * Central server-side handler for client messages.
 * Modify or extend this function when adding new message types.
 */
function handleMessage(roomObj, client, type, payload) {
  // Ping/pong: simple latency check where client sends ts and server echoes it back
  if (type === 'ping') {
    client.send(JSON.stringify({ type: 'pong', payload: { ts: payload.ts } }));
    return;
  }

  // Meta update: user changed username/color — update server-side record and broadcast presence
  if (type === 'meta') {
    client.username = payload.username || client.username;
    client.color = payload.color || client.color;
    rooms.broadcast(roomObj.id, { type: 'user-list', payload: roomObj.userList() });
    return;
  }

  // Partial stroke fragments: broadcast to other clients for near-real-time rendering.
  // Server does not persist these fragments (clients will send `op` when stroke is finalized).
  if (type === 'stroke-part') {
    // roomObj.applyPartialStroke is a placeholder in current room manager
    roomObj.applyPartialStroke(payload, client);
    rooms.broadcast(roomObj.id, { type: 'stroke-part', payload }, client); // exclude origin
    return;
  }

  // Finalized op (stroke/shape): persist in opLog and broadcast authoritative op to everyone
  if (type === 'op') {
    // payload.op expected to be the full op object (with points, shape, etc.)
    roomObj.pushOp(payload.op, client);
    rooms.broadcast(roomObj.id, { type: 'op', payload: { op: payload.op } }, null);
    return;
  }

  // Undo: server removes last op from opLog and broadcasts both an explicit 'undo' and an 'op' wrapper
  // The double-broadcast ensures clients listening for either message shape handle undo correctly.
  if (type === 'undo') {
    const undoInfo = roomObj.undoLast();
    if (undoInfo) {
      // explicit undo message (lightweight)
      rooms.broadcast(roomObj.id, { type: 'undo', payload: undoInfo }, null);
      // also publish an op wrapper so consumers listening only to 'op' messages still see it
      rooms.broadcast(roomObj.id, { type: 'op', payload: { op: { type: 'undo', targetOpId: undoInfo.targetOpId, ts: undoInfo.ts } } }, null);
    }
    return;
  }

  // Redo: reapply last undone op and broadcast it back to clients as both 'redo' and 'op' formats
  if (type === 'redo') {
    const redoInfo = roomObj.redoLast();
    if (redoInfo) {
      rooms.broadcast(roomObj.id, { type: 'redo', payload: redoInfo }, null);
      rooms.broadcast(roomObj.id, { type: 'op', payload: { op: { type: 'redo', stroke: redoInfo.stroke, ts: redoInfo.ts } } }, null);
    }
    return;
  }

  // Cursor positions: broadcast cursor movement to other clients in the room (exclude origin)
  if (type === 'cursor') {
    rooms.broadcast(
      roomObj.id,
      { type: 'cursor', payload: { userId: client.userId, x: payload.x, y: payload.y, color: client.color, username: client.username } },
      client
    );
    return;
  }

  // State request: client is asking for the authoritative opLog snapshot
  if (type === 'request-state') {
    client.send(JSON.stringify({ type: 'state', payload: roomObj.getState() }));
    return;
  }

  // Unknown message types are silently ignored — optionally you can log them:
  // console.warn('[WS] unknown message type:', type);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

