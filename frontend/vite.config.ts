import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

const buildTimestamp = new Date().toISOString()

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test' || process.env.VITEST === 'true'

  return {
    define: {
      __APP_BUILD__: JSON.stringify(buildTimestamp),
    },
    resolve: {
      alias: isTest
        ? {
            'virtual:pwa-register': path.resolve(__dirname, 'src/test/pwa-register.ts'),
          }
        : undefined,
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Meal Planner',
          short_name: 'Meals',
          description: 'Plan your weekly meals',
          theme_color: '#0f766e',
          background_color: '#ffffff',
          display: 'standalone',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ]
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api/],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: /\/api\/auth\/.*/i,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /\/api\/.*/i,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'api-cache',
                expiration: {
                  maxEntries: 100,
                  maxAgeSeconds: 60 * 60 * 24 // 24 hours
                },
                networkTimeoutSeconds: 10,
                plugins: [
                  {
                    // Reject HTML responses (e.g. Cloudflare challenge pages) from
                    // being cached as API responses. Without this, a CF challenge
                    // page could be cached and served as stale "API data" indefinitely.
                    cacheWillUpdate: async ({ response }: { response: Response }) => {
                      const ct = response.headers.get('content-type') || '';
                      if (ct.includes('text/html')) {
                        return null; // Don't cache HTML
                      }
                      if (!response.ok) {
                        return null; // Don't cache error responses (401, 403, etc)
                      }
                      return response;
                    },
                  },
                ],
              }
            }
          ]
        }
      })
    ],
    server: {
      // Allow ngrok/tunnel services only when ALLOW_TUNNEL=true
      // Usage: ALLOW_TUNNEL=true npm run dev
      allowedHosts: process.env.ALLOW_TUNNEL === 'true'
        ? ['.ngrok-free.dev', '.ngrok.io']
        : [],
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          cookieDomainRewrite: 'localhost',
        }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  }
})
