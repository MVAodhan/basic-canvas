import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import netlify from '@netlify/vite-plugin-tanstack-start'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    // The Netlify plugin emulates Edge Functions locally, which requires
    // spawning a Deno CLI version compatible with its flags. Skip it in
    // local dev (the app uses no Netlify features); on Netlify's build
    // servers the NETLIFY env var is set, so the adapter still loads for
    // deployments.
    ...(process.env.NETLIFY ? [netlify()] : []),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config

export default config
