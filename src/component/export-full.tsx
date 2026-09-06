import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// "Export full canvas" icon. JPEG ignores selections — it always bakes
// the entire canvas onto a white background — so the tooltip adapts its
// message based on whether a selection is active.
export const ExportFull = ({ hasSelection }: { hasSelection?: boolean }) => {
  return (
    <Tooltip>
      <TooltipTrigger>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v7"/><path d="m9 12.5 3 3 3-3"/></svg>
      </TooltipTrigger>
      <TooltipContent>
        {hasSelection ? (
          <p>Selection ignored — JPEG exports the full canvas (white background)</p>
        ) : (
          <p>Export full canvas as JPEG (white background)</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}