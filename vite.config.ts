import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { VitePWA } from 'vite-plugin-pwa'

const gitHash = process.env.BUILD_GIT_HASH || 'dev'
const buildTime = new Date().toISOString()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(`${gitHash} (${buildTime})`),
  },
  plugins: [
    react(),
    // React 19 compiler — auto-memoizes components/hooks, reducing the need
    // for manual useCallback/useMemo wrapping. Runs as a Babel preset
    // through @rolldown/plugin-babel.
    babel({ presets: [reactCompilerPreset()] }),
    VitePWA({
      // Auto-update: a fresh SW is generated each build and replaces the
      // active one on next navigation. No prompt, no extra UI.
      registerType: 'autoUpdate',
      // Our manifest is hand-maintained in public/manifest.webmanifest and
      // already linked from index.html. Don't let the plugin emit a second
      // one — but DO precache it so the install screen works offline.
      manifest: false,
      includeAssets: [
        'favicon.svg',
        'favicon.ico',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'manifest.webmanifest',
      ],
      workbox: {
        // App shell: precache all JS/CSS/HTML/fonts/icons emitted by Vite,
        // plus the assets listed above. Limit single-file size to 6 MB so
        // the airport-noise pmtiles archive (if it ever ends up under
        // /dist) isn't bundled into the precache manifest.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Don't intercept API calls or the noise pmtiles — they have their
        // own caching strategies below.
        navigateFallbackDenylist: [/^\/(overpass|overpass2|data|api)\//],
        runtimeCaching: [
          {
            // Map tiles — Google, TomTom, ESRI, OSM. Network-first so users
            // see fresh tiles when online, but the last-seen tile renders
            // when offline.
            urlPattern: ({ url }) =>
              /(tile\.googleapis\.com|api\.tomtom\.com|tile\.openstreetmap\.org|server\.arcgisonline\.com)$/.test(url.host),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
              networkTimeoutSeconds: 5,
            },
          },
          {
            // Static map images (Street View, etc.) from Google Maps APIs.
            urlPattern: ({ url }) => url.host === 'maps.googleapis.com',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'google-maps-api',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
              networkTimeoutSeconds: 5,
            },
          },
          {
            // Overpass / GIS responses (same-origin via nginx proxy).
            urlPattern: ({ url }) => /^\/(overpass|overpass2|api)\//.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'gis-api',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
              networkTimeoutSeconds: 6,
            },
          },
          {
            // PMTiles archive(s) — bytes are huge but immutable, so cache
            // aggressively. Workbox only stores range-request responses
            // that the browser tags as cacheable; pmtiles.js issues HTTP
            // Range requests so this caches partial archives.
            urlPattern: ({ url }) => /\.pmtiles$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pmtiles',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200, 206] },
              rangeRequests: true,
            },
          },
        ],
      },
      devOptions: {
        // Disabled in dev to keep HMR/Overpass proxy snappy. Toggle to true
        // when validating SW behavior locally.
        enabled: false,
      },
    }),
  ],
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
      '/overpass2': {
        target: 'https://overpass.kumi.systems',
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
