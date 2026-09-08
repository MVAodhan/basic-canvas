import { ImageCanvas } from '#/component/ImageCanvas'
import { NavBar } from '#/component/NavBar'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/editor')({ component: EditorPage })

function EditorPage() {
  return (
    <div className="flex h-screen flex-col">
      <NavBar />
      <div className="flex flex-1 items-center justify-center p-8">
        <ImageCanvas />
      </div>
    </div>
  )
}
