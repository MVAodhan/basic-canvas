import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Quick picks shown as a swatch grid (5 columns × 2 rows)
const PRESET_COLORS = [
  '#000000', // black
  '#ffffff', // white
  '#6b7280', // gray
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
]

// Brush color dropdown. The trigger swatch doubles as the current-color
// indicator; presets apply with one click, and "Custom…" hands off to the
// native color input (kept OUTSIDE the menu items — a click on a menu item
// closes the popup, which would kill the native picker mid-open).
export const ColorPickerMenu = ({
  color,
  onChange,
}: {
  color: string
  onChange: (color: string) => void
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant='secondary' size='icon-sm' aria-label='Brush color' title='Brush color' />
        }
      >
        <span
          className='block size-4 rounded-full border border-border'
          style={{ backgroundColor: color }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <div className='grid grid-cols-5 gap-1 p-1'>
          {PRESET_COLORS.map((preset) => {
            const selected = preset.toLowerCase() === color.toLowerCase()
            return (
              <button
                key={preset}
                type='button'
                onClick={() => onChange(preset)}
                aria-label={`Brush color ${preset}`}
                aria-pressed={selected}
                className={`size-6 rounded-md border border-border transition-transform hover:scale-110 ${
                  selected ? 'ring-2 ring-ring ring-offset-2 ring-offset-popover' : ''
                }`}
                style={{ backgroundColor: preset }}
              />
            )
          })}
        </div>
        <DropdownMenuSeparator />
        <label className='flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent'>
          <input
            type='color'
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className='size-5 shrink-0 cursor-pointer rounded-sm border border-border bg-none p-0'
          />
          Custom…
        </label>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
