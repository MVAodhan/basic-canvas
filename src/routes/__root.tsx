import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'


import appCss from '../styles.css?url'
import { ThemeProvider } from '#/component/theme-provider'
import { TooltipProvider } from '#/components/ui/tooltip'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Basic Canvas',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({  }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>


        <ThemeProvider defaultTheme="system" storageKey="theme">
                  <Outlet />
        </ThemeProvider>
        </TooltipProvider>

        <Scripts />
      </body>
    </html>
  )
}
