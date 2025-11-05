const { v4: uuidv4 } = require('uuid');

/**
 * createRoomManager
 * -----------------
 * Simple in-memory room manager for a collaborative drawing app.
 * Responsibilities:
 * - create/get room objects
 * - broadcast messages to all clients in a room (optionally excluding a WS)
 *
 * Note: This is memory-backed only — restart loses state. For persistence across
 * server restarts you would need to persist opLog to a database.
 */
function createRoomManager() {
  const rooms = new Map();

  function getOrCreate(roomId) {
    // Return existing room if present, otherwise create and store a new one.
    if (!rooms.has(roomId)) {
      rooms.set(roomId, createRoom(roomId));
    }
    return rooms.get(roomId);
  }

  /**
   * broadcast(roomIdOrObj, msg, exceptWs)
   * - Send a message (object) to every connected client in the given room.
   * - exceptWs: optional WebSocket instance to exclude (useful to avoid echoing to originator).
   * The message is JSON-stringified before sending.
   */
  function broadcast(roomIdOrObj, msg, exceptWs) {
    const roomObj = typeof roomIdOrObj === 'string' ? rooms.get(roomIdOrObj) : roomIdOrObj;
    if (!roomObj) return;
    const text = JSON.stringify(msg);

    // Iterate over clients (Set of ws-like objects)
    roomObj.clients.forEach(c => {
      if (exceptWs && c === exceptWs) return;
      // c.OPEN is usually WebSocket.OPEN (numeric constant); check readyState before sending
      if (c.readyState === c.OPEN) c.send(text);
    });
  }

  return { getOrCreate, broadcast };
}

/**
 * createRoom(id)
 * ---------------
 * Factory for a single room object representing a collaborative session.
 *
 * Room shape:
 * - id: room id string
 * - clients: Set of WebSocket-like client objects (each client should expose userId/username/color + send/readyState)
 * - opLog: ordered list of applied ops (strokes, shapes)
 * - undoneStack: stack of undone ops (used for redo)
 *
 * Methods:
 * - join(client): add client and broadcast updated user list
 * - leave(client): remove client
 * - userList(): return serialized list of connected users
 * - getState(): return copy of opLog for state sync
 * - applyPartialStroke(part, client): placeholder (server may broadcast partials but not store)
 * - pushOp(op, client): commit op to opLog (clears undone stack)
 * - undoLast(): pop last op and move to undoneStack (returns undo payload)
 * - redoLast(): pop undoneStack and push back to opLog (returns redo payload)
 */
function createRoom(id) {
  return {
    id,
    clients: new Set(),
    opLog: [], // applied ops in chronological order (server-authoritative)
    undoneStack: [], // stack of popped ops for redo support

    /**
     * join(client)
     * - Add client to room and broadcast current user list to all clients.
     * - client is expected to be a ws-like object with userId/username/color properties.
     */
    join(client) {
      this.clients.add(client);
      const list = this.userList();
      const txt = JSON.stringify({ type: 'user-list', payload: list });
      // Broadcast the updated list to everyone in the room
      for (const c of this.clients) {
        if (c.readyState === c.OPEN) c.send(txt);
      }
    },

    /**
     * leave(client)
     * - Remove client from set. Caller should also broadcast user-list if desired.
     */
    leave(client) {
      this.clients.delete(client);
    },

    /**
     * userList()
     * - Return an array of lightweight user objects for presence UI.
     * - Only includes public metadata (userId, username, color).
     */
    userList() {
      const list = [];
      for (const c of this.clients) {
        list.push({ userId: c.userId, username: c.username, color: c.color });
      }
      return list;
    },

    /**
     * getState()
     * - Return a shallow copy of server's op log so clients can sync full canvas state.
     */
    getState() {
      return this.opLog.slice();
    },

    /**
     * applyPartialStroke(part, client)
     * - Placeholder on server: partial stroke fragments can be broadcast to other clients
     *   so they render live drawing, but server does not persist partials in opLog.
     * - If you want server-side merging/validation of partials, implement logic here.
     */
    applyPartialStroke(part, client) {
      // no-op in this implementation — partials are transient and only broadcasted
    },

    /**
     * pushOp(op, client)
     * - Commit a finalized op (stroke/shape) to opLog.
     * - Ensures opId and ts exist, and resets redo stack on new op.
     */
    pushOp(op, client) {
      // ensure op has unique id and timestamp
      op.opId = op.opId || uuidv4();
      op.ts = op.ts || Date.now();
      if (!op.type) op.type = 'stroke';
      this.opLog.push(op);
      // new op invalidates redo history
      this.undoneStack = [];
    },

    /**
     * undoLast()
     * - Remove the most recent op and push it to undoneStack for redo.
     * - Returns an object that can be broadcast to clients so they remove the op locally:
     *   { targetOpId: <id>, ts: <when> }
     */
    undoLast() {
      if (this.opLog.length === 0) return null;
      const last = this.opLog.pop();
      this.undoneStack.push(last);
      return { targetOpId: last.opId, ts: Date.now() };
    },

    /**
     * redoLast()
     * - Reapply the last undone op by popping undoneStack and pushing back to opLog.
     * - Returns a payload containing the stroke so clients can re-draw it:
     *   { stroke: <op>, ts: <when> }
     */
    redoLast() {
      if (this.undoneStack.length === 0) return null;
      const op = this.undoneStack.pop();
      this.opLog.push(op);
      return { stroke: op, ts: Date.now() };
    }
  };
}

module.exports = { createRoomManager };
