import { Sticker } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Stroke thicknesses offered in the menu (document pixels)
const STROKE_WIDTHS = [4, 8, 16, 24, 32]

// Stickerize dropdown: wraps the active layer's opaque pixels in a white
// outline of the chosen thickness. One click = one width — no dialog, and
// the result is undoable like any other layer edit. Picking a new width
// replaces the previous stroke; "Remove stroke" strips it entirely.
export const StickerizeMenu = ({
  hasSticker,
  onStickerize,
  onRemove,
}: {
  hasSticker: boolean
  onStickerize: (strokeWidth: number) => void
  onRemove: () => void
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size='icon-sm' variant='secondary' aria-label='Stickerize'>
            <Sticker />
          </Button>
        }
      />
      <DropdownMenuContent align='start'>
        {STROKE_WIDTHS.map((width) => (
          <DropdownMenuItem key={width} onClick={() => onStickerize(width)}>
            White stroke · {width} px
          </DropdownMenuItem>
        ))}
        {/* Only offered when the active layer actually has a stroke to strip */}
        {hasSticker && (
          <DropdownMenuItem onClick={onRemove}>Remove stroke</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
