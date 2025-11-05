# Collaborative Canvas

Vanilla JavaScript + Node.js collaborative drawing canvas with real-time synchronization over WebSockets.

## Features
- 🖌️ **Brush & Eraser** — Freehand drawing with adjustable stroke width.  
- 🟢 **Color Picker** — Choose your personal color for strokes and presence indicator.  
- 🟦 **Shapes** — Draw rectangles, circles, or straight lines with live SVG previews.  
- 👥 **Multi-User Sync** — Real-time collaboration using WebSockets.  
- ⚡ **Progressive Stroke Streaming** — Drawings appear live, point-by-point, as you draw.  
- 🧭 **Live Cursors** — Everyone sees other users’ pointer positions and usernames.  
- ↩️ **Undo / Redo** — Global undo/redo stacks (server-authoritative).  
- 🧱 **Room-based Sessions** — Isolated drawing rooms; join any room by name.  
- ⏱️ **Latency Display** — See your connection delay in real time.  
- 💾 **No Dependencies** — Pure Canvas + WebSocket logic; lightweight and hackable.

## Quick start
1. Clone the repo.
2. `npm install`
3. `npm start`
4. Open `http://localhost:3000` in multiple browser windows/devices to test.

## How to test with multiple users
- Open multiple tabs or different browsers and click **Join** (room defaults to `default`).
- Change username & color in each tab to see user indicators.
- Drawing is synchronized in real-time.

## Known limitations / tradeoffs
- Server keeps op log in memory (no persistence). Restart loses history.
- Undo/Redo is "global stack" (last operation undone globally). This is simple and deterministic but not per-user selective undo.
- Overlapping strokes are handled by op ordering (last applied wins visually). No pixel-level merging or blending conflict resolution.
- Canvas re-render is naive: full redraw from opLog on undo/redo. This is acceptable for moderate load; can be optimized with tile caching or layers.
- Partial strokes are broadcast as full point arrays (could be optimized to diff only new points).

## Time spent
Estimated: 8–12 hours (prototype + docs + polish).

## Notes for reviewers
- See `ARCHITECTURE.md` for the design rationale, wireflow, WebSocket protocol, and undo/redo strategy.
- Server is in `server/` and client in `client/`.
