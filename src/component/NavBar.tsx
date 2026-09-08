import { Link } from '@tanstack/react-router'
import { ModeToggle } from './mode-toggle'

/**
 * Shared top navigation. Lives on every page and owns the theme toggle —
 * it used to sit in the editor toolbar, but it's a global concern, not a
 * canvas tool, so it belongs here.
 */
export function NavBar() {
  return (
    <nav className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
      <div className="flex items-center gap-4">
        <Link to="/" className="text-sm font-semibold text-foreground">
          Basic Canvas
        </Link>
        <Link
          to="/editor"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          activeProps={{ className: 'text-foreground font-medium' }}
        >
          Editor
        </Link>
      </div>
      <ModeToggle />
    </nav>
  )
}
