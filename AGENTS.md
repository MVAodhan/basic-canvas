# AGENTS.md — Guide for AI agents (and humans) working on this project

A minimal Pixlr-style image editor built with **TanStack Start** (React 19 + Vite + Tailwind v4).
All editing happens client-side on HTML canvas. There are **no tests** — verify changes by
running `pnpm dev` (port 3000) and exercising features manually.

## Stack & conventions

- React 19, TypeScript, Tailwind v4, TanStack Router/Start
- UI primitives in `src/components/ui/` (shadcn-style, **Base UI** under the hood — these use
  a `render` prop instead of Radix's `asChild`)
- Path aliases: `#/` → `./src/`, `@/` → `./src/` (both work in existing code)
- Icons: mix of hand-rolled SVG components in `src/component/*.tsx` and `lucide-react`
- `pnpm dev` note: the Netlify vite plugin only loads when `NETLIFY` env is set (see
  `vite.config.ts`) — it needs a newer Deno than some machines have.

## Key files

| File | Role |
|---|---|
| `src/component/ImageCanvas.tsx` | The editor. ~1200 lines, monolithic by design (learning project). All canvas logic, tools, history, zoom, placement, selection |
| `src/component/LayersPanel.tsx` | Layers panel UI + dnd-kit drag reordering. Exports the `Layer` type |
| `src/components/ui/*` | Base UI wrappers: button, tooltip, dropdown-menu, context-menu |
| `vite.config.ts` | Plugins; Netlify is conditional on `NETLIFY` env |

## Architecture: how the canvas works

### The three-canvas setup

1. **Base canvas** (`canvasRef`) — displays the composite. **Only `composite()` paints it**
   (clear + draw all visible layers bottom→top).
2. **Overlay canvas** (`overlayRef`) — selection ants/handles + image placement preview.
   Rendered only when `placement || selection`. During placement it captures the mouse
   (`pointerEvents: 'auto'`); during selection it's `pointerEvents: 'none'` so the base
   canvas receives events.
3. **Per-layer offscreen canvases** — `Layer.canvas` (not in the DOM). ALL pixel edits
   (brush, eraser, selection transforms) target the **active layer's** offscreen canvas,
   followed by `composite()`.

### Layer model (`Layer` in LayersPanel.tsx)

```ts
{ id, name, kind: 'Paint' | 'Image', visible, locked, canvas, bounds? }
```

- `bounds` (Image layers only): where the image sits on the canvas. Set at placement-apply,
  snapped to the final rect when a **one-click image selection** commits. Enables
  click-to-select and hover cursors.
- Layer array index = z-order (0 = bottom). The panel displays the array **reversed**
  (topmost first), which is why row clicks map through `displayOrder`.

### History (undo/redo)

Snapshot-based. `pushSnapshot()` captures **every layer's ImageData + structure
(id/name/kind/visible/locked/bounds) + activeId**. `restoreSnapshot()` rebuilds fresh
offscreen canvases from the snapshot. Rules:

- Every completed action calls `pushSnapshot()` — paint stroke end, clear, visibility
  toggle, lock, reorder, duplicate, delete, placement apply.
- `MAX_HISTORY = 10` because each snapshot clones every layer (~1.9MB per 800×600 layer).
- If you add a field to `Layer`, you MUST add it to `LayerSnapshot`, `pushSnapshot`, and
  `restoreSnapshot` — there are four places, and TypeScript won't remind you (snapshot
  fields are structural). Forgot ones silently vanish on undo.

### Coordinate systems (the #1 source of bugs)

- **Document coords**: the 800×600 bitmap space. `getCanvasCoords` divides zoom out via
  `(clientX - rect.left) * (canvas.width / rect.width)`. ALL interaction math uses these.
- **Screen coords**: mouse deltas for **panning** (a view operation — deliberately NOT
  divided by zoom).
- **Zoom** is CSS-only: the bitmap is always 800×600. Two nested wrappers: outer
  (`contentRef`) holds layout size `800*zoom × 600*zoom` (scrollbars need it — `transform`
  doesn't affect layout); inner (`scaledRef`) holds `transform: scale(zoom)`.
- Zoom-at-cursor: `contentCoord = (scroll + cursorOffset) / oldZoom`, then set scroll so
  `contentCoord * newZoom` lands back under the cursor.

## Hard-won gotchas (each of these caused a real bug)

### Canvas API

- **`drawImage` with `source-over` BLENDS, it doesn't replace.** Transparent source pixels
  leave the destination untouched. Any "restore the world" redraw must `clearRect` FIRST
  or previous frames ghost/smear (this caused the selection smearing bug).
  `globalCompositeOperation = 'copy'` is the alternative true-replace.
- **`globalCompositeOperation` sticks** between frames/strokes. Eraser sets
  `destination-out`; if a later drawImage runs without resetting to `source-over`, it
  ERASES instead of paints. `setupTool()` resets per stroke for this reason.
- **`putImageData` ignores everything** (composite modes, transforms, scale). Use it for
  raw undo restores; use `drawImage` (8-arg form) whenever scaling is involved.
- **Assigning `canvas.width`/`height` wipes the canvas** and resets ALL ctx state — even
  assigning the same value.
- **`toBlob`/`toDataURL` always encode the entire canvas** — to export a region, draw the
  region onto a fresh offscreen canvas first (8-arg `drawImage`).
- **JPEG has no alpha** — transparent pixels encode black. The export path mattes onto
  white first.
- **CSS cursor images cap at ~128px** and can't update per-frame — that's why brush/eraser
  size indicators are DOM elements following the pointer, not cursors.

### React + imperative DOM (the hybrid pattern)

- **High-frequency writes go straight to the DOM via refs** (eraser cursor position, pan
  scroll, zoom transform) — NOT through state. React state is only for things UI renders
  (tool, zoom %, visibility flags). `setState` with an identical value is free; re-rendering
  60fps is not.
- **Never let React and imperative code own the same style property.** The zoom transform
  was written imperatively onto the wrapper AND declaratively onto the inner div → content
  scaled `zoom²` while scroll area scaled `zoom` → document edges unreachable. Each
  property has ONE owner: transform → `scaledRef`, layout size → `contentRef`.
- **One ref per element.** A duplicated JSX block sharing `ref={eraserCursorRef}` meant the
  first div never got positioned and sat frozen at the top-left corner (its declared
  `top:0 left:0`). Refs bind to the LAST mounted claimant; duplicates are legal JSX and
  produce no warnings. Grep the ref name and count matches when debugging.
- **Show-and-position must be atomic.** The size circle became visible on `pointerenter`
  but positioned on `pointermove` → it flashed at (0,0). Position it in the same event
  that shows it.
- **React `onWheel` is passive** — `preventDefault()` silently fails. Native
  `addEventListener('wheel', fn, { passive: false })` in an effect is required for
  wheel-zoom.

### Drag & drop

- Canvas drags use **pointer events + `setPointerCapture`** (pan mode). Without capture,
  the drag dies when the cursor leaves the canvas — you can never drag the full distance
  when zoomed in. `setPointerCapture` needs a `pointerId`, which only PointerEvents carry
  (hence `onPointer*`, not `onMouse*`).
- **dnd-kit is the 0.5.0 alpha rewrite** (`@dnd-kit/react`, not `@dnd-kit/core`). API:
  `DragDropProvider` + `useSortable({ id, index, type })` from `@dnd-kit/react/sortable`.
  There is NO `move` helper — reorder manually. `onDragEnd` alone was unreliable here;
  the panel uses **`onDragOver` for live reordering** plus `onDragEnd` as a no-op safety
  net (the reorder is idempotent). Note `onDragOver` and `onDragEnd` have *different,
  non-mutually-assignable* event types — the handler is typed to their minimal shared
  structural shape.

### Selections & layers

- Selections are **per-layer**: pixels lift from the layer that was active when the
  marquee closed (`selRef.layerId`). Transforms rewrite that layer, then `composite()`.
- **One-click image selection** (select tool + click an image): hit-tests topmost-first
  over Image layers — inside `bounds` AND `getImageData(x,y,1,1).alpha > 0` (transparent
  pixels fall through to layers below). Created selections are flagged
  `isImageSelect: true`; committing one snaps `layer.bounds` to the final rect. Marquee
  selections deliberately do NOT touch bounds (they moved an arbitrary region).
- Known stale-data edge: marquee-transforming part of an image can move pixels outside
  the stored `bounds`. Click-select won't cover those pixels. Proper fix: recompute
  bounds from a pixel scan after transforms.
- **Lock** refuses pixel edits (paint, clear, new marquee) but allows reorder/visibility.
  Locking a layer with a floating selection commits it first.
- Deleting a layer that owns a floating selection DISCARDS the selection (nothing to
  commit into). Deleting the last layer replaces it with a fresh "Background" — the app
  never has zero layers (there's no add-layer button yet).

### Base UI / shadcn components

- Base UI uses **`render={<Element/>}`** instead of Radix `asChild` for composition
  (`TooltipTrigger render={<Button/>}`, `DropdownMenuTrigger render={...}`,
  `ContextMenuTrigger render={...}`). Prefer this over nesting triggers, which creates
  invalid nested-interactive DOM.
- Tooltips follow two coexisting patterns: **icon components own their tooltip**
  (trash/load/export/undo/redo wrap their SVG in `Tooltip > TooltipTrigger`), and
  **inline `render`-prop tooltips** for text buttons / state-dependent content.
- Several hand-rolled icon SVGs had `stroke="black"` hardcoded — must be
  `stroke="currentColor"` or they vanish on dark chips.

## Conventions that emerged

- Tools: `'brush' | 'eraser' | 'select'` in `Tool` type; selected tool = `secondary`
  Button variant, unselected = `ghost`; all action buttons are `secondary icon-sm`.
- Cursor logic lives in the canvas style: pan → `grab`, select → `canvasCursor ??
  ARROW_CURSOR` (hover-aware around selection handles), paint tools → `'none'` (the size
  circle IS the cursor). Placement overlay cursor is its own state (`placementCursor`)
  driven by handle hit-testing.
- Panels/UX copy is English; keep comments explanatory — this is a learning project and
  the comments teach.

## Adding things (recipes)

- **New pixel-editing tool**: add to `Tool`, a `setupTool` branch (always set
  `globalCompositeOperation`), a branch in `handleMouseDown`/`handleMouseMove` targeting
  `activeLayer().canvas`, end with `pushSnapshot()` on completion. Block it for locked
  layers (`layer.locked`).
- **New layer operation**: mutate → `layersRef.current = next; setLayers(next)` →
  `composite()` if pixels/z-order changed → `pushSnapshot()`. Remember: activeId fixup if
  the active layer is affected; selection cleanup if the layer owned one.
- **New per-layer field**: `Layer` type → `makeLayer` default → `LayerSnapshot` →
  `pushSnapshot` → `restoreSnapshot`. (5 places.)

## Environment

- `pnpm dev` → port 3000. Deno 2.9.6 present but only used by the (disabled-in-dev)
  Netlify edge emulator.
- No linting config beyond TS. Run a diagnostics check on edited files before finishing.
