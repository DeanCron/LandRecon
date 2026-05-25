import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy Overpass API through the dev server so the client can use
      // a same-origin request. Matches the nginx /overpass route used
      // in production. We inject a non-Mozilla User-Agent because
      // overpass-api.de rejects Mozilla-style UAs (used by all browsers).
      '/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/api/interpreter',
        headers: {
          'User-Agent': 'LandRecon/1.0',
        },
      },
    },
  },
})
