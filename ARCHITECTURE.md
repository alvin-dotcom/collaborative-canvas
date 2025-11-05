# ARCHITECTURE.md

## Goals
- Minimal, deterministic server that serializes operations and provides authoritative ordering.
- Smooth client-side drawing with optimistic local rendering and progressive remote updates.
- Global undo/redo implemented as operation-level stack on the server.

---

## Data Flow Diagram
1. Client captures pointer events → produces sampled points for a stroke.
2. Client begins stroke: optimistic local render + start batching.
3. Client sends `stroke-part` messages regularly (batched points), and final `op` when stroke ends.
4. Server receives `stroke-part` → broadcasts to other clients in same room so they incrementally render.
5. Server receives final `op` → appends to authoritative `opLog` and broadcasts `op` to all clients.
6. Undo/Redo: client sends `undo` or `redo` command → server pops/pushes operations from opLog ↔ undoneStack and broadcasts `undo` / `redo` events to all clients.

---

## WebSocket protocol (messages JSON: `{type, payload}`)
- `stroke-part` → partial stroke. `payload = { opId, userId, points: [{x,y},...], color, width, finalize }`
  - Sent frequently while drawing; `finalize: true` on stroke end.
- `op` → authoritative operation. `payload = { op }` where `op` is `{opId, type:'stroke', userId, username, color, width, points, ts}`
- `cursor` → user cursor position. `payload = { userId, x, y, color, username }`
- `meta` → update user metadata (username, color)
- `undo` → request undo last op globally
- `redo` → request redo
- `request-state` → client requests full `opLog` snapshot
- `state` → server response with full opLog: `payload = [op1, op2, ...]`
- `user-list` → array of connected users in room
- `user-left` → notify particular user left

---

## Serialization & batching
- Strokes are sequences of (x, y) points. Client samples pointer movements and sends points at ~25Hz.
- Final stroke is sent as `op` with the final points array.
- Points are sent as small arrays of floats; compression/quantization can be added later (e.g., delta-encoding, 16-bit fixed-point).

---

## Client-side prediction & smoothing
- The client draws locally as points arrive to avoid perceived latency (optimistic rendering).
- To smooth, draw using `lineTo` and `lineJoin: round` with `lineCap: round`. Optionally implement Catmull-Rom / quadratic curves for smoother strokes (not included to keep code simple).

---

## Conflict resolution
- Server serializes operations in the order they are finalized (`op` arrival order).
- Overlapping strokes: since canvas drawing is essentially additive, last-applied stroke visually overlays earlier ones. This is deterministic and simple.
- For edits like eraser: eraser is implemented as drawing with white color (or using globalCompositeOperation if desired). Eraser operations are normal ops and follow same ordering.

---

## Global Undo/Redo strategy (key design)
**Requirements**: Undo/Redo must be global and consistent across users.

**Design chosen**: **Operation Stack (server-authoritative)**
- Keep `opLog` (array) on the server. Each `op` is atomic (a completed stroke).
- Undo: remove the last op from `opLog` → push onto `undoneStack` → broadcast an `undo` message referencing `targetOpId`.
- Redo: pop from `undoneStack` and push back to `opLog` → broadcast a `redo` event containing the full stroke.
- Clients respond to `undo` by removing the referenced op from their local appliedOps and re-drawing the canvas from their local op list (or rely on server state).
- Advantages:
  - Deterministic and easy to reason about.
  - Supports multiple users because the server serializes operations.
- Limitations:
  - Global last-op semantics (not per-user). This is the simplest correct global approach.
  - More advanced CRDT-based or per-user undo models can be built, but are significantly more complex.

---

## Performance decisions
- Batch stroke points at ~25Hz to avoid flooding the network with events on high pointer frequency.
- DevicePixelRatio-aware canvas sizing to keep strokes crisp.
- Redraw on undo/redo is currently full-canvas redraw from opLog. For better scale, implement:
  - Layer caching (rasterize groups of ops to offscreen canvases)
  - Region invalidation (redraw only bounding boxes impacted)
  - Snapshotting and incremental persistence

---

## Scaling & further improvements
- Persist opLog to DB + snapshotting so new clients can get a snapshot + deltas rather than full replay.
- Use a message broker (Redis pub/sub) and a cluster of WS servers for horizontal scaling.
- For thousands of users: partition by rooms, shard hot rooms, and implement interest management (only send data to active watchers).
- CRDT-based conflict resolution for fine-grained collaborative editing (if tools support non-additive ops like pixel-level edits).

