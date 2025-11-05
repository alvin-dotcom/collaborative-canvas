// client entry script — binds UI to websocket + CanvasController

// build WS URL based on page protocol and host
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const ws = new WSClient(WS_URL);

// DOM elements (controls + canvas)
const joinBtn = document.getElementById('join-btn');
const roomInput = document.getElementById('room-input');
const usernameInput = document.getElementById('username');
const modal = document.getElementById('name-modal');
const modalUsername = document.getElementById('modal-username');
const modalJoin = document.getElementById('modal-join');
const colorPicker = document.getElementById('color-picker');
const strokeRange = document.getElementById('stroke-width');
const eraserBtn = document.getElementById('eraser-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const usersList = document.getElementById('users-list');
const latencySpan = document.getElementById('latency');
const toolSelect = document.getElementById('tool-select');
const shapeTypeLabel = document.getElementById('shape-type-label');
const shapeTypeSelect = document.getElementById('shape-type');

const canvasEl = document.getElementById('draw-canvas');
const canvasWrap = document.getElementById('canvas-wrap');

// runtime state
let controller = null; // CanvasController instance (created on ws open)
let room = roomInput.value;
let metaUsername = 'Anon'; // default until user provides name

/* ---------------------------
 * Modal (name) flow
 * ---------------------------
 * When page loads, show name modal so user provides display name before joining.
 */
function openNameModal() {
  modal.style.display = 'flex';
  modalUsername.focus();
}
openNameModal();

modalJoin.addEventListener('click', () => {
  const val = modalUsername.value.trim();
  // optional: allow user to specify room from modal via input with id 'modal-room'
  const roomVal = document.getElementById('modal-room').value.trim();
  if (!val) {
    alert('Please enter a display name');
    modalUsername.focus();
    return;
  }
  // set username in local meta and visible username input
  metaUsername = val;
  usernameInput.value = metaUsername;

  // if modal specified a room, copy it to visible room input
  if (roomVal) {
    roomInput.value = roomVal;
  }

  modal.style.display = 'none';
  joinRoom();
});

/* ---------------------------
 * Join room: connect WS with metadata
 * ---------------------------
 * room default is 'default' if nothing provided.
 * meta includes username and selected color for presence rendering.
 */
function joinRoom() {
  room = roomInput.value || 'default';
  const meta = { username: usernameInput.value || metaUsername, color: colorPicker.value };
  ws.connect(room, meta);
}

/* ---------------------------
 * Join button wiring
 * - Ensures user entered a name (modal) first.
 */
joinBtn.addEventListener('click', () => {
  // if modal still open, force user to use it first
  if (modal.style.display !== 'none') {
    alert('Please enter your name to join (modal)');
    return;
  }
  joinRoom();
});

/* ---------------------------
 * WebSocket open handler
 * - Create CanvasController on first open, otherwise update user meta on reconnect.
 * - Calls requestFullState shortly after creation to sync the canvas state.
 */
ws.on('open', () => {
  if (!controller) {
    controller = CanvasController(canvasEl, ws, {
      userId: 'client_' + Math.random().toString(36).slice(2,6),
      username: usernameInput.value || metaUsername,
      color: colorPicker.value,
      strokeWidth: parseInt(strokeRange.value, 10)
    });
    // ensure controller size matches layout
    controller.resize();
    // small delay then request full canvas state from server
    setTimeout(() => controller.requestFullState(), 200);
  } else {
    // if reconnecting, update controller meta
    controller.setUserMeta({ username: usernameInput.value || metaUsername, color: colorPicker.value });
  }
});

/* ---------------------------
 * WS message handling
 * - user-list: render online users
 * - pong: latency measurement (server echoes ping)
 */
ws.on('message', (data) => {
  if (data.type === 'user-list') {
    renderUsersList(data.payload);
  } else if (data.type === 'pong') {
    // server sent back the same ts we pinged with — calculate latency
    latencySpan.textContent = `latency ${Date.now() - data.payload.ts} ms`;
  }
});

/* ---------------------------
 * Render users list helper
 * - draws a small color dot + username for each connected user
 */
function renderUsersList(list) {
  usersList.innerHTML = '';
  for (const u of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="color-dot" style="background:${u.color}"></span> ${u.username || u.userId}`;
    usersList.appendChild(li);
  }
}

/* ---------------------------
 * UI bindings -> controller / ws
 * - colorPicker: updates local controller + broadcast meta
 * - strokeRange: set width on controller
 * - eraserBtn: toggles eraser mode and keeps tool select in sync
 * - undo/redo: call controller wrappers that send server requests
 */

/* Color Picker */
colorPicker.addEventListener('input', () => {
  if (controller) controller.setColor(colorPicker.value);
  // broadcast metadata change so other clients see updated color/username
  ws.send('meta', { color: colorPicker.value, username: usernameInput.value });
});

/* Stroke width slider */
strokeRange.addEventListener('input', () => { if (controller) controller.setWidth(parseInt(strokeRange.value,10)); });

/* Eraser button: toggles eraser mode locally and in UI */
let eraserActive = false;
eraserBtn.addEventListener('click', () => {
  eraserActive = !eraserActive;
  if (controller) controller.setEraser(eraserActive);
  eraserBtn.textContent = eraserActive ? 'Eraser (ON)' : 'Eraser';
  // keep the tool dropdown consistent with button state
  toolSelect.value = eraserActive ? 'eraser' : 'brush';
});

/* Undo / Redo buttons */
undoBtn.addEventListener('click', () => { if (controller) controller.doUndo(); });
redoBtn.addEventListener('click', () => { if (controller) controller.doRedo(); });

/* ---------------------------
 * Tool selection dropdown wiring
 * - show/hide shape-type controls based on tool
 * - keep eraserActive flag consistent if user picks eraser from select
 */
toolSelect.addEventListener('change', (e) => {
  const t = e.target.value;
  if (controller) controller.setTool(t);
  // show shape controls only when shape tool is selected
  if (t === 'shape') shapeTypeLabel.style.display = '';
  else shapeTypeLabel.style.display = 'none';
  // keep button state consistent
  eraserActive = (t === 'eraser');
  eraserBtn.textContent = eraserActive ? 'Eraser (ON)' : 'Eraser';
});

/* Shape type select (rect/circle/line) */
shapeTypeSelect.addEventListener('change', (e) => {
  const s = e.target.value;
  if (controller) controller.setShapeType(s);
});

/* ---------------------------
 * Ping / Pong telemetry
 * - periodically ping server to show latency (server should reply with 'pong' and same ts)
 */
setInterval(() => { if (ws) ws.send('ping', { ts: Date.now() }); }, 3000);

/* ---------------------------
 * Username changes (from visible input)
 * - update controller meta and broadcast the change to server
 */
usernameInput.addEventListener('change', () => {
  if (controller) controller.setUserMeta({ username: usernameInput.value });
  ws.send('meta', { username: usernameInput.value });
});