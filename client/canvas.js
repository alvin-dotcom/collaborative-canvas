/**
 * CanvasController
 * ----------------
 * Controls a collaborative drawing canvas:
 * - local drawing (brush/eraser)
 * - shape drawing (rect/circle/line) with SVG preview overlay
 * - partial-stroke batching for sending stroke fragments to server
 * - undo/redo handling via server messages
 * - pointer previews (cursor/eraser circle) and remote cursor broadcasts
 *
 * Parameters:
 * - canvas: HTMLCanvasElement to bind to
 * - ws: WebSocket-like wrapper with .send(type, payload) and .on('message', handler)
 * - opts: { userId, username, color, strokeWidth }
 *
 * Return: small API for controlling tools and requesting state
 */
function CanvasController(canvas, ws, opts = {}) {
  const ctx = canvas.getContext('2d');

  // logical canvas size (CSS size is handled in resize())
  let width = 800, height = 600;

  // drawing state
  let isDrawing = false;
  let currentStroke = null;

  // user metadata
  let userId = opts.userId || ('u_' + Math.random().toString(36).slice(2,10));
  let username = opts.username || 'Anonymous';
  let color = opts.color || '#000';
  let strokeWidth = opts.strokeWidth || 4;

  // tool state
  let eraser = false;
  let tool = 'brush'; // 'brush' | 'shape' | 'eraser'
  let shapeType = 'rect'; // 'rect'|'circle'|'line'

  // appliedOps is the local representation of the server state.
  // It contains strokes, shapes, and undo/redo wrapper ops.
  const appliedOps = [];

  /* ---------------------------
   * Pointer preview elements
   * ---------------------------
   * pointerPreview: a floating div that follows the pointer to show brush/eraser size
   * svgPreview: an SVG overlay used to preview shapes while the user is dragging
   */
  const container = canvas.parentElement;
  const pointerPreview = document.createElement('div');
  pointerPreview.style.position = 'absolute';
  pointerPreview.style.pointerEvents = 'none';
  pointerPreview.style.borderRadius = '50%';
  pointerPreview.style.border = '2px dashed rgba(0,0,0,0.6)';
  pointerPreview.style.transform = 'translate(-50%, -50%)';
  pointerPreview.style.display = 'none';
  pointerPreview.style.zIndex = 999;
  container.appendChild(pointerPreview);

  const svgPreview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgPreview.style.position = 'absolute';
  svgPreview.style.left = '0';
  svgPreview.style.top = '0';
  svgPreview.style.width = '100%';
  svgPreview.style.height = '100%';
  svgPreview.style.pointerEvents = 'none';
  svgPreview.style.display = 'none';
  svgPreview.style.zIndex = 998;
  container.appendChild(svgPreview);

  /**
   * showPointerPreview(x, y)
   * - Shows pointer preview at client coords x,y
   * - If current tool is 'shape' we hide the circular preview and show the svg preview instead.
   */
  function showPointerPreview(x, y) {
    if (tool === 'shape') {
      // for shapes, we use the svg overlay preview (created in previewShape)
      pointerPreview.style.display = 'none';
      svgPreview.style.display = 'block';
      return;
    }
    pointerPreview.style.display = 'block';
    const size = Math.max(6, strokeWidth * 2); // ensure minimum visible size
    pointerPreview.style.width = size + 'px';
    pointerPreview.style.height = size + 'px';
    pointerPreview.style.left = x + 'px';
    pointerPreview.style.top = y + 'px';
    // darker border when eraser for visual clarity
    pointerPreview.style.borderColor = eraser ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.4)';
    svgPreview.style.display = 'none';
  }

  function hidePointerPreview() {
    pointerPreview.style.display = 'none';
    svgPreview.style.display = 'none';
    // clear svg children to remove any leftover preview shapes
    while (svgPreview.firstChild) svgPreview.removeChild(svgPreview.firstChild);
  }

  /* ---------------------------
   * Resize / device pixel ratio helper
   * ---------------------------
   * Keeps the canvas crisp on high-DPR displays and replays state after resize.
   */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width; height = rect.height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    // set transform so drawing coordinates are in CSS pixels
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // re-render everything from appliedOps after resizing to avoid blurriness or distortion
    redrawFromServer();
  }

  /* ---------------------------
   * Stroke (freehand) drawing
   * ---------------------------
   * beginStroke / pushPoint / endStroke implement local stroke assembly.
   * Strokes are sent in parts (batched) while drawing and finalized at endStroke.
   */
  function beginStroke(pt) {
    isDrawing = true;
    const opId = 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
    currentStroke = {
      opId,
      type: 'stroke',
      userId,
      username,
      color: eraser ? '#ffffff' : color, // if eraser, use white (canvas-background) color
      width: strokeWidth,
      points: [pt],
      ts: Date.now()
    };
    // draw initial point (segment) immediately for instant local feedback
    drawStrokeSegment(currentStroke, 0, currentStroke.points.length);
    startBatchSend();
  }

  function pushPoint(pt) {
    if (!isDrawing || !currentStroke) return;
    currentStroke.points.push(pt);
    // draw the most recent segment only (incremental)
    drawStrokeSegment(currentStroke, currentStroke.points.length - 2, currentStroke.points.length);
  }

  function endStroke() {
    if (!isDrawing || !currentStroke) return;
    appliedOps.push(currentStroke); // commit to local state
    sendBatch(true); // send final fragment
    stopBatchSend();
    // notify server of the final op so everyone can commit it
    ws.send('op', { op: currentStroke });
    currentStroke = null;
    isDrawing = false;
  }

  /**
   * drawStrokeSegment(stroke, fromIndex, toIndex)
   * - Responsible for rendering part (or full) of a stroke on the canvas
   * - Uses round line caps & joins for smooth strokes
   */
  function drawStrokeSegment(stroke, fromIndex, toIndex) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width;
    ctx.beginPath();
    const pts = stroke.points;
    if (fromIndex <= 0) {
      // draw from the very first point
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < toIndex; i++) ctx.lineTo(pts[i].x, pts[i].y);
    } else {
      // draw incremental segment: move to the previous point and draw to new ones
      const p = pts[fromIndex - 1];
      ctx.moveTo(p.x, p.y);
      for (let i = fromIndex; i < toIndex; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  /* ---------------------------
   * Shape drawing (rect/circle/line)
   * ---------------------------
   * Shapes are created with a preview (svgPreview) then committed as 'shape' ops.
   */
  function drawShapeOp(op) {
    // Basic rendering of committed shape ops
    ctx.save();
    ctx.lineWidth = op.width || 2;
    ctx.strokeStyle = op.color || '#000';
    ctx.fillStyle = 'transparent';
    if (op.shape === 'rect') {
      const x = op.x, y = op.y, w = op.w, h = op.h;
      ctx.strokeRect(x, y, w, h);
    } else if (op.shape === 'circle') {
      const cx = op.cx, cy = op.cy, r = op.r;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    } else if (op.shape === 'line') {
      ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------
   * Clearing / re-rendering helpers
   * ---------------------------
   */
  function clearCanvasVisual() {
    const ratio = window.devicePixelRatio || 1;
    ctx.save();
    // Reset transform to ensure clearing covers entire canvas pixel area
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /**
   * redrawFromServer()
   * - Replays the appliedOps array to draw the full canvas state.
   * - Useful after resize or when an operation removes an op (undo).
   */
  function redrawFromServer() {
    clearCanvasVisual();
    for (const op of appliedOps) {
      if (op.type === 'stroke') {
        if (op.points && op.points.length) drawStrokeSegment(op, 0, op.points.length);
      } else if (op.type === 'shape') {
        drawShapeOp(op);
      } else if (op.type === 'redo' && op.stroke) {
        // 'redo' wrapper from server contains the original stroke in op.stroke
        if (op.stroke.type === 'stroke') drawStrokeSegment(op.stroke, 0, op.stroke.points.length);
        else if (op.stroke.type === 'shape') drawShapeOp(op.stroke);
      } else if (op.type === 'undo') {
        // undo ops are handled by removing the target op from appliedOps;
        // redrawFromServer simply replays what's left in appliedOps
      }
    }
  }

  /* ---------------------------
   * Shape preview & commit helpers
   * ---------------------------
   * previewShape: draws a preview into svgPreview while user drags
   * commitShape: converts the preview into a shape op and broadcasts it
   */
  let shapeStart = null;
  function previewShape(from, to) {
    // clear svg children before drawing preview
    while (svgPreview.firstChild) svgPreview.removeChild(svgPreview.firstChild);
    if (!from || !to) return;
    // compute shape-specific preview elements in SVG coordinates (CSS pixels)
    const sx = from.x, sy = from.y, ex = to.x, ey = to.y;
    if (shapeType === 'rect') {
      const x = Math.min(sx, ex), y = Math.min(sy, ey), w = Math.abs(ex - sx), h = Math.abs(ey - sy);
      const el = document.createElementNS(svgPreview.namespaceURI, 'rect');
      el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', h);
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', color); el.setAttribute('stroke-width', Math.max(1, strokeWidth / 2));
      svgPreview.appendChild(el);
    } else if (shapeType === 'circle') {
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
      const dx = ex - sx, dy = ey - sy;
      const r = Math.sqrt(dx*dx + dy*dy) / 2;
      const el = document.createElementNS(svgPreview.namespaceURI, 'circle');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r);
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', color); el.setAttribute('stroke-width', Math.max(1, strokeWidth / 2));
      svgPreview.appendChild(el);
    } else if (shapeType === 'line') {
      const el = document.createElementNS(svgPreview.namespaceURI, 'line');
      el.setAttribute('x1', sx); el.setAttribute('y1', sy); el.setAttribute('x2', ex); el.setAttribute('y2', ey);
      el.setAttribute('stroke', color); el.setAttribute('stroke-width', Math.max(1, strokeWidth / 2));
      svgPreview.appendChild(el);
    }
  }

  function commitShape(from, to) {
    const opId = 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
    if (shapeType === 'rect') {
      const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y), w = Math.abs(to.x - from.x), h = Math.abs(to.y - from.y);
      const shapeOp = { opId, type: 'shape', shape: 'rect', x, y, w, h, color, width: strokeWidth, userId, username, ts: Date.now() };
      appliedOps.push(shapeOp);
      ws.send('op', { op: shapeOp });
    } else if (shapeType === 'circle') {
      const cx = (from.x + to.x)/2, cy = (from.y + to.y)/2;
      const dx = to.x - from.x, dy = to.y - from.y;
      const r = Math.sqrt(dx*dx + dy*dy)/2;
      const shapeOp = { opId, type: 'shape', shape: 'circle', cx, cy, r, color, width: strokeWidth, userId, username, ts: Date.now() };
      appliedOps.push(shapeOp);
      ws.send('op', { op: shapeOp });
    } else if (shapeType === 'line') {
      const shapeOp = { opId, type: 'shape', shape: 'line', x1: from.x, y1: from.y, x2: to.x, y2: to.y, color, width: strokeWidth, userId, username, ts: Date.now() };
      appliedOps.push(shapeOp);
      ws.send('op', { op: shapeOp });
    }
    // clear svg preview children and hide preview
    while (svgPreview.firstChild) svgPreview.removeChild(svgPreview.firstChild);
    svgPreview.style.display = 'none';
  }

  /* ---------------------------
   * Batching for partial stroke sending
   * ---------------------------
   * We send small fragments of the stroke to the server while drawing for near-real-time remote rendering.
   */
  let batchTimer = null;
  function startBatchSend() {
    if (batchTimer) return;
    // send every 40ms while drawing
    batchTimer = setInterval(() => sendBatch(false), 40);
  }
  function stopBatchSend() {
    if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
  }
  function sendBatch(finalize) {
    if (!currentStroke) return;
    const payload = {
      opId: currentStroke.opId,
      userId,
      username,
      points: currentStroke.points.slice(), // shallow copy to avoid mutation while sending
      color: currentStroke.color,
      width: currentStroke.width,
      finalize: !!finalize
    };
    ws.send('stroke-part', payload);
  }

  /* ---------------------------
   * Undo / Redo wrappers
   * ---------------------------
   * These send requests to the server; the server is expected to broadcast the resulting op changes back.
   */
  function doUndo() { ws.send('undo', {}); }
  function doRedo() { ws.send('redo', {}); }

  /* ---------------------------
   * Pointer helpers & event handlers
   * ---------------------------
   * clientPosToCanvas converts client coordinates to canvas-local CSS pixel coords.
   * Pointer event handlers manage drawing, shape previewing, and pointer capture.
   */
  function clientPosToCanvas(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: (evt.clientX - rect.left), y: (evt.clientY - rect.top) };
  }

  function onPointerDown(e) {
    // ignore non-left mouse buttons for mouse input
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = clientPosToCanvas(e);
    if (tool === 'brush' || tool === 'eraser') {
      if (tool === 'eraser') { eraser = true; } else { eraser = false; }
      beginStroke(pt);
    } else if (tool === 'shape') {
      // start shape drag & show svg preview
      shapeStart = pt;
      svgPreview.style.display = 'block';
      previewShape(shapeStart, shapeStart);
    }
    // acquire pointer capture so we continue receiving pointer events even if pointer leaves canvas
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    const pt = clientPosToCanvas(e);
    showPointerPreview(pt.x, pt.y);

    if (tool === 'brush' || tool === 'eraser') {
      if (isDrawing) pushPoint(pt);
    } else if (tool === 'shape') {
      if (shapeStart) previewShape(shapeStart, pt);
    }

    // Throttle remote cursor broadcast to avoid flooding the server
    if (!cursorThrottle) {
      cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 50);
      ws.send('cursor', { userId, x: pt.x, y: pt.y });
    }
  }

  function onPointerUp(e) {
    const pt = clientPosToCanvas(e);
    if (tool === 'brush' || tool === 'eraser') {
      endStroke();
    } else if (tool === 'shape') {
      if (shapeStart) {
        commitShape(shapeStart, pt);
        shapeStart = null;
      }
    }
    // release pointer capture and hide previews
    canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
    hidePointerPreview();
  }
  let cursorThrottle = null;

  /* ---------------------------
   * WebSocket inbound handling
   * ---------------------------
   * The ws.on('message') handler interprets server messages and updates local state.
   * Expected message format: { type: 'op'|'stroke-part'|'undo'|'redo'|'state'|'cursor'|'user-list', payload }
   */
  ws.on('message', (data) => {
    const { type, payload } = data;
    if (type === 'op') {
      const op = payload.op;
      if (!op) return;
      if (op.type === 'stroke') {
        appliedOps.push(op);
        drawStrokeSegment(op, 0, op.points.length);
      } else if (op.type === 'shape') {
        appliedOps.push(op);
        drawShapeOp(op);
      } else if (op.type === 'undo') {
        // server-sent undo wrapper: remove target op then re-render
        const idx = appliedOps.findIndex(o => o.opId === op.targetOpId);
        if (idx !== -1) { appliedOps.splice(idx, 1); redrawFromServer(); }
      } else if (op.type === 'redo' && op.stroke) {
        appliedOps.push(op.stroke); redrawFromServer();
      }
    } else if (type === 'stroke-part') {
      // handle incoming partial stroke fragments from another user
      applyRemotePartialStroke(payload);
    } else if (type === 'undo') {
      // explicit undo payload: remove by targetOpId and re-render
      const idx = appliedOps.findIndex(o => o.opId === payload.targetOpId);
      if (idx !== -1) { appliedOps.splice(idx, 1); redrawFromServer(); }
    } else if (type === 'redo') {
      // server provides full stroke to redo
      if (payload && payload.stroke) { appliedOps.push(payload.stroke); redrawFromServer(); }
    } else if (type === 'state') {
      // full state sync: replace appliedOps and redraw
      appliedOps.length = 0;
      for (const op of payload) appliedOps.push(op);
      redrawFromServer();
    } else if (type === 'cursor') {
      // show remote cursor (not implemented here) — event allowed for UI code to hook into
    } else if (type === 'user-list') {
      // dispatch a custom event so UI can update user lists
      canvas.dispatchEvent(new CustomEvent('users-updated', { detail: payload }));
    }
  });

  /**
   * applyRemotePartialStroke(part)
   * - Merges partial stroke fragments from remote users into appliedOps.
   * - If a stroke with the same opId doesn't exist, create a placeholder and append points as they arrive.
   */
  function applyRemotePartialStroke(part) {
    if (!part || !part.opId) return;
    let existing = appliedOps.find(o => o.opId === part.opId);
    if (!existing) {
      existing = {
        opId: part.opId,
        type: 'stroke',
        userId: part.userId,
        username: part.username,
        color: part.color,
        width: part.width,
        points: []
      };
      appliedOps.push(existing);
    }
    // replace points with the incoming array — server is authoritative for partial stroke content
    existing.points = part.points;
    // redraw entire canvas to ensure partial strokes blend correctly
    redrawFromServer();
  }

  /* ---------------------------
   * Tool setters: external API to change color, width, tool, etc.
   */
  function setColor(c) { color = c; eraser = false; }
  function setWidth(w) { strokeWidth = w; }
  function setEraser(on) { eraser = !!on; tool = eraser ? 'eraser' : 'brush'; }
  function setTool(t) { tool = t; if (t !== 'shape') svgPreview.style.display = 'none'; if (t === 'eraser') { eraser = true; } else eraser = false; }
  function setShapeType(s) { shapeType = s; }

  /* ---------------------------
   * Event registration
   * ---------------------------
   * Attach pointer events to canvas and window resize for DPR handling.
   */
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', resize);

  // initial sizing on next animation frame so layout is settled
  window.requestAnimationFrame(resize);

  // public API returned to caller — small set of utilities to integrate with UI
  return {
    resize,
    setColor,
    setWidth,
    setEraser,
    doUndo: doUndo,
    doRedo: doRedo,
    setUserMeta(meta = {}) { if (meta.username) username = meta.username; if (meta.color) color = meta.color; },
    setTool,
    setShapeType,
    requestFullState() { ws.send('request-state', {}); }
  };
}
