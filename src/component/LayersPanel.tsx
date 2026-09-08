import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Layers as LayersIcon, Lock, LockOpen, Copy, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { DragDropProvider } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'

export type LayerKind = 'Paint' | 'Image'

export type Layer = {
  id: string
  name: string
  kind: LayerKind
  visible: boolean
  locked: boolean
  canvas: HTMLCanvasElement
  // Only meaningful for Image layers: where the image sits on the canvas.
  // Enables one-click selection of the image's boundaries.
  bounds?: { x: number; y: number; width: number; height: number }
}

// Thumbnail: a tiny canvas that mirrors a layer's pixels. Redraws whenever
// `version` bumps (the editor increments it after any pixel change).
function LayerThumb({ canvas, version }: { canvas: HTMLCanvasElement; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = ref.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.drawImage(canvas, 0, 0, el.width, el.height)
  }, [canvas, version])

  return (
    <canvas
      ref={ref}
      width={44}
      height={44}
      className="h-11 w-11 shrink-0 rounded-sm bg-white"
    />
  )
}

// One row = one draggable/droppable layer. The WHOLE row is a drag handle;
// clicks (no movement) still fall through to activate the layer.
function SortableLayerRow({
  layer,
  index,
  isActive,
  version,
  onActivate,
  onToggleVisible,
  onToggleLock,
  onDuplicate,
  onDelete,
}: {
  layer: Layer
  index: number
  isActive: boolean
  version: number
  onActivate: (id: string) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { ref, isDragging } = useSortable({ id: layer.id, index, type: 'layer' })

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={ref}
            onClick={() => onActivate(layer.id)}
            style={{ opacity: isDragging ? 0.4 : 1 }}
            className={`flex cursor-grab items-center gap-2 rounded-md p-1.5 ring-2 transition-colors select-none active:cursor-grabbing ${
              isActive
                ? 'bg-blue-500/10 ring-blue-500 dark:bg-blue-400/15 dark:ring-blue-400'
                : 'ring-transparent hover:bg-accent/60'
            } ${isDragging ? 'ring-blue-400/60' : ''}`}
          >
            <LayerThumb canvas={layer.canvas} version={version} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className={`flex items-center gap-1 truncate text-sm ${
                isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground'
              }`}>
                {layer.locked && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                {layer.name}
              </div>
              <div className="text-xs text-muted-foreground">{layer.kind}</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleVisible(layer.id)
              }}
              onPointerDown={(e) => e.stopPropagation()} // never start a drag from the eye
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
            >
              {layer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
          </div>
        }
      />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onToggleLock(layer.id)}>
          {layer.locked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          {layer.locked ? 'Unlock layer' : 'Lock layer'}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDuplicate(layer.id)}>
          <Copy className="h-4 w-4" />
          Duplicate layer
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => onDelete(layer.id)}>
          <Trash2 className="h-4 w-4" />
          Delete layer
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function LayersPanel({
  layers,
  activeId,
  version,
  onActivate,
  onToggleVisible,
  onToggleLock,
  onDuplicate,
  onDelete,
  onReorder,
  onClose,
}: {
  layers: Layer[]
  activeId: string | null
  version: number
  onActivate: (id: string) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  // Display topmost-first (index 0 = top of the stack, like every editor)
  const displayOrder = [...layers].reverse()

  // Reorder handler — shared by onDragOver (live, fires continuously)
  // and onDragEnd (on drop). Idempotent: if the dragged layer is already
  // at the target slot, the splice is a no-op, so firing twice is safe.
  // Typed structurally to the shape BOTH events share (they differ in
  // extra fields, and the two prop types aren't mutually assignable).
  const handleReorder = (event: {
    operation: {
      source: { id: unknown } | null;
      target: { id: unknown } | null;
    };
  }) => {
    const { source, target } = event.operation;
    if (!source || !target) return;
    const fromId = String(source.id);
    const toId = String(target.id);
    if (fromId !== toId) onReorder(fromId, toId);
  };

  return (
    <div className="w-60 shrink-0 overflow-hidden rounded-lg bg-card shadow-lg ring-1 ring-border">
      {/* Header */}
      <div className="relative flex items-center justify-center px-2 py-2">
        <span className="text-sm font-semibold text-foreground">Layers</span>
        <div className="absolute right-1.5 flex items-center gap-0.5">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          >
            —
          </button>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>
      </div>

      {/* Layer list */}
      {!collapsed && (
        <DragDropProvider onDragOver={handleReorder} onDragEnd={handleReorder}>
          <div className="flex flex-col gap-1 p-1.5">
            {displayOrder.map((layer, displayIndex) => (
              <SortableLayerRow
                key={layer.id}
                layer={layer}
                index={displayIndex}
                isActive={layer.id === activeId}
                version={version}
                onActivate={onActivate}
                onToggleVisible={onToggleVisible}
                onToggleLock={onToggleLock}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
              />
            ))}
            {layers.length === 0 && (
              <div className="flex items-center justify-center gap-1.5 p-4 text-xs text-muted-foreground">
                <LayersIcon className="h-3.5 w-3.5" /> No layers
              </div>
            )}
          </div>
        </DragDropProvider>
      )}
    </div>
  )
}