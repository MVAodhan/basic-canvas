import { ImageCanvas } from '#/component/ImageCanvas'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="p-8 flex justify-center items-center h-screen">
      <ImageCanvas></ImageCanvas>
    </div>
  )
}
