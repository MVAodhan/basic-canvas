import { NavBar } from '#/component/NavBar'
import { Button } from '#/components/ui/button'
import { Link } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'
import { Arrow } from '#/component/arrow'
import { Eraser } from '#/component/eraser'
import { Pen } from '#/component/pen'
import { Layers as LayersIcon } from 'lucide-react'

export const Route = createFileRoute('/')({ component: Landing })

const features = [
  {
    icon: <Pen />,
    title: 'Paint & erase',
    body: 'Brush and eraser tools with live size preview, painting directly on per-layer offscreen canvases.',
  },
  {
    icon: <Arrow />,
    title: 'Select & transform',
    body: 'Marquee selections with animated ants, handle-based resize, and drag-to-move — all in document space.',
  },
  {
    icon: <LayersIcon />,
    title: 'Layers',
    body: 'Reorder, hide, lock, and duplicate layers with drag-and-drop. Every layer composites bottom-to-top.',
  },
  {
    icon: <Eraser />,
    title: 'Undo history',
    body: 'Snapshot-based undo/redo that captures every layer, so one keystroke rolls back a whole edit.',
  },
]

function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <NavBar />

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-20 text-center">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          A minimal image editor,{' '}
          <span className="text-primary">right in your browser</span>
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Layers, selections, brushes, and undo history — all rendered on plain
          HTML canvas. Nothing is uploaded; every pixel is edited client-side.
        </p>
        <div className="flex items-center gap-3">
          <Link to="/editor" render={<Button size="lg" />}>
            Open the editor
          </Link>
        </div>
      </main>

      {/* Feature cards */}
      <section className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 px-6 pb-20 sm:grid-cols-2">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-lg border border-border bg-card p-5 text-left"
          >
            <div className="mb-3 flex size-8 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              {feature.icon}
            </div>
            <h2 className="mb-1 font-semibold">{feature.title}</h2>
            <p className="text-sm text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </section>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        Built with TanStack Start, React 19, and the HTML canvas API.
      </footer>
    </div>
  )
}
