/**
 * WSClient
 * ----------
 * Lightweight WebSocket wrapper for your collaborative drawing app.
 *
 * Features:
 * - Automatically connects to the given WebSocket URL with query params for room and metadata.
 * - Simplifies sending typed messages (`send(type, payload)`).
 * - Provides a small event system (`on(event, callback)`) for `open`, `message`, `close`, `error`.
 *
 * Example:
 *   const ws = new WSClient('wss://example.com/ws');
 *   ws.on('message', data => console.log('got', data));
 *   ws.connect('room123', { username: 'Alvin', color: '#ff0000' });
 */
class WSClient {
  constructor(url) {
    this.url = url;      // Base WebSocket endpoint (e.g. ws://localhost:3000/ws)
    this.ws = null;      // Current WebSocket connection
    this._on = {};       // Event listeners map { eventName: [callbacks] }
  }

  /**
   * connect(roomId, meta)
   * ----------------------
   * Opens a WebSocket connection to the server.
   * The connection query string includes:
   *   ?room=<roomId>&username=<name>&color=<hex>&...
   *
   * @param {string} roomId - Room name/id to join
   * @param {object} meta - Additional metadata (username, color, etc.)
   */
  connect(roomId, meta = {}) {
    // Close any existing connection before reconnecting
    if (this.ws) this.ws.close();

    // Build URL with query parameters for room and user metadata
    const q = new URLSearchParams({ room: roomId, ...meta });
    this.ws = new WebSocket(this.url + '/?' + q.toString());

    // Bind WebSocket event handlers to our internal emit system
    this.ws.onopen = () => this._emit('open');
    this.ws.onmessage = (ev) => {
      try {
        // Parse and re-emit structured message object { type, payload }
        const data = JSON.parse(ev.data);
        this._emit('message', data);
      } catch (e) {
        console.error('[WSClient] invalid message', e);
      }
    };
    this.ws.onclose = () => this._emit('close');
    this.ws.onerror = (e) => this._emit('error', e);
  }

  /**
   * send(type, payload)
   * --------------------
   * Sends a JSON packet to the server over the open WebSocket.
   * If the socket isn’t open, logs a warning instead of throwing.
   *
   * @param {string} type - Message type (e.g. 'op', 'undo', 'ping')
   * @param {object} payload - Message data
   */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WSClient] send dropped, socket not open:', type);
      return;
    }
    const packet = { type, payload };
    // Optional debug log
    // console.debug('[WSClient] sending', packet);
    this.ws.send(JSON.stringify(packet));
  }

  /**
   * on(event, callback)
   * --------------------
   * Registers a callback for a given event type:
   * - 'open'   : WebSocket connection established
   * - 'message': Message received from server
   * - 'close'  : Connection closed
   * - 'error'  : Error event from WebSocket
   *
   * @param {string} event - Event name
   * @param {function} cb - Callback to run on event
   */
  on(event, cb) {
    if (!this._on[event]) this._on[event] = [];
    this._on[event].push(cb);
  }

  /**
   * _emit(event, ...args)
   * -----------------------
   * Internally used to call all registered callbacks for a given event.
   * Supports multiple listeners per event type.
   */
  _emit(event, ...args) {
    (this._on[event] || []).forEach(cb => cb(...args));
  }
}
