import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Change this ONE value to match your GitHub repo name exactly (with
// leading and trailing slashes), or to '/' if using Firebase/Vercel/
// Netlify instead. Everything below reads from this single constant —
// base, start_url, and scope all need to agree with each other, or
// "Add to Home Screen" ends up pointing at the wrong URL (start_url and
// scope don't automatically inherit from `base`, they're independent
// settings that happened to cause exactly that bug when left as '/').
const BASE_PATH = '/budget-tracker/'

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Budget Tracker',
        short_name: 'Budget',
        description: 'Local-first personal budgeting',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: BASE_PATH,
        scope: BASE_PATH,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // pdfParser is dynamically imported specifically so it ISN'T
        // downloaded by everyone on first visit — only precaching every
        // .js file by default would silently undo that, since Workbox
        // doesn't distinguish "loaded on startup" from "loaded on demand"
        // without being told. It's still cached the first time someone
        // actually opens PDF import, just not before then.
        globIgnores: ['**/pdfParser-*.js']
      }
    })
  ]
})
