// src/components/ImageCanvas.tsx
import { useEffect, useRef, useState } from 'react';
import { useHotkey, useKeyHold } from '@tanstack/react-hotkeys';
import { Button } from '#/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '#/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip';
import { Eraser } from './eraser';
import { Arrow } from './arrow';
import { Pen } from './pen';
import { Redo } from './redo';
import { Undo } from './undo';
import { Minus } from './minus';
import { Plus } from './plus';
import { Trash } from './trash';
import { Load } from './load';
import { ExportMenu } from './export-menu';
import { ColorPickerMenu } from './color-picker-menu';
import { StickerizeMenu } from './stickerize-menu';
import { LayersPanel, type Layer, type LayerKind } from './LayersPanel';
import { Layers as LayersIcon, Lasso } from 'lucide-react';

type Tool = 'brush' | 'eraser' | 'select' | 'polyline';

type Point = { x: number; y: number };

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

// CSS cursor per transform handle: corners resize diagonally, edges
// resize along one axis. Direction matches which corner/edge you grabbed.
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

// Cap the history: every snapshot clones EVERY layer's pixels
// (~1.9MB per 800x600 layer), so deep history × many layers eats memory
// fast. 10 entries × a few layers is a reasonable learning-app budget.
const MAX_HISTORY = 10;

export function ImageCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);

  // Tool + brush settings live in state because they're UI (we render them)
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(20);
  const [brushColor, setBrushColor] = useState('#000000');

  // --- LAYERS ---
  // Each layer owns an OFFSCREEN canvas with its own pixels. The main
  // canvas is a COMPOSITE: cleared and redrawn from all visible layers
  // whenever anything changes. Painting targets the ACTIVE layer's
  // offscreen canvas, never the main canvas directly.
  const [layers, setLayers] = useState<Layer[]>([]);
  const layersRef = useRef<Layer[]>([]); // handlers read fresh data
  layersRef.current = layers;
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const activeLayerIdRef = useRef<string | null>(null);
  activeLayerIdRef.current = activeLayerId;
  // Bumped after any pixel change so layer thumbnails re-render
  const [layersVersion, setLayersVersion] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);

  const makeLayer = (name: string, kind: LayerKind): Layer => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    return {
      id: Math.random().toString(36).slice(2),
      name,
      kind,
      visible: true,
      locked: false,
      canvas,
    };
  };

  // The layer painting operations target. Falls back to the top layer.
  const activeLayer = (): Layer | null => {
    const list = layersRef.current;
    return (
      list.find((l) => l.id === activeLayerIdRef.current) ??
      list[list.length - 1] ??
      null
    );
  };

  // Redraw the main canvas from the layer stack, bottom to top.
  // This is the ONLY thing that ever paints to the main canvas.
  const composite = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of layersRef.current) {
      if (!layer.visible) continue;
      // Sticker stroke first (it grows OUTWARD from the pixels, so the
      // layer's own pixels must paint on top of it)
      if (layer.stroke) ctx.drawImage(layer.stroke.canvas, 0, 0);
      ctx.drawImage(layer.canvas, 0, 0);
    }

    // Bump so layer thumbnails re-render with the new pixels
    setLayersVersion((v) => v + 1);
  };

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
    layerId: string; // the layer the pixels were lifted from
    isImageSelect: boolean; // true = created by one-click image selection
    // When the lifted layer has a stickerize stroke, its pixels ride along
    // (same rects as base/region) so transforms move stroke + content
    // together instead of leaving the stroke behind.
    strokeBase?: HTMLCanvasElement;
    strokeRegion?: HTMLCanvasElement;
    // Polygon selections (polyline tool): the vertices in DOCUMENT coords
    // at lift time. `selection` stays the bounding box that the existing
    // rect machinery moves around; the ants are drawn from these points
    // translated by (selection - orig).
    polygon?: Point[];
  } | null>(null);

  // Canvas right-click menu. CONTROLLED, and gated on `selection` — the
  // menu content can't just mount/unmount on `selection` alone, because
  // Base UI's root keeps its own `open` flag: if the content unmounts
  // while open (delete, click-away), the flag never resets, and the next
  // selection would pop the menu open with no right-click at all.
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);

  // --- POLYLINE (point-to-point polygon lasso) ---
  // In-progress vertices, in document coords. The rubber band to the
  // cursor is drawn imperatively on the overlay (polyCursorRef) so mouse
  // moves don't round-trip through React state.
  const [polyPoints, setPolyPoints] = useState<Point[] | null>(null);
  const polyCursorRef = useRef<Point | null>(null);

  // Polyline keyboard: Enter closes the polygon, Escape cancels. Bound
  // only while a polygon is in progress (the effect re-runs per change,
  // so the closures always see the current points).
  useEffect(() => {
    if (!polyPoints) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPolyPoints(null);
        polyCursorRef.current = null;
      } else if (e.key === 'Enter') {
        completePolygon();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [polyPoints]);

  // --- STICKERIZE ---
  // The stroke lives on the LAYER (layer.stroke), not in a side map: it
  // can't be corrupted by edits, so "Remove stroke" always strips ALL of
  // it and re-stickerizing never stacks widths (each run recomputes from
  // the layer's current pixels).

  // Hover-aware cursors: the overlay (placement) and base canvas
  // (selection) switch their cursor based on what's under the pointer —
  // resize arrows near handles, move arrow over the body.
  const [placementCursor, setPlacementCursor] = useState('move');
  const [canvasCursor, setCanvasCursor] = useState<string | null>(null);

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
      // Dashed border = the classic "marching ants" (a static version).
      // Polygon selections draw their outline instead of the bbox rect —
      // the bbox would misrepresent what's actually selected.
      const poly = displayedPolyPoints();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      if (poly) {
        ctx.beginPath();
        poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width, selection.height);
        drawHandles(ctx, selection);
      }
      ctx.setLineDash([]);
    }

    // In-progress polyline: committed segments + rubber band to the cursor.
    // The first vertex gets a marker — larger once the polygon can close.
    if (polyPoints && polyPoints.length > 0) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(polyPoints[0].x, polyPoints[0].y);
      for (let i = 1; i < polyPoints.length; i++) ctx.lineTo(polyPoints[i].x, polyPoints[i].y);
      const cursor = polyCursorRef.current;
      if (cursor) ctx.lineTo(cursor.x, cursor.y);
      ctx.stroke();
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(polyPoints[0].x, polyPoints[0].y, polyPoints.length >= 3 ? 4 : 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  };

  useEffect(() => {
    drawOverlay();
  }, [placement, selection, polyPoints]);

  // useRef mirrors of tool/size: the mousemove handler needs the CURRENT
  // value during a stroke, but re-creating the handler each render is fine
  // here since we read them directly. If you move handlers into useEffect
  // later, mirror them in refs to avoid stale closures.
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  const brushColorRef = useRef(brushColor);
  toolRef.current = tool;
  brushSizeRef.current = brushSize;
  brushColorRef.current = brushColor;

  // --- UNDO / REDO HISTORY ---
  // A snapshot captures the WHOLE layer stack: each layer's pixels
  // (ImageData) plus the structure (ids, names, visibility) and which
  // layer was active. That way undo works for paint, layer creation,
  // deletion, and visibility toggles alike.
  type LayerSnapshot = {
    id: string;
    name: string;
    kind: LayerKind;
    visible: boolean;
    locked: boolean;
    bounds?: Rect;
    data: ImageData;
    // Sticker stroke pixels + width (absent = no stroke). Part of the
    // snapshot so undo/redo restores stickerized layers exactly.
    stroke?: { width: number; data: ImageData };
  };
  type Snapshot = { layers: LayerSnapshot[]; activeId: string | null };

  const historyRef = useRef<Snapshot[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyIndexRef = useRef(-1);
  const [historyInfo, setHistoryInfo] = useState({ index: -1, length: 0 });

  const syncHistoryState = () => {
    setHistoryInfo({ index: historyIndexRef.current, length: historyRef.current.length });
  };

  // Reads every layer's pixels and stores them as a history entry.
  // Called AFTER each completed action (stroke, clear, layer op),
  // never mid-stroke.
  const pushSnapshot = () => {
    // If we undo 3 times and then draw something new, the "redo" entries
    // after our pointer are now invalid — a real editor truncates them too.
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);

    historyRef.current.push({
      activeId: activeLayerIdRef.current,
      layers: layersRef.current.map((layer) => {
        const lctx = layer.canvas.getContext('2d');
        const sctx = layer.stroke?.canvas.getContext('2d');
        return {
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          visible: layer.visible,
          locked: layer.locked,
          bounds: layer.bounds,
          data: lctx!.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
          stroke: layer.stroke
            ? {
                width: layer.stroke.width,
                data: sctx!.getImageData(
                  0,
                  0,
                  layer.stroke.canvas.width,
                  layer.stroke.canvas.height
                ),
              }
            : undefined,
        };
      }),
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
    const snapshot = historyRef.current[historyIndexRef.current];
    if (!snapshot) return;

    // Rebuild each layer's offscreen canvas from the stored pixels.
    // Fresh canvases (not reused ones) keep this dead simple — structure
    // AND pixels both come from the snapshot.
    const restored: Layer[] = snapshot.layers.map((s) => {
      const canvas = document.createElement('canvas');
      canvas.width = s.data.width;
      canvas.height = s.data.height;
      canvas.getContext('2d')?.putImageData(s.data, 0, 0);

      // Rebuild the sticker stroke, if this snapshot had one
      let stroke: Layer['stroke'];
      if (s.stroke) {
        const strokeCanvas = document.createElement('canvas');
        strokeCanvas.width = s.stroke.data.width;
        strokeCanvas.height = s.stroke.data.height;
        strokeCanvas.getContext('2d')?.putImageData(s.stroke.data, 0, 0);
        stroke = { width: s.stroke.width, canvas: strokeCanvas };
      }

      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        visible: s.visible,
        locked: s.locked,
        bounds: s.bounds,
        stroke,
        canvas,
      };
    });

    layersRef.current = restored;
    setLayers(restored);
    setActiveLayerId(snapshot.activeId);
    composite();
    syncHistoryState();
  };

  // Create the initial Background layer + capture it as history entry 0,
  // so the very first action can be undone all the way back to empty.
  useEffect(() => {
    if (layersRef.current.length === 0) {
      const bg = makeLayer('Background', 'Paint');
      layersRef.current = [bg];
      setLayers([bg]);
      setActiveLayerId(bg.id);
    }
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
      ctx.strokeStyle = brushColorRef.current;
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
    // Same rule as the base canvas: only the main button drags
    if (event.button !== 0) return;
    const p = placement;
    if (!p) return;
    const { x, y } = getCanvasCoords(event);

    const handle = hitTestHandle(p, x, y);
    const inside =
      x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
    if (!handle && !inside) return;

    // Lock in the cursor for the whole drag, even outside the handle
    setPlacementCursor(handle ? HANDLE_CURSOR[handle] : 'move');

    dragRef.current = { mode: handle ?? 'move', startX: x, startY: y, orig: { ...p } };
  };

  const handleOverlayMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !placement) return;
    if (drag.mode === 'marquee') return; // overlay never starts marquees
    const { x, y } = getCanvasCoords(event);

    // While dragging, keep the cursor of the handle being dragged
    setPlacementCursor(drag.mode === 'move' ? 'move' : HANDLE_CURSOR[drag.mode]);

    setPlacement({
      img: placement.img,
      ...computeDragRect(drag.mode, drag.orig, drag.startX, drag.startY, x, y),
    });
  };

  const handleOverlayHover = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // Not dragging: point feedback — cursor reflects what's under the pointer
    if (!placement) return;
    const { x, y } = getCanvasCoords(event);
    const handle = hitTestHandle(placement, x, y);
    const inside =
      x >= placement.x && x <= placement.x + placement.width &&
      y >= placement.y && y <= placement.y + placement.height;
    setPlacementCursor(handle ? HANDLE_CURSOR[handle] : inside ? 'move' : 'default');
  };

  const handleOverlayMouseUp = () => {
    dragRef.current = null;
  };

  // Apply: the placement becomes a NEW layer (like Pixlr — opening an
  // image never destroys existing pixels), and it becomes the active one.
  // The placement rect is remembered as the layer's BOUNDS — that's what
  // makes one-click selection of the image possible later.
  const handleApplyPlacement = () => {
    if (!placement) return;

    const layer: Layer = {
      ...makeLayer('Image', 'Image'),
      bounds: {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      },
    };
    const lctx = layer.canvas.getContext('2d');
    lctx?.drawImage(placement.img, placement.x, placement.y, placement.width, placement.height);

    const next = [...layersRef.current, layer];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(layer.id);

    composite();
    pushSnapshot();
    setPlacement(null);
  };

  const handleCancelPlacement = () => {
    setPlacement(null);
  };

  // --- SELECTION INTERACTION ---
  // Selections are PER-LAYER: pixels are lifted from the layer that was
  // active when the marquee closed, and transforms rewrite that layer's
  // canvas. The composite then shows lower layers through the hole.
  const selTargetLayer = (): Layer | null =>
    layersRef.current.find((l) => l.id === selRef.current?.layerId) ?? null;

  // Polygon selections: the vertices as they sit NOW (lift points + however
  // far the bbox has been dragged). Null for rect selections.
  const displayedPolyPoints = (): Point[] | null => {
    const sel = selRef.current;
    if (!sel?.polygon || !selection) return null;
    const dx = selection.x - sel.orig.x;
    const dy = selection.y - sel.orig.y;
    return sel.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  };

  // Even-odd ray casting: is (x, y) inside the polygon?
  const pointInPolygon = (pts: Point[], x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  };

  // Erase EXACTLY a polygon shape (destination-out fill). Used anywhere a
  // polygon-shaped hole is needed: the lift (redrawSelection) and delete.
  // Erasing the bbox instead would wipe everything between the polygon
  // and its box — pixels the user never selected.
  const erasePolygonShape = (ctx: CanvasRenderingContext2D, pts: Point[]) => {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000'; // color ignored; only the shape matters
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  };

  // --- ONE-CLICK IMAGE SELECT ---
  // Topmost-first hit test over visible, unlocked Image layers: the click
  // must be inside the layer's bounds AND on an opaque pixel (transparent
  // areas of an image let clicks fall through to layers below).
  const findImageLayerAt = (x: number, y: number): Layer | null => {
    const list = layersRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const layer = list[i];
      if (!layer.visible || layer.locked || layer.kind !== 'Image' || !layer.bounds) continue;
      const b = layer.bounds;
      if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) continue;

      // Sample the actual pixel — bounds alone would catch transparent
      // holes. The sticker stroke counts too: it's visually part of the
      // sticker, so clicking it should select the image.
      const alpha =
        layer.canvas.getContext('2d')?.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] ?? 0;
      const strokeAlpha = layer.stroke
        ? layer.stroke.canvas.getContext('2d')?.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] ?? 0
        : 0;
      if (alpha > 0 || strokeAlpha > 0) return layer;
    }
    return null;
  };

  // Select an image layer with ONE click: lift its stored bounds as a
  // floating selection so the existing move/resize machinery takes over.
  const selectImageLayer = (layer: Layer) => {
    const bounds = layer.bounds!;

    const base = document.createElement('canvas');
    base.width = layer.canvas.width;
    base.height = layer.canvas.height;
    base.getContext('2d')?.drawImage(layer.canvas, 0, 0);

    const region = document.createElement('canvas');
    region.width = bounds.width;
    region.height = bounds.height;
    region
      .getContext('2d')
      ?.drawImage(layer.canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

    // Stickerized layer: lift the stroke with the same rects so transforms
    // move stroke + content as one
    let strokeBase: HTMLCanvasElement | undefined;
    let strokeRegion: HTMLCanvasElement | undefined;
    if (layer.stroke) {
      strokeBase = document.createElement('canvas');
      strokeBase.width = layer.stroke.canvas.width;
      strokeBase.height = layer.stroke.canvas.height;
      strokeBase.getContext('2d')?.drawImage(layer.stroke.canvas, 0, 0);

      strokeRegion = document.createElement('canvas');
      strokeRegion.width = bounds.width;
      strokeRegion.height = bounds.height;
      strokeRegion
        .getContext('2d')
        ?.drawImage(layer.stroke.canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    }

    selRef.current = {
      base,
      region,
      orig: { ...bounds },
      layerId: layer.id,
      isImageSelect: true,
      strokeBase,
      strokeRegion,
    };
    // Clicking an image also activates its layer (paint would target it)
    setActiveLayerId(layer.id);
    setSelection({ ...bounds });
  };

  // --- POLYLINE (point-to-point polygon lasso) ---
  // Click adds a vertex; clicking near the first vertex (or pressing Enter)
  // closes the polygon and lifts it as a floating selection. Escape cancels.
  const handlePolylineMouseDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const layer = activeLayer();
    if (!layer || layer.locked) return;
    const { x, y } = getCanvasCoords(event);

    if (!polyPoints) {
      setPolyPoints([{ x, y }]);
      polyCursorRef.current = { x, y };
      return;
    }

    // Click near the first vertex with a closeable polygon = close it
    if (polyPoints.length >= 3) {
      const first = polyPoints[0];
      if (Math.hypot(x - first.x, y - first.y) <= 8) {
        completePolygon();
        return;
      }
    }
    setPolyPoints([...polyPoints, { x, y }]);
  };

  // Close the polygon: lift the pixels inside it as a floating selection.
  // The region is the polygon's bbox crop MASKED to the polygon shape
  // ('destination-in' keeps only pixels inside the path) — so the existing
  // rect machinery (redrawSelection's stash-lift-drop) automatically leaves
  // a polygon-shaped hole in the layer and moves polygon-shaped pixels.
  const completePolygon = () => {
    const layer = activeLayer();
    if (!layer || layer.locked || !polyPoints || polyPoints.length < 3) {
      setPolyPoints(null); // too few points — just discard
      return;
    }

    const xs = polyPoints.map((p) => p.x);
    const ys = polyPoints.map((p) => p.y);
    const rect: Rect = {
      x: Math.floor(Math.min(...xs)),
      y: Math.floor(Math.min(...ys)),
      width: 0,
      height: 0,
    };
    rect.width = Math.ceil(Math.max(...xs)) - rect.x;
    rect.height = Math.ceil(Math.max(...ys)) - rect.y;

    // Mask a canvas to the polygon (coords relative to the bbox)
    const maskWithPolygon = (target: HTMLCanvasElement) => {
      const tctx = target.getContext('2d');
      if (!tctx) return;
      tctx.globalCompositeOperation = 'destination-in';
      tctx.fillStyle = '#000'; // color ignored; only the shape matters
      tctx.beginPath();
      polyPoints.forEach((p, i) =>
        i === 0 ? tctx.moveTo(p.x - rect.x, p.y - rect.y) : tctx.lineTo(p.x - rect.x, p.y - rect.y)
      );
      tctx.closePath();
      tctx.fill();
      tctx.globalCompositeOperation = 'source-over';
    };

    const base = document.createElement('canvas');
    base.width = layer.canvas.width;
    base.height = layer.canvas.height;
    base.getContext('2d')?.drawImage(layer.canvas, 0, 0);

    const region = document.createElement('canvas');
    region.width = rect.width;
    region.height = rect.height;
    region
      .getContext('2d')
      ?.drawImage(layer.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    maskWithPolygon(region);

    // Stroke ride-along: same rects, same polygon mask
    let strokeBase: HTMLCanvasElement | undefined;
    let strokeRegion: HTMLCanvasElement | undefined;
    if (layer.stroke) {
      strokeBase = document.createElement('canvas');
      strokeBase.width = layer.stroke.canvas.width;
      strokeBase.height = layer.stroke.canvas.height;
      strokeBase.getContext('2d')?.drawImage(layer.stroke.canvas, 0, 0);

      strokeRegion = document.createElement('canvas');
      strokeRegion.width = rect.width;
      strokeRegion.height = rect.height;
      strokeRegion
        .getContext('2d')
        ?.drawImage(layer.stroke.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      maskWithPolygon(strokeRegion);
    }

    selRef.current = {
      base,
      region,
      orig: rect,
      layerId: layer.id,
      isImageSelect: false,
      polygon: polyPoints.map((p) => ({ ...p })),
      strokeBase,
      strokeRegion,
    };
    setPolyPoints(null);
    polyCursorRef.current = null;
    setSelection(rect);
    // Lifts the pixels: stash - bbox + masked region back in place
    redrawSelection(rect);
  };

  // Redraws the source layer during a selection transform:
  // full stash, minus the original region, plus the region at its new rect.
  const redrawSelection = (rect: Rect) => {
    const layer = selTargetLayer();
    const lctx = layer?.canvas.getContext('2d');
    const sel = selRef.current;
    if (!layer || !lctx || !sel) return;

    // IMPORTANT: drawImage with source-over BLENDS, it doesn't replace —
    // transparent source pixels leave the destination untouched. Without
    // this clear, every frame's region copy would survive the "restore"
    // and smear ghosts along the drag path.
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    lctx.drawImage(sel.base, 0, 0);
    // The hole is the LIFTED shape at its original position — for polygons
    // that's the polygon itself, NOT its bbox (the bbox would also wipe
    // the unselected pixels between the shape and its box)
    if (sel.polygon) {
      erasePolygonShape(lctx, sel.polygon);
    } else {
      lctx.clearRect(sel.orig.x, sel.orig.y, sel.orig.width, sel.orig.height);
    }
    lctx.drawImage(sel.region, rect.x, rect.y, rect.width, rect.height);

    // The stroke rides along: identical rewrite (stash, lift, drop) so
    // stroke and pixels stay aligned during and after the transform
    const sctx = layer.stroke?.canvas.getContext('2d');
    if (layer.stroke && sctx && sel.strokeBase && sel.strokeRegion) {
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, layer.stroke.canvas.width, layer.stroke.canvas.height);
      sctx.drawImage(sel.strokeBase, 0, 0);
      if (sel.polygon) {
        erasePolygonShape(sctx, sel.polygon);
      } else {
        sctx.clearRect(sel.orig.x, sel.orig.y, sel.orig.width, sel.orig.height);
      }
      sctx.drawImage(sel.strokeRegion, rect.x, rect.y, rect.width, rect.height);
    }

    composite();
  };

  // Commit = the base canvas already shows the final pixels, so all that's
  // left is to snapshot history and drop the floating state.
  const commitSelection = () => {
    if (!selRef.current) return;

    // One-click image selections OWN the layer's bounds: after a
    // move/resize, snap the stored bounds to the final rect so the next
    // click re-selects the image where it is NOW. Marquee selections
    // don't touch bounds — they moved an arbitrary region, not the image.
    const layer = selTargetLayer();
    if (layer && selRef.current.isImageSelect && selection) {
      const next = layersRef.current.map((l) =>
        l.id === layer.id ? { ...l, bounds: { ...selection } } : l
      );
      layersRef.current = next;
      setLayers(next);
    }

    pushSnapshot();
    selRef.current = null;
    setSelection(null);
  };

  const cancelSelection = () => {
    const layer = selTargetLayer();
    const lctx = layer?.canvas.getContext('2d');
    const sel = selRef.current;
    if (lctx && sel) {
      // Same rule as redrawSelection: clear first, then restore,
      // or the floating region would ghost itself.
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, layer!.canvas.width, layer!.canvas.height);
      lctx.drawImage(sel.base, 0, 0);
      // Stroke too, if one was lifted with the selection
      const sctx = layer!.stroke?.canvas.getContext('2d');
      if (layer!.stroke && sctx && sel.strokeBase) {
        sctx.globalCompositeOperation = 'source-over';
        sctx.clearRect(0, 0, layer!.stroke.canvas.width, layer!.stroke.canvas.height);
        sctx.drawImage(sel.strokeBase, 0, 0);
      }
      composite();
    }
    selRef.current = null;
    setSelection(null);
  };

  const handleSelectMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(event);

    // Already have a selection? Check for handle/body grabs first.
    if (selection && selRef.current) {
      const poly = displayedPolyPoints();
      if (poly) {
        // Polygon selections move but don't resize — no handles to hit
        if (pointInPolygon(poly, x, y)) {
          dragRef.current = { mode: 'move', startX: x, startY: y, orig: { ...selection } };
          return;
        }
        // Clicked outside: commit the current transform, then re-target
        commitSelection();
      } else {
        const handle = hitTestHandle(selection, x, y);
        const inside =
          x >= selection.x && x <= selection.x + selection.width &&
          y >= selection.y && y <= selection.y + selection.height;
        if (handle || inside) {
          dragRef.current = { mode: handle ?? 'move', startX: x, startY: y, orig: { ...selection } };
          return;
        }
        // Clicked outside: commit the current transform, then re-target
        commitSelection();
      }
    }

    // ONE-CLICK IMAGE SELECT: clicking an image grabs the whole image —
    // no marquee needed. Marquee is only for custom regions.
    const hitLayer = findImageLayerAt(x, y);
    if (hitLayer) {
      selectImageLayer(hitLayer);
      return;
    }

    // Marquee on the active layer (locked layers refuse)
    if (activeLayer()?.locked) return;
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

    const layer = activeLayer();
    if (!layer) return;
    const lctx = layer.canvas.getContext('2d');
    if (!lctx) return;

    // "Lift" the pixels: stash the full LAYER, copy the region out.
    const base = document.createElement('canvas');
    base.width = layer.canvas.width;
    base.height = layer.canvas.height;
    base.getContext('2d')?.drawImage(layer.canvas, 0, 0);

    const region = document.createElement('canvas');
    region.width = selection.width;
    region.height = selection.height;
    // The 8-arg drawImage: source rect -> dest rect. Here 1:1.
    region
      .getContext('2d')
      ?.drawImage(layer.canvas, selection.x, selection.y, selection.width, selection.height, 0, 0, selection.width, selection.height);

    // Stickerized layer: lift the stroke within the marquee too, so the
    // transform moves stroke + pixels together
    let strokeBase: HTMLCanvasElement | undefined;
    let strokeRegion: HTMLCanvasElement | undefined;
    if (layer.stroke) {
      strokeBase = document.createElement('canvas');
      strokeBase.width = layer.stroke.canvas.width;
      strokeBase.height = layer.stroke.canvas.height;
      strokeBase.getContext('2d')?.drawImage(layer.stroke.canvas, 0, 0);

      strokeRegion = document.createElement('canvas');
      strokeRegion.width = selection.width;
      strokeRegion.height = selection.height;
      strokeRegion
        .getContext('2d')
        ?.drawImage(layer.stroke.canvas, selection.x, selection.y, selection.width, selection.height, 0, 0, selection.width, selection.height);
    }

    selRef.current = { base, region, orig: { ...selection }, layerId: layer.id, isImageSelect: false, strokeBase, strokeRegion };
    redrawSelection(selection);
  };

  // --- EVENT HANDLERS ---

  // Pointer-event handlers (React.PointerEvent extends MouseEvent, so the
  // shared helpers like getCanvasCoords work unchanged). Pointer events
  // carry a pointerId, which setPointerCapture needs.
  const handleMouseDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // Only the MAIN button starts tools. Right-click must fall through to
    // the context menu — a pointerdown here would start a marquee that
    // commits as a tiny "click" selection on pointerup, wiping the
    // existing selection right before the menu opens.
    if (event.button !== 0) return;
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

    // Polyline tool: clicks add vertices (see handlePolylineMouseDown)
    if (toolRef.current === 'polyline') {
      handlePolylineMouseDown(event);
      return;
    }

    // Paint on the ACTIVE layer's offscreen canvas — never the main canvas.
    // Locked layers refuse edits (that's the whole point of the lock).
    const layer = activeLayer();
    if (!layer || layer.locked) return;
    const ctx = layer.canvas.getContext('2d');
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

    if (toolRef.current === 'brush' || toolRef.current === 'eraser') {
      updateEraserCursor(event);
    }

    if (toolRef.current === 'select') {
      // Hover feedback over selection handles/body (only when not dragging)
      if (!dragRef.current) {
        if (selection) {
          const { x, y } = getCanvasCoords(event);
          const poly = displayedPolyPoints();
          if (poly) {
            // Polygon selections have no resize handles — just move
            setCanvasCursor(pointInPolygon(poly, x, y) ? 'move' : ARROW_CURSOR);
          } else {
            const handle = hitTestHandle(selection, x, y);
            const inside =
              x >= selection.x && x <= selection.x + selection.width &&
              y >= selection.y && y <= selection.y + selection.height;
            setCanvasCursor(handle ? HANDLE_CURSOR[handle] : inside ? 'move' : ARROW_CURSOR);
          }
        } else {
          // Hovering an image with the select tool = it's one click away
          // from being selected — advertise that with the move cursor
          const { x, y } = getCanvasCoords(event);
          setCanvasCursor(findImageLayerAt(x, y) ? 'move' : null);
        }
      }
      handleSelectMouseMove(event);
      return;
    }

    // Polyline tool: track the cursor for the rubber band. This redraws
    // the overlay IMPERATIVELY — per-move state updates would re-render
    // the whole component 60fps (see hybrid-pattern gotchas).
    if (toolRef.current === 'polyline') {
      const { x, y } = getCanvasCoords(event);
      polyCursorRef.current = { x, y };
      drawOverlay();
      return;
    }

    if (!isDrawingRef.current) return;

    const layer = activeLayer();
    if (!layer) return;
    const ctx = layer.canvas.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCanvasCoords(event);

    ctx.lineTo(x, y);
    ctx.stroke();

    // Recomposite: the main canvas always mirrors the layer stack
    composite();
  };

  const handleMouseUpOrLeave = () => {
    panRef.current = null; // end any active pan drag

    if (toolRef.current === 'select') {
      handleSelectMouseUp();
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    // Reset the composite mode NOW, not at the next stroke's setupTool.
    // The eraser leaves 'destination-out' stuck on the layer ctx, and any
    // drawImage that runs before the next setupTool would ERASE instead
    // of paint. Stroke end is the natural reset point.
    const endedCtx = activeLayer()?.canvas.getContext('2d');
    if (endedCtx) endedCtx.globalCompositeOperation = 'source-over';
    // The stroke is complete — commit it to history
    pushSnapshot();
  };

  // --- EXPORT ---
  // Exports the active selection region if there is one, otherwise the
  // whole canvas (the dropdown decides which items to offer).
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
  // can never paint underneath a floating region. An in-progress polygon
  // dies with the switch — it was never a selection yet.
  const changeTool = (t: Tool) => {
    if (selRef.current) commitSelection();
    setPolyPoints(null);
    polyCursorRef.current = null;
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
    // Clear the ACTIVE layer only — other layers keep their pixels.
    // Locked layers refuse clears.
    const layer = activeLayer();
    if (!layer || layer.locked) return;
    const ctx = layer.canvas.getContext('2d');
    ctx?.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    // Nothing left to outline — drop the sticker with the pixels
    const next = layersRef.current.map((l) =>
      l.id === layer.id ? { ...l, stroke: undefined } : l
    );
    layersRef.current = next;
    setLayers(next);
    composite();
    // Clearing is an action too — make it undoable
    pushSnapshot();
  };

  // --- STICKERIZE ---
  // Wrap the active layer's opaque pixels in a white outline. The outline
  // follows the layer's ALPHA silhouette (erased areas get no stroke), not
  // the canvas rect — so it hugs whatever shape remains after cleanup.
  //
  // The stroke lives on layer.stroke (a separate canvas), NOT baked into
  // layer.canvas. That's what makes remove/re-stickerize well-defined:
  // edits only ever touch layer.canvas, so the stroke is always fully
  // strippable and every stickerize recomputes from the true pixels —
  // widths replace instead of stacking, no bookkeeping to corrupt.
  //
  // Tight bounding box of non-transparent pixels, or null when the canvas
  // is empty. Shared by stickerize, remove-stroke, and selection delete
  // (all of which need to recompute bounds after pixels change).
  const scanBounds = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { width: W, height: H } = canvas;
    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  };

  // Grows a white outline around the layer's CURRENT opaque pixels and
  // returns it as a full-size stroke canvas, plus the content bbox so
  // callers can update bounds. Null when the layer has no pixels.
  //
  // How the outline is grown: in morphology terms we need a DILATION of the
  // silhouette by a disc of radius `width`. A disc = every offset vector of
  // length <= r, and dilation = the union of the shape translated by each
  // of those offsets. So: stamp the white silhouette at every point of
  // circles r = 1..width and the union of the stamps is the silhouette
  // grown outward with a rounded edge.
  const buildStrokeCanvas = (
    layer: Pick<Layer, 'canvas'>,
    width: number
  ): { canvas: HTMLCanvasElement; minX: number; minY: number; maxX: number; maxY: number } | null => {
    const src = layer.canvas;
    const srcCtx = src.getContext('2d');
    if (!srcCtx || width <= 0) return null;

    // Tight bounding box of non-transparent pixels. We work on the crop,
    // not the full 800x600 canvas — the stamping loop below blits the
    // silhouette a few thousand times, and a small crop makes that fast.
    const bounds = scanBounds(src);
    if (!bounds) return null; // empty layer — nothing to outline
    const { minX, minY, maxX, maxY } = bounds;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // Crop the pixels (8-arg drawImage = source-rect copy)
    const crop = document.createElement('canvas');
    crop.width = bw;
    crop.height = bh;
    crop.getContext('2d')?.drawImage(src, minX, minY, bw, bh, 0, 0, bw, bh);

    // White silhouette of the crop: paint white THROUGH its alpha.
    // 'source-in' keeps only where the destination is opaque, recolored
    // to the fill — exactly the tinting we need (see mode-toggle: this
    // is why the stamps come out white instead of image-colored).
    const silhouette = document.createElement('canvas');
    silhouette.width = bw;
    silhouette.height = bh;
    const silCtx = silhouette.getContext('2d');
    if (!silCtx) return null;
    silCtx.drawImage(crop, 0, 0);
    silCtx.globalCompositeOperation = 'source-in';
    silCtx.fillStyle = '#ffffff';
    silCtx.fillRect(0, 0, bw, bh);
    silCtx.globalCompositeOperation = 'source-over';

    // Dilate: stamp the silhouette around circles r = 1..width. Every
    // integer radius is needed — stamping only the outermost circle misses
    // pinch points in concave shapes (a "C" would plug up wrong). Angle
    // steps keep the gap between stamps ≈1px so the union is solid; offsets
    // are rounded to whole pixels (subpixel blits would only be slower,
    // and the union hides the jitter).
    const dilated = document.createElement('canvas');
    dilated.width = bw + 2 * width;
    dilated.height = bh + 2 * width;
    const dilCtx = dilated.getContext('2d');
    if (!dilCtx) return null;
    for (let r = 1; r <= width; r++) {
      const steps = Math.max(8, Math.ceil(2 * Math.PI * r));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * 2 * Math.PI;
        dilCtx.drawImage(
          silhouette,
          width + Math.round(Math.cos(angle) * r),
          width + Math.round(Math.sin(angle) * r)
        );
      }
    }

    // Full-size stroke canvas, positioned to match the layer's pixels.
    // The layer's own pixels are NOT copied in — composite() draws the
    // stroke canvas first and the pixels on top, which puts the white
    // AROUND them. (The dilated union includes the silhouette area itself;
    // that part hides beneath the pixels.)
    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = src.width;
    strokeCanvas.height = src.height;
    strokeCanvas.getContext('2d')?.drawImage(dilated, minX - width, minY - width);
    return { canvas: strokeCanvas, minX, minY, maxX, maxY };
  };

  const stickerizeLayer = (strokeWidth: number) => {
    if (strokeWidth <= 0) return;
    // Adds a stroke canvas; a floating piece must land first so the
    // silhouette reflects the committed pixels
    if (selRef.current) commitSelection();

    const layer = activeLayer();
    if (!layer || layer.locked) return;
    const built = buildStrokeCanvas(layer, strokeWidth);
    if (!built) return; // empty layer — nothing to outline
    const { canvas: strokeCanvas, minX, minY, maxX, maxY } = built;
    const R = strokeWidth;
    const { width: W, height: H } = layer.canvas;

    // 6. Attach the stroke to the layer (replacing any previous one —
    //    widths replace, never stack) and grow Image-layer bounds by R so
    //    one-click select covers the stroke too (clamped by the edges).
    if (layer.kind === 'Image') {
      const bx = Math.max(0, minX - R);
      const by = Math.max(0, minY - R);
      const next = layersRef.current.map((l) =>
        l.id === layer.id
          ? {
              ...l,
              stroke: { width: R, canvas: strokeCanvas },
              bounds: {
                x: bx,
                y: by,
                width: Math.min(W, maxX + R + 1) - bx,
                height: Math.min(H, maxY + R + 1) - by,
              },
            }
          : l
      );
      layersRef.current = next;
      setLayers(next);
    } else {
      const next = layersRef.current.map((l) =>
        l.id === layer.id ? { ...l, stroke: { width: R, canvas: strokeCanvas } } : l
      );
      layersRef.current = next;
      setLayers(next);
    }

    composite();
    // Stickerizing is an action — make it undoable
    pushSnapshot();
  };

  // Strip the sticker: detach the stroke canvas entirely. Because the
  // stroke never lived in the layer's pixels, this removes ALL of it —
  // regardless of how many widths were applied or what edits happened
  // since. Undoable like any other action.
  const removeSticker = () => {
    const layer = activeLayer();
    if (!layer || layer.locked || !layer.stroke) return;

    // Image layers: bounds shrink back to the actual pixels (the stroke
    // margin is gone). Recompute from an alpha scan — bounds may be stale
    // if pixels were transformed earlier.
    if (layer.kind === 'Image') {
      const scanned = scanBounds(layer.canvas);
      const bounds = scanned
        ? {
            x: scanned.minX,
            y: scanned.minY,
            width: scanned.maxX - scanned.minX + 1,
            height: scanned.maxY - scanned.minY + 1,
          }
        : undefined; // pixels were erased to nothing — no bounds to select
      const next = layersRef.current.map((l) =>
        l.id === layer.id ? { ...l, stroke: undefined, bounds } : l
      );
      layersRef.current = next;
      setLayers(next);
    } else {
      const next = layersRef.current.map((l) =>
        l.id === layer.id ? { ...l, stroke: undefined } : l
      );
      layersRef.current = next;
      setLayers(next);
    }

    composite();
    pushSnapshot();
  };

  // Delete the selected pixels: erase under the selection's CURRENT rect
  // (it may have been dragged away from orig), discard the lifted region,
  // and drop back to no-selection. Undoable like any other action.
  const deleteSelection = () => {
    const layer = selTargetLayer();
    const sel = selRef.current;
    if (!layer || !sel || !selection) return;
    if (layer.locked) return; // lock refuses pixel edits
    const lctx = layer.canvas.getContext('2d');
    if (!lctx) return;

    // Deletion is just transparency. Rect selections clear their bbox;
    // polygon selections erase exactly their shape (translated to where
    // the selection sits now) via destination-out.
    if (sel.polygon) {
      const dx = selection.x - sel.orig.x;
      const dy = selection.y - sel.orig.y;
      erasePolygonShape(
        lctx,
        sel.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }))
      );
    } else {
      lctx.clearRect(selection.x, selection.y, selection.width, selection.height);
    }

    // The stroke hugs the silhouette — rebuild it so it wraps the new
    // shape (or disappears entirely if everything inside was erased)
    let stroke = layer.stroke;
    if (layer.stroke) {
      const rebuilt = buildStrokeCanvas(layer, layer.stroke.width);
      stroke = rebuilt
        ? { width: layer.stroke.width, canvas: rebuilt.canvas }
        : undefined;
    }

    // Image layers: bounds may have shrunk — recompute from the pixels
    let bounds = layer.bounds;
    if (layer.kind === 'Image') {
      const scanned = scanBounds(layer.canvas);
      bounds = scanned
        ? {
            x: scanned.minX,
            y: scanned.minY,
            width: scanned.maxX - scanned.minX + 1,
            height: scanned.maxY - scanned.minY + 1,
          }
        : undefined;
    }

    const next = layersRef.current.map((l) =>
      l.id === layer.id ? { ...l, stroke, bounds } : l
    );
    layersRef.current = next;
    setLayers(next);

    composite();
    pushSnapshot();
    selRef.current = null;
    setSelection(null);
  };

  // --- LAYER OPERATIONS (from the panel) ---
  const activateLayer = (id: string) => {
    setActiveLayerId(id);
  };

  const toggleLayerVisible = (id: string) => {
    const next = layersRef.current.map((l) =>
      l.id === id ? { ...l, visible: !l.visible } : l
    );
    layersRef.current = next;
    setLayers(next);
    composite();
    // Visibility is part of the snapshot, so it's undoable too
    pushSnapshot();
  };

  // Lock/unlock via the layer's context menu. If that layer has a
  // floating selection, commit it first — a locked layer must not be
  // transformed afterwards.
  const toggleLayerLock = (id: string) => {
    if (selRef.current?.layerId === id) commitSelection();

    const next = layersRef.current.map((l) =>
      l.id === id ? { ...l, locked: !l.locked } : l
    );
    layersRef.current = next;
    setLayers(next);
    // No composite needed — locking changes no pixels, only future edits
    pushSnapshot();
  };

  // Clone a layer's pixels into a new layer placed directly ABOVE the
  // original (higher z), and make it active — ready to edit.
  const duplicateLayer = (id: string) => {
    const index = layersRef.current.findIndex((l) => l.id === id);
    if (index === -1) return;
    const src = layersRef.current[index];

    const canvas = document.createElement('canvas');
    canvas.width = src.canvas.width;
    canvas.height = src.canvas.height;
    canvas.getContext('2d')?.drawImage(src.canvas, 0, 0);

    const copy: Layer = {
      id: Math.random().toString(36).slice(2),
      name: `${src.name} copy`,
      kind: src.kind,
      visible: src.visible,
      locked: false, // a duplicate starts unlocked — you duplicate to edit it
      canvas,
      // Image layers carry their placement: the pixels were cloned at the
      // same coordinates, so the duplicate owns the SAME bounds. Without
      // this, one-click selection ignores the copy (hit test skips layers
      // with no bounds).
      bounds: src.bounds ? { ...src.bounds } : undefined,
      // The clone shows the same sticker, so it inherits the stroke canvas
      // (a fresh copy — the two layers must not share one canvas)
      stroke: src.stroke
        ? (() => {
            const strokeCanvas = document.createElement('canvas');
            strokeCanvas.width = src.stroke.canvas.width;
            strokeCanvas.height = src.stroke.canvas.height;
            strokeCanvas.getContext('2d')?.drawImage(src.stroke.canvas, 0, 0);
            return { width: src.stroke.width, canvas: strokeCanvas };
          })()
        : undefined,
    };

    const next = [...layersRef.current];
    next.splice(index + 1, 0, copy);
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(copy.id);

    composite();
    pushSnapshot();
  };

  const deleteLayer = (id: string) => {
    // A selection lifted from this layer dies with it — there's nothing
    // to commit into (and committing would write into a removed layer)
    if (selRef.current?.layerId === id) {
      selRef.current = null;
      setSelection(null);
    }

    let next = layersRef.current.filter((l) => l.id !== id);

    // Never leave the document with zero layers — replace with a fresh
    // empty Background so painting always has a target
    if (next.length === 0) {
      next = [makeLayer('Background', 'Paint')];
    }

    layersRef.current = next;
    setLayers(next);

    // Fix the active layer if it (no longer) exists
    if (!next.some((l) => l.id === activeLayerIdRef.current)) {
      setActiveLayerId(next[next.length - 1].id);
    }

    composite();
    pushSnapshot();
  };

  // Drag & drop reorder (LayersPanel): the dragged layer takes the slot
  // of the layer it was dropped on. Order matters — the composite draws
  // bottom to top, so reordering changes what's on top.
  const reorderLayers = (fromId: string, toId: string) => {
    const next = [...layersRef.current];
    const from = next.findIndex((l) => l.id === fromId);
    const to = next.findIndex((l) => l.id === toId);
    if (from === -1 || to === -1 || from === to) return;

    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    layersRef.current = next;
    setLayers(next);
    composite();
    pushSnapshot();
  };

  // Both painting tools preview their radius with the follow cursor
  const isSizeTool = tool === 'brush' || tool === 'eraser';

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
        <Button
          variant={tool === 'polyline' ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => changeTool('polyline')}
          aria-pressed={tool === 'polyline'}
          title="Polyline select"
        >
          <Lasso />
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
        {/* Brush color dropdown: presets + native custom picker */}
        <ColorPickerMenu color={brushColor} onChange={setBrushColor} />
        <Button variant="secondary" size='icon-sm' onClick={handleClear} title="Clear layer"><Trash/></Button>
        {/* The input is visually hidden; the button triggers it.
            This gives us a styled button with native file-picking. */}
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          style={{ display: 'none' }}
          ref={fileInputRef}
        />
        <Button variant="secondary" size='icon-sm' onClick={() => fileInputRef.current?.click()} title="Load Image">
          <Load/>
        </Button>
        {/* Export dropdown: selection-aware menu items */}
        <ExportMenu
          hasSelection={!!selection}
          onExport={exportCanvas}
        />
        {/* Stickerize: white outline around the active layer's opaque pixels */}
        <StickerizeMenu
          hasSticker={!!layers.find((l) => l.id === activeLayerId)?.stroke}
          onStickerize={stickerizeLayer}
          onRemove={removeSticker}
        />
        <Button variant="secondary" size='icon-sm' onClick={undo} disabled={historyInfo.index <= 0}>
         <Undo/>
        </Button>
        <Button
          variant="secondary"
          size='icon-sm'
          onClick={redo}
          disabled={historyInfo.index >= historyInfo.length - 1}
        >
         <Redo/>
        </Button>
        {/* Zoom controls: click the % to reset to 100% */}
        <Button variant="secondary" size='icon-sm' onClick={() => setZoomAtCenter(1 / 1.25)}>
          <Minus/>
        </Button>
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="secondary" size='sm' onClick={() => setZoomAtCenter(1 / zoomRef.current)}>
              {Math.round(zoom * 100)}%
            </Button>
          } />
          <TooltipContent>
            <p>Reset Zoom</p>
          </TooltipContent>
        </Tooltip>
        <Button variant="secondary" size='icon-sm' onClick={() => setZoomAtCenter(1.25)}>
          <Plus/>
        </Button>
        {/* Layers panel toggle */}
        <Button
          variant={panelOpen ? 'secondary' : 'ghost'}
          size='icon-sm'
          onClick={() => setPanelOpen((open) => !open)}
          aria-pressed={panelOpen}
          title="Layers"
        >
          <LayersIcon />
        </Button>
      </div>

      </div>

      {placement && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <button className="rounded-md bg-secondary px-2.5 py-1 text-sm text-secondary-foreground transition-colors hover:bg-accent" onClick={handleApplyPlacement}>Apply Image</button>
          <button className="rounded-md bg-secondary px-2.5 py-1 text-sm text-secondary-foreground transition-colors hover:bg-accent" onClick={handleCancelPlacement}>Cancel</button>
          <span className="self-center text-[13px] text-muted-foreground">
            Drag to move · corners scale · edges stretch
          </span>
        </div>
      )}

      {selection && !placement && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <button className="rounded-md bg-secondary px-2.5 py-1 text-sm text-secondary-foreground transition-colors hover:bg-accent" onClick={commitSelection}>Apply Selection</button>
          <button className="rounded-md bg-secondary px-2.5 py-1 text-sm text-secondary-foreground transition-colors hover:bg-accent" onClick={cancelSelection}>Cancel</button>
          <span className="self-center text-[13px] text-muted-foreground">
            Drag inside to move · handles to resize · click outside to apply
          </span>
        </div>
      )}

      {polyPoints && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
          <span className="self-center text-[13px] text-muted-foreground">
            Click to add points · click the first point or press Enter to close · Esc to cancel
          </span>
        </div>
      )}

      {/* Canvas + layers panel side by side */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
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
        <ContextMenu
          open={canvasMenuOpen && selection != null}
          onOpenChange={setCanvasMenuOpen}
        >
        <ContextMenuTrigger
          render={
            <canvas
          ref={canvasRef}
          width={800}
          height={600}
        style={{

          // Checkerboard = the universal "this area is transparent" pattern.
          // The canvas itself is transparent; this is just what shows through.
          // Colors come from CSS vars so light/dark modes both look right.
          backgroundColor: 'var(--checker-a)',
          backgroundImage:
            'linear-gradient(45deg, var(--checker-b) 25%, transparent 25%), linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checker-b) 75%), linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          // Cursor follows the active tool: painting tools hide the native
          // cursor entirely — the size circle replaces it. Space = grab.
          // Select tool: hover-aware (resize arrows near selection handles).
          cursor: isPanning
            ? 'grab'
            : tool === 'select'
              ? canvasCursor ?? ARROW_CURSOR
              : tool === 'polyline'
                ? 'crosshair'
                : 'none',
          // Zoomed in, show the actual bitmap pixels instead of a blur
          imageRendering: zoom > 1 ? 'pixelated' : 'auto',
          display: 'block',
        }}
        onPointerDown={handleMouseDown}
        onPointerMove={handleMouseMove}
        onPointerUp={handleMouseUpOrLeave}
        onPointerEnter={(e) => {
          // Position the circle BEFORE showing it — visibility flips on
          // enter, but the transform is only written on move, so without
          // this the circle flashes at its unset position: the top-left
          // corner (0,0).
          updateEraserCursor(e);
          setEraserCursorVisible(true);
        }}
        onPointerLeave={() => {
          setEraserCursorVisible(false);
          handleMouseUpOrLeave();
        }}
            />
          }
        />
        {/* Right-click menu: opens only on right-click (Base UI handles the
            contextmenu event) AND only while a selection exists — the open
            prop above is gated on `selection`. */}
        <ContextMenuContent>
          <ContextMenuItem onClick={commitSelection}>Deselect</ContextMenuItem>
          <ContextMenuItem variant='destructive' onClick={deleteSelection}>
            Delete selection
          </ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>
        {/* Cursor size indicator: circle matching the stroke radius for
            brush AND eraser. Rendered inside the relative container so
            canvas coords == container coords. pointerEvents:none keeps it
            click-transparent. */}
        {isSizeTool && (
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
        {/* Corner size indicator removed — cursor circle only */}
        {/* Overlay canvas: sits exactly on top of the base canvas.
            During placement it captures the mouse (blocking drawing).
            During selection it's pointer-transparent so the base canvas
            keeps receiving the marquee/transform events. */}
        {(placement || selection || polyPoints) && (
          <canvas
            ref={overlayRef}
            width={800}
            height={600}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              cursor: placementCursor,
              pointerEvents: placement ? 'auto' : 'none',
            }}
            onMouseDown={handleOverlayMouseDown}
            onMouseMove={(e) => {
              // Hover feedback only when not mid-drag (a drag locks its cursor)
              if (!dragRef.current) handleOverlayHover(e);
              handleOverlayMouseMove(e);
            }}
            onMouseUp={handleOverlayMouseUp}
            onMouseLeave={handleOverlayMouseUp}
          />
        )}
          </div>
        </div>
      </div>

      {panelOpen && (
        <LayersPanel
          layers={layers}
          activeId={activeLayerId}
          version={layersVersion}
          onActivate={activateLayer}
          onToggleVisible={toggleLayerVisible}
          onToggleLock={toggleLayerLock}
          onDuplicate={duplicateLayer}
          onDelete={deleteLayer}
          onReorder={reorderLayers}
          onClose={() => setPanelOpen(false)}
        />
      )}
      </div>
    </div>
  );
}
