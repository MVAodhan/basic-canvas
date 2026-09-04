// src/components/ImageCanvas.tsx
import { useEffect, useRef, useState } from 'react';
import { useHotkey, useKeyHold } from '@tanstack/react-hotkeys';
import { ModeToggle } from './mode-toggle';
import { Button } from '#/components/ui/button';
import { Eraser } from './eraser';
import { Arrow } from './arrow';
import { Pen } from './pen';
import { Redo } from './redo';
import { Undo } from './undo';

type Tool = 'brush' | 'eraser' | 'select';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Just a rectangle — used for selections and as the base of Placement
 type Rect = { x: number; y: number; width: number; height: number };

// An image that has been placed but NOT yet committed to the canvas.
// It lives on the overlay canvas until the user applies or cancels.
type Placement = Rect & { img: HTMLImageElement };

const HANDLE_SIZE = 10; // hit area / visual size of the handles, in px
const MIN_SIZE = 10; // don't let the image be dragged inside-out

// --- CUSTOM CURSORS ---
// Built from the same SVG paths as the toolbar icons, so the cursor
// matches the tool. CSS cursors need explicit px dimensions (not 1em),
// and a "hotspot" — the exact point of the glyph that does the work:
// the eraser's edge is its bottom-left corner, the arrow's is its tip.
const svgCursor = (d: string, hotspotX: number, hotspotY: number) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='black' stroke-width='1.5' stroke-linejoin='round' d='${d}'/%3E%3C/svg%3E") ${hotspotX} ${hotspotY}, auto`;

const ARROW_PATH =
  'm13.467 20.154l-3.336-7.185l-3.4 4.743V3.5l11.154 8.77h-5.889l3.293 7.032z';

const ARROW_CURSOR = svgCursor(ARROW_PATH, 3, 3);

// Cap the history: each 800x600 snapshot is ~1.9MB of RGBA bytes,
// so an uncapped history would eat hundreds of MB fast.
const MAX_HISTORY = 30;

export function ImageCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);

  // Tool + brush settings live in state because they're UI (we render them)
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(20);

  // --- ZOOM / VIEWPORT ---
  // The canvas BITMAP stays 800x600 (document pixels). Zoom is pure CSS
  // scaling of the element; all mouse coords are divided back down to
  // document pixels in getCanvasCoords.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom); // wheel handler reads this without re-binding
  zoomRef.current = zoom;
  const viewportRef = useRef<HTMLDivElement>(null); // scrollable pan area
  const contentRef = useRef<HTMLDivElement>(null); // layout-size wrapper
  const scaledRef = useRef<HTMLDivElement>(null); // transformed inner div

  const clampZoom = (z: number) => Math.min(8, Math.max(1, z));

  // Zoom keeping the document point under (clientX, clientY) fixed.
  // The math: content coords = (scroll + cursor offset) / oldZoom.
  // After scaling, scroll is set so that content coord * newZoom lands
  // back under the cursor.
  const setZoomAt = (clientX: number, clientY: number, factor: number) => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const scaled = scaledRef.current;
    if (!viewport || !content || !scaled) return;

    const oldZoom = zoomRef.current;
    const newZoom = clampZoom(oldZoom * factor);
    if (newZoom === oldZoom) return;

    const vpRect = viewport.getBoundingClientRect();
    const contentX = (clientX - vpRect.left + viewport.scrollLeft) / oldZoom;
    const contentY = (clientY - vpRect.top + viewport.scrollTop) / oldZoom;

    // Imperative DOM updates so scroll math and transform agree within
    // this same tick (a setState would apply them a render later).
    // IMPORTANT: the transform goes on the INNER div, the layout size on
    // the WRAPPER. Putting a transform on the wrapper too would scale the
    // content twice (zoom²) while the scroll area only grows by zoom —
    // and then the document's edges can never be scrolled to.
    zoomRef.current = newZoom;
    scaled.style.transform = `scale(${newZoom})`;
    content.style.width = `${800 * newZoom}px`;
    content.style.height = `${600 * newZoom}px`;
    viewport.scrollLeft = contentX * newZoom - (clientX - vpRect.left);
    viewport.scrollTop = contentY * newZoom - (clientY - vpRect.top);

    // Sync React state for the toolbar % display + re-renders
    setZoom(newZoom);
  };

  const setZoomAtCenter = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    setZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  // React's onWheel is a PASSIVE listener — preventDefault() is ignored,
  // so the page would scroll while we zoom. A native listener with
  // passive:false is the workaround.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

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
  const historyRef = useRef<ImageData[]>([]);
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

    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));

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

    // putImageData OVERWRITES pixels (raw copy, ignores composite modes),
    // which is exactly what undo needs.
    ctx.putImageData(snapshot, 0, 0);
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
  // Translates Window Coordinates to Canvas (document) Coordinates.
  // The canvas may be CSS-scaled by zoom, so getBoundingClientRect returns
  // the SCALED rect. Multiplying by (bitmap size / on-screen size) divides
  // the zoom back out — this works at ANY zoom level.
  const getCanvasCoords = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
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
    const { x, y } = getCanvasCoords(event);

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
    const { x, y } = getCanvasCoords(event);

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

  // Pointer-event handlers (React.PointerEvent extends MouseEvent, so the
  // shared helpers like getCanvasCoords work unchanged). Pointer events
  // carry a pointerId, which setPointerCapture needs.
  const handleMouseDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // Pan mode takes priority over every tool
    if (isPanningRef.current) {
      const viewport = viewportRef.current;
      if (viewport) {
        panRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop,
        };
        // POINTER CAPTURE: keep receiving events even when the cursor
        // leaves the canvas. Without this, the drag dies the moment the
        // cursor hits the viewport edge — you could never pan the full
        // way in one gesture when zoomed in (the canvas fills the view).
        (event.target as Element).setPointerCapture?.(event.pointerId);
      }
      return;
    }

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
    // Active pan drag: convert mouse delta into scroll delta.
    // Screen-space deltas (no zoom division) — panning is a view operation.
    const pan = panRef.current;
    if (pan) {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
        viewport.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
      }
      return;
    }

    if (toolRef.current === 'eraser') {
      updateEraserCursor(event);
    }

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
    panRef.current = null; // end any active pan drag

    if (toolRef.current === 'select') {
      handleSelectMouseUp();
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    // The stroke is complete — commit it to history
    pushSnapshot();
  };

  // --- EXPORT ---
  // Exports the active selection region if there is one, otherwise the
  // whole canvas. The crop pattern: draw the source region onto a fresh
  // offscreen canvas sized exactly to the region, then export THAT —
  // toBlob always encodes the entire canvas it's called on.
  const exportCanvas = (format: 'png' | 'jpeg') => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Commit any floating selection first so its pixels are final
    if (selRef.current) commitSelection();

    let source: HTMLCanvasElement = canvas;
    if (selection) {
      // Crop: offscreen canvas = the region, via the 8-arg drawImage
      source = document.createElement('canvas');
      source.width = selection.width;
      source.height = selection.height;
      source
        .getContext('2d')
        ?.drawImage(
          canvas,
          selection.x, selection.y, selection.width, selection.height,
          0, 0, selection.width, selection.height
        );
    }

    // JPEG has no alpha channel — transparent pixels encode as BLACK.
    // Matte the image onto white first so transparency reads as white.
    if (format === 'jpeg') {
      const matted = document.createElement('canvas');
      matted.width = source.width;
      matted.height = source.height;
      const mctx = matted.getContext('2d');
      if (mctx) {
        mctx.fillStyle = '#ffffff';
        mctx.fillRect(0, 0, matted.width, matted.height);
        mctx.drawImage(source, 0, 0);
      }
      source = matted;
    }

    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    source.toBlob((blob) => {
      if (!blob) return;

      // The download dance: object URL + a synthetic <a download> click.
      // Same URL.createObjectURL from image loading, now in reverse.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    }, mime, 0.92);
  };

  // Switching tools commits any in-progress selection, so a brush stroke
  // can never paint underneath a floating region.
  const changeTool = (t: Tool) => {
    if (selRef.current) commitSelection();
    setTool(t);
  };

  // --- PAN MODE (hold Space while zoomed in) ---
  // useKeyHold tracks press-and-hold state for us — no manual keydown/keyup
  // bookkeeping, and it handles repeats/blur edge cases.
  const spaceHeld = useKeyHold('Space');
  const isPanning = spaceHeld && zoom > 1; // nothing to pan at 100%
  const isPanningRef = useRef(isPanning);
  isPanningRef.current = isPanning;

  // While panning, stop Space from doing its browser default (scroll page).
  // TanStack Hotkeys preventDefaults registered hotkeys by default, so an
  // empty handler is all we need — gated on isPanning via `enabled`.
  useHotkey('Space', () => {}, { enabled: isPanning });

  // Active pan drag: start mouse pos + start scroll. Ref-driven like the
  // eraser cursor — scroll writes go straight to the DOM at 60fps.
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  // --- ERASER SIZE CURSOR ---
  // A custom circle that follows the mouse, sized to the eraser radius.
  // Position is written straight to the DOM via ref (60x/sec, no re-render);
  // only visibility uses state (enter/leave — rare).
  const eraserCursorRef = useRef<HTMLDivElement>(null);
  const [eraserCursorVisible, setEraserCursorVisible] = useState(false);

  const updateEraserCursor = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const el = eraserCursorRef.current;
    if (!el) return;
    const { x, y } = getCanvasCoords(event);
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
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
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
        {/* Tool buttons: the selected tool gets the 'secondary' variant as
            its active indicator (aria-pressed also exposes state to a11y). */}
        <Button
          variant={tool === 'brush' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => changeTool('brush')}
          aria-pressed={tool === 'brush'}
          title="Brush"
        >
          <Pen />
        </Button>
        <Button
          variant={tool === 'eraser' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => changeTool('eraser')}
          aria-pressed={tool === 'eraser'}
          title="Eraser"
        >
          <Eraser />
        </Button>
        <Button
          variant={tool === 'select' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => changeTool('select')}
          aria-pressed={tool === 'select'}
          title="Select"
        >
          <Arrow />
        </Button>
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
        <Button onClick={handleClear}>Clear</Button>
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
        {/* Export: selection region if one is active, else full canvas */}
        <Button onClick={() => exportCanvas('png')}>
          {selection ? 'Export Selection' : 'Export PNG'}
        </Button>
        <Button onClick={() => exportCanvas('jpeg')}>Export JPEG</Button>
        <Button onClick={undo} disabled={historyInfo.index <= 0}>
         <Undo/>
        </Button>
        <Button
          onClick={redo}
          disabled={historyInfo.index >= historyInfo.length - 1}
        >
         <Redo/>
        </Button>
        {/* Zoom controls: click the % to reset to 100% */}
        <button onClick={() => setZoomAtCenter(1 / 1.25)}>−</button>
        <button
          onClick={() => setZoomAtCenter(1 / zoomRef.current)}
          title="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoomAtCenter(1.25)}>+</button>
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

      {/* Viewport: the scrollable pan area, pinned to a FIXED size so
          zooming never resizes the page layout — the content just scrolls
          inside the same box. Scrollbars = panning. */}
      <div
        ref={viewportRef}
        style={{
          overflow: 'auto',
          width: 800,
          height: 600,
          maxWidth: '100%',
          // Hide scrollbars — panning is Space+drag now, and the bars
          // visually break the "canvas window" illusion
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // old Edge/IE
          // Chrome/Safari via vendor pseudo-class needs a style tag, so
          // use the Tailwind arbitrary variant instead (className below)
        }}
        className='[&::-webkit-scrollbar]:hidden'
      >
        {/* Layout-size wrapper: its box grows with zoom so the scrollbars
            have something to scroll. transform alone doesn't affect layout. */}
        <div
          ref={contentRef}
          style={{ width: 800 * zoom, height: 600 * zoom }}
        >
          <div
            ref={scaledRef}
            style={{
              position: 'relative',
              width: 800,
              height: 600,
              transform: `scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
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
          // Cursor follows the active tool; eraser hides the native cursor
          // entirely — the custom circle replaces it. Space = grab cursor.
          cursor: isPanning
            ? 'grab'
            : tool === 'eraser'
              ? 'none'
              : tool === 'select'
                ? ARROW_CURSOR
                : 'crosshair',
          // Zoomed in, show the actual bitmap pixels instead of a blur
          imageRendering: zoom > 1 ? 'pixelated' : 'auto',
          display: 'block',
        }}
        onPointerDown={handleMouseDown}
        onPointerMove={handleMouseMove}
        onPointerUp={handleMouseUpOrLeave}
        onPointerEnter={() => setEraserCursorVisible(true)}
        onPointerLeave={() => {
          setEraserCursorVisible(false);
          handleMouseUpOrLeave();
        }}
      />
        {/* Custom eraser cursor: a circle matching the eraser radius.
            Rendered inside the relative container so canvas coords ==
            container coords. pointerEvents:none keeps it click-transparent. */}
        {tool === 'eraser' && (
          <div
            ref={eraserCursorRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: brushSize,
              height: brushSize,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.9)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
              display: eraserCursorVisible ? 'block' : 'none',
            }}
          />
        )}
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
        {tool === 'eraser' && (
          <div
            ref={eraserCursorRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: brushSize,
              height: brushSize,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.9)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
              display: eraserCursorVisible ? 'block' : 'none',
            }}
          />
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
