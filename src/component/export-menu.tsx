import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Export } from "./export"

type ExportFormat = 'png' | 'jpeg'

// Export dropdown. The menu is EITHER/OR based on selection state:
// a selection limits the menu to selection exports; without one you get
// full-canvas exports. The two states never mix.
export const ExportMenu = ({
  hasSelection,
  onExport,
}: {
  hasSelection: boolean
  onExport: (format: ExportFormat) => void
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size='icon-sm' variant='secondary' aria-label='Export'>
            <Export hasSelection={hasSelection} />
          </Button>
        }
      />
      <DropdownMenuContent align='start'>
        {hasSelection ? (
          <>
            <DropdownMenuItem onClick={() => onExport('png')}>
              Export Selection as PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport('jpeg')}>
              Export Selection as JPEG
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => onExport('png')}>
              Export Full Canvas as PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport('jpeg')}>
              Export Full Canvas as JPEG
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}