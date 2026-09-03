// src/components/ImageCanvas.tsx
import { useEffect, useRef, useState } from 'react';
import { ModeToggle } from './mode-toggle';

type Tool = 'brush' | 'eraser' | 'select';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Just a rectangle — used for selections and as the base of Placement
 type Rect = { x: number; y: number; width: number; height: number };

// An image that has been placed but NOT yet committed to the canvas.
// It lives on the overlay canvas until the user applies or cancels.
type Placement = Rect & { img: HTMLImageElement };

const HANDLE_SIZE = 10; // hit area / visual size of the handles, in px
const MIN_SIZE = 10; // don't let the image be dragged inside-out

// A snapshot remembers its dimensions, because the canvas can be resized
// between the snapshot being taken and being restored.
type Snapshot = {
  width: number;
  height: number;
  data: ImageData;
};

// Cap the history: each 800x600 snapshot is ~1.9MB of RGBA bytes,
// so an uncapped history would eat hundreds of MB fast.
const MAX_HISTORY = 30;

export function ImageCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);

  // Tool + brush settings live in state because they're UI (we render them)
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(20);
  const [resizeWidth, setResizeWidth] = useState('800');
  const [resizeHeight, setResizeHeight] = useState('600');

  // --- PLACEMENT (uncommitted loaded image) ---
  const [placement, setPlacement] = useState<Placement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // --- SELECTION (floating region of pixels) ---
  // selection = the CURRENT rect (state, so the overlay redraws).
  // selRef = the heavy pixel data: a copy of the full canvas as it was
  // when the selection was made, and the lifted region pixels.
  const [selection, setSelection] = useState<Rect | null>(null);
  const selRef = useRef<{
    base: HTMLCanvasElement;
    region: HTMLCanvasElement;
    orig: Rect;
  } | null>(null);

  // Everything the drag handlers need, in a ref so mousemove always reads
  // fresh values without re-binding listeners.
  const dragRef = useRef<{
    mode: 'move' | 'marquee' | Handle;
    startX: number;
    startY: number;
    orig: Rect;
  } | null>(null);

  // --- OVERLAY RENDERING ---
  // Draws handle squares + border for any rect (shared by placement
  // and selection).
  const drawHandles = (ctx: CanvasRenderingContext2D, r: Rect) => {
    const hs = HANDLE_SIZE;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const right = r.x + r.width;
    const bottom = r.y + r.height;
    const points: Record<Handle, [number, number]> = {
      nw: [r.x, r.y],
      n: [cx, r.y],
      ne: [right, r.y],
      e: [right, cy],
      se: [right, bottom],
      s: [cx, bottom],
      sw: [r.x, bottom],
      w: [r.x, cy],
    };
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#3b82f6';
    for (const [hx, hy] of Object.values(points)) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2 + 0.5, hy - hs / 2 + 0.5, hs - 1, hs - 1);
    }
  };

  // The overlay is redrawn whenever the placement or selection changes
  // (including every frame of a drag, since dragging updates state).
  const drawOverlay = () => {
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext('2d');
    if (!overlay || !ctx) return;

    // Keep the overlay the same size as the base canvas
    const canvas = canvasRef.current;
    if (canvas && (overlay.width !== canvas.width || overlay.height !== canvas.height)) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (placement) {
      ctx.drawImage(placement.img, placement.x, placement.y, placement.width, placement.height);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.strokeRect(placement.x + 0.5, placement.y + 0.5, placement.width, placement.height);
      drawHandles(ctx, placement);
    }

    if (selection) {
      // Dashed border = the classic "marching ants" (a static version)
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width, selection.height);
      ctx.setLineDash([]);
      drawHandles(ctx, selection);
    }
  };

  useEffect(() => {
    drawOverlay();
  }, [placement, selection]);

  // useRef mirrors of tool/size: the mousemove handler needs the CURRENT
  // value during a stroke, but re-creating the handler each render is fine
  // here since we read them directly. If you move handlers into useEffect
  // later, mirror them in refs to avoid stale closures.
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  toolRef.current = tool;
  brushSizeRef.current = brushSize;

  // --- UNDO / REDO HISTORY ---
  // The history lives in a ref (it changes 60x/sec is irrelevant, but we
  // don't want ImageData blobs in React state). Only the *pointer position*
  // goes in state, so the buttons re-render when undo/redo becomes possible.
  const historyRef = useRef<Snapshot[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyIndexRef = useRef(-1);
  const [historyInfo, setHistoryInfo] = useState({ index: -1, length: 0 });

  const syncHistoryState = () => {
    setHistoryInfo({ index: historyIndexRef.current, length: historyRef.current.length });
  };

  // Reads the current canvas pixels and stores them as a history entry.
  // Called AFTER each completed action (stroke, clear), never mid-stroke.
  const pushSnapshot = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // If we undo 3 times and then draw something new, the "redo" entries
    // after our pointer are now invalid — a real editor truncates them too.
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);

    historyRef.current.push({
      width: canvas.width,
      height: canvas.height,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    });

    // Evict the oldest snapshots when over the cap
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }

    historyIndexRef.current = historyRef.current.length - 1;
    syncHistoryState();
  };

  const undo = () => {
    // Index 0 is the initial blank state, so we can't go below it
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    restoreSnapshot();
  };

  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    restoreSnapshot();
  };

  const restoreSnapshot = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const snapshot = historyRef.current[historyIndexRef.current];
    if (!canvas || !ctx || !snapshot) return;

    if (snapshot.width === canvas.width && snapshot.height === canvas.height) {
      // Same size: putImageData OVERWRITES pixels (raw copy, ignores
      // composite modes), which is exactly what undo needs.
      ctx.putImageData(snapshot.data, 0, 0);
    } else {
      // The canvas was resized since this snapshot. putImageData can't
      // scale, so route it through an offscreen canvas and drawImage
      // (which CAN scale) back onto the current canvas.
      const temp = document.createElement('canvas');
      temp.width = snapshot.width;
      temp.height = snapshot.height;
      temp.getContext('2d')?.putImageData(snapshot.data, 0, 0);

      ctx.reset();
      ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
    }
    syncHistoryState();
  };

  // Capture the initial blank canvas as history entry 0, so the very
  // first stroke can be undone all the way back to empty.
  useEffect(() => {
    pushSnapshot();
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // --- TOOL SETUP ---
  // Call this at the START of every stroke. Why? Because canvas state like
  // globalCompositeOperation and lineWidth "sticks" between strokes.
  // Setting it fresh each stroke guarantees the eraser doesn't leak into
  // the brush and vice versa.
  const setupTool = (ctx: CanvasRenderingContext2D) => {
    ctx.lineWidth = brushSizeRef.current;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (toolRef.current === 'eraser') {
      // destination-out: remove the pixels we draw over (alpha -> 0)
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)'; // color is ignored, only the shape matters
    } else {
      // source-over: normal painting (the default)
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'black';
    }
  };

  // --- HELPER FUNCTION ---
  // Translates Window Coordinates to Canvas Coordinates
  const getCanvasCoords = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y };
  };

  // --- IMAGE LOADING ---
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Turn the File into a URL an <img> can load.
    // createObjectURL is a pointer to the file in memory — cheaper than
    // base64-encoding the whole file like FileReader.readAsDataURL does.
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      // Don't draw yet! Create a placement: the image becomes a floating
      // object on the overlay, scaled to fit if it's bigger than the canvas.
      const scale = Math.min(
        canvas.width / img.width,
        canvas.height / img.height,
        1 // never scale UP on placement — keep natural size when it fits
      );
      const width = img.width * scale;
      const height = img.height * scale;

      setPlacement({
        img,
        x: (canvas.width - width) / 2,
        y: (canvas.height - height) / 2,
        width,
        height,
      });

      // Loading an image is NOT yet an action — nothing has been drawn.
      // The snapshot happens in handleApplyPlacement when pixels change.
      // Release the blob URL — we're done with it
      URL.revokeObjectURL(url);
    };

    img.src = url;

    // Reset the input so selecting the SAME file again still fires onChange
    event.target.value = '';
  };

  // --- IMAGE RESIZE ---
  // Setting canvas.width/height CLEARS the canvas (even to the same value),
  // and also resets all ctx state (composite op, styles). So the pattern is:
  // stash pixels on an offscreen canvas -> resize -> draw them back scaled.
  const handleResize = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const newWidth = Number(resizeWidth);
    const newHeight = Number(resizeHeight);
    if (!newWidth || !newHeight) return;

    // 1. Stash the current pixels on an offscreen canvas.
    //    Yes, you can drawImage a canvas onto another canvas —
    //    a canvas is a valid image source just like an <img>.
    const stash = document.createElement('canvas');
    stash.width = canvas.width;
    stash.height = canvas.height;
    stash.getContext('2d')?.drawImage(canvas, 0, 0);

    // 2. Resize (this wipes the canvas and resets ctx state)
    canvas.width = newWidth;
    canvas.height = newHeight;

    // 3. Draw the stashed pixels back, stretched to fill the new size
    ctx.drawImage(stash, 0, 0, newWidth, newHeight);

    // Resizing is an action — undoable like everything else
    pushSnapshot();
  };

  // --- SHARED DRAG MATH ---
  // Given a drag mode + start point + current point, compute the new rect.
  // Used by BOTH placement (overlay) and selection (base canvas) so the
  // behavior is identical.
  const computeDragRect = (
    mode: 'move' | Handle,
    orig: Rect,
    startX: number,
    startY: number,
    x: number,
    y: number
  ): Rect => {
    const dx = x - startX;
    const dy = y - startY;
    const aspect = orig.width / orig.height;

    if (mode === 'move') {
      return { ...orig, x: orig.x + dx, y: orig.y + dy };
    }

    if (mode === 'n' || mode === 's') {
      // Vertical stretch: top edge moves, bottom stays put (and vice versa)
      const bottom = orig.y + orig.height;
      const newY = mode === 'n' ? Math.min(y, bottom - MIN_SIZE) : orig.y;
      return { ...orig, y: newY, height: bottom - newY };
    }

    if (mode === 'e' || mode === 'w') {
      // Horizontal stretch
      const right = orig.x + orig.width;
      const newX = mode === 'w' ? Math.min(x, right - MIN_SIZE) : orig.x;
      return { ...orig, x: newX, width: right - newX };
    }

    // Corner drag: scale from the OPPOSITE corner (the anchor),
    // keeping the aspect ratio locked.
    const anchorX = mode.includes('w') ? orig.x + orig.width : orig.x;
    const anchorY = mode.includes('n') ? orig.y + orig.height : orig.y;
    const width = Math.max(Math.abs(x - anchorX), MIN_SIZE);
    const height = width / aspect;
    return {
      x: mode.includes('w') ? anchorX - width : anchorX,
      y: mode.includes('n') ? anchorY - height : anchorY,
      width,
      height,
    };
  };

  // --- PLACEMENT INTERACTION ---
  // Hit testing: which handle (if any) is under the mouse?
  const hitTestHandle = (p: Rect, x: number, y: number): Handle | null => {
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    const right = p.x + p.width;
    const bottom = p.y + p.height;
    const points: Record<Handle, [number, number]> = {
      nw: [p.x, p.y],
      n: [cx, p.y],
      ne: [right, p.y],
      e: [right, cy],
      se: [right, bottom],
      s: [cx, bottom],
      sw: [p.x, bottom],
      w: [p.x, cy],
    };
    const half = HANDLE_SIZE / 2 + 2; // +2 = forgiving hit area
    for (const [name, [hx, hy]] of Object.entries(points) as [Handle, [number, number]][]) {
      if (Math.abs(x - hx) <= half && Math.abs(y - hy) <= half) return name;
    }
    return null;
  };

  const handleOverlayMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const p = placement;
    if (!p) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const handle = hitTestHandle(p, x, y);
    const inside =
      x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
    if (!handle && !inside) return;

    dragRef.current = { mode: handle ?? 'move', startX: x, startY: y, orig: { ...p } };
  };

  const handleOverlayMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !placement) return;
    if (drag.mode === 'marquee') return; // overlay never starts marquees
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    setPlacement({
      img: placement.img,
      ...computeDragRect(drag.mode, drag.orig, drag.startX, drag.startY, x, y),
    });
  };

  const handleOverlayMouseUp = () => {
    dragRef.current = null;
  };

  // Apply: bake the placement into the base canvas pixels
  const handleApplyPlacement = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !placement) return;

    ctx.drawImage(placement.img, placement.x, placement.y, placement.width, placement.height);
    pushSnapshot();
    setPlacement(null);
  };

  const handleCancelPlacement = () => {
    setPlacement(null);
  };

  // --- SELECTION INTERACTION ---
  // Redraws the base canvas during a selection transform:
  // full stash, minus the original region, plus the region at its new rect.
  const redrawSelection = (rect: Rect) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const sel = selRef.current;
    if (!canvas || !ctx || !sel) return;

    // IMPORTANT: drawImage with source-over BLENDS, it doesn't replace —
    // transparent source pixels leave the destination untouched. Without
    // this clear, every frame's region copy would survive the "restore"
    // and smear ghosts along the drag path.
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sel.base, 0, 0);
    ctx.clearRect(sel.orig.x, sel.orig.y, sel.orig.width, sel.orig.height);
    ctx.drawImage(sel.region, rect.x, rect.y, rect.width, rect.height);
  };

  // Commit = the base canvas already shows the final pixels, so all that's
  // left is to snapshot history and drop the floating state.
  const commitSelection = () => {
    if (!selRef.current) return;
    pushSnapshot();
    selRef.current = null;
    setSelection(null);
  };

  const cancelSelection = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const sel = selRef.current;
    if (ctx && sel) {
      // Same rule as redrawSelection: clear first, then restore,
      // or the floating region would ghost itself.
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx.drawImage(sel.base, 0, 0);
    }
    selRef.current = null;
    setSelection(null);
  };

  const handleSelectMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(event);

    // Already have a selection? Check for handle/body grabs first.
    if (selection && selRef.current) {
      const handle = hitTestHandle(selection, x, y);
      const inside =
        x >= selection.x && x <= selection.x + selection.width &&
        y >= selection.y && y <= selection.y + selection.height;
      if (handle || inside) {
        dragRef.current = { mode: handle ?? 'move', startX: x, startY: y, orig: { ...selection } };
        return;
      }
      // Clicked outside: commit the current transform, start a new marquee
      commitSelection();
    }

    dragRef.current = { mode: 'marquee', startX: x, startY: y, orig: { x, y, width: 0, height: 0 } };
    setSelection({ x, y, width: 0, height: 0 });
  };

  const handleSelectMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = getCanvasCoords(event);

    if (drag.mode === 'marquee') {
      // Normalize: rect from drag-start to current point, whichever corner
      setSelection({
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        width: Math.abs(x - drag.startX),
        height: Math.abs(y - drag.startY),
      });
      return;
    }

    const rect = computeDragRect(drag.mode, drag.orig, drag.startX, drag.startY, x, y);
    setSelection(rect);
    redrawSelection(rect);
  };

  const handleSelectMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.mode !== 'marquee') return; // transform drag — nothing to do

    // Marquee finished. Tiny rect = a click, ignore it.
    if (!selection || selection.width < 3 || selection.height < 3) {
      setSelection(null);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // "Lift" the pixels: stash the full canvas, copy the region out.
    const base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    base.getContext('2d')?.drawImage(canvas, 0, 0);

    const region = document.createElement('canvas');
    region.width = selection.width;
    region.height = selection.height;
    // The 8-arg drawImage: source rect -> dest rect. Here 1:1.
    region
      .getContext('2d')
      ?.drawImage(canvas, selection.x, selection.y, selection.width, selection.height, 0, 0, selection.width, selection.height);

    selRef.current = { base, region, orig: { ...selection } };
    redrawSelection(selection);
  };

  // --- EVENT HANDLERS ---

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // Select tool takes over the base canvas events entirely
    if (toolRef.current === 'select') {
      handleSelectMouseDown(event);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCanvasCoords(event);

    setupTool(ctx);
    ctx.beginPath();
    ctx.moveTo(x, y);
    isDrawingRef.current = true;
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (toolRef.current === 'select') {
      handleSelectMouseMove(event);
      return;
    }

    if (!isDrawingRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCanvasCoords(event);

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleMouseUpOrLeave = () => {
    if (toolRef.current === 'select') {
      handleSelectMouseUp();
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    // The stroke is complete — commit it to history
    pushSnapshot();
  };

  // Switching tools commits any in-progress selection, so a brush stroke
  // can never paint underneath a floating region.
  const changeTool = (t: Tool) => {
    if (selRef.current) commitSelection();
    setTool(t);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    ctx?.reset();
    // Clearing is an action too — make it undoable
    pushSnapshot();
  };

  return (
    <div>
      <div className='flex items-center justify-between'>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <button onClick={() => changeTool('brush')} disabled={tool === 'brush'}>
          Brush
        </button>
        <button onClick={() => setTool('eraser')} disabled={tool === 'eraser'}>
          Eraser
        </button>
        <button onClick={() => changeTool('select')} disabled={tool === 'select'}>
          Select
        </button>
        <label>
          Size: {brushSize}
          <input
            type="range"
            min={1}
            max={100}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </label>
        <button onClick={handleClear}>Clear</button>
        {/* The input is visually hidden; the button triggers it.
            This gives us a styled button with native file-picking. */}
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          style={{ display: 'none' }}
          ref={fileInputRef}
        />
        <button onClick={() => fileInputRef.current?.click()}>Load Image</button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            value={resizeWidth}
            onChange={(e) => setResizeWidth(e.target.value)}
            style={{ width: 64 }}
          />
          ×
          <input
            type="number"
            value={resizeHeight}
            onChange={(e) => setResizeHeight(e.target.value)}
            style={{ width: 64 }}
          />
          <button onClick={handleResize}>Resize</button>
        </span>
        <button onClick={undo} disabled={historyInfo.index <= 0}>
          Undo
        </button>
        <button
          onClick={redo}
          disabled={historyInfo.index >= historyInfo.length - 1}
        >
          Redo
        </button>
      </div>
        <ModeToggle/>
      </div>

      {placement && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <button onClick={handleApplyPlacement}>Apply Image</button>
          <button onClick={handleCancelPlacement}>Cancel</button>
          <span style={{ alignSelf: 'center', color: '#888', fontSize: 13 }}>
            Drag to move · corners scale · edges stretch
          </span>
        </div>
      )}

      {selection && !placement && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <button onClick={commitSelection}>Apply Selection</button>
          <button onClick={cancelSelection}>Cancel</button>
          <span style={{ alignSelf: 'center', color: '#888', fontSize: 13 }}>
            Drag inside to move · handles to resize · click outside to apply
          </span>
        </div>
      )}

      <div style={{ position: 'relative', width: 'fit-content' }}>
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
        style={{

          // Checkerboard = the universal "this area is transparent" pattern.
          // The canvas itself is transparent; this is just what shows through.
          backgroundColor: '#262626',
          backgroundImage:
            'linear-gradient(45deg, #2e2e2e 25%, transparent 25%), linear-gradient(-45deg, #2e2e2e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2e2e2e 75%), linear-gradient(-45deg, transparent 75%, #2e2e2e 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          cursor: 'crosshair',
          display: 'block',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
      />
        {/* Overlay canvas: sits exactly on top of the base canvas.
            During placement it captures the mouse (blocking drawing).
            During selection it's pointer-transparent so the base canvas
            keeps receiving the marquee/transform events. */}
        {(placement || selection) && (
          <canvas
            ref={overlayRef}
            width={800}
            height={600}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              cursor: 'move',
              pointerEvents: placement ? 'auto' : 'none',
            }}
            onMouseDown={handleOverlayMouseDown}
            onMouseMove={handleOverlayMouseMove}
            onMouseUp={handleOverlayMouseUp}
            onMouseLeave={handleOverlayMouseUp}
          />
        )}
      </div>
    </div>
  );
}
