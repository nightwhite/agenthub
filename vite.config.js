import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm/')) {
            return 'xterm-vendor'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/@labring/sealos-desktop-sdk')) {
            return 'sealos-sdk'
          }
          if (id.includes('node_modules')) {
            return 'vendor'
          }
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/k8s-api': {
        target: 'https://usw-1.sealos.io:6443',
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/k8s-api/, ''),
        router: (req) => {
          const customServer = req.headers['x-k8s-server']
          if (typeof customServer === 'string' && customServer.trim()) {
            return customServer.trim()
          }
          return 'https://usw-1.sealos.io:6443'
        },
        configure: (proxy) => {
          const normalizeAuthorization = (value) => {
            if (typeof value !== 'string') return ''
            const raw = value.trim()
            if (!raw) return ''
            const token = raw.replace(/^Bearer\s+/i, '').replace(/\s+/g, '')
            if (!token) return ''
            return `Bearer ${token}`
          }

          const applyProxyHeaders = (proxyReq, req) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
            proxyReq.removeHeader('cookie')
            proxyReq.removeHeader('sec-fetch-site')
            proxyReq.removeHeader('sec-fetch-mode')
            proxyReq.removeHeader('sec-fetch-dest')

            proxyReq.removeHeader('x-k8s-server')

            const customServer = req?.headers?.['x-k8s-server']
            if (typeof customServer === 'string' && customServer.trim()) {
              try {
                const targetUrl = new URL(customServer.trim())
                proxyReq.setHeader('host', targetUrl.host)
                return targetUrl.host
              } catch {
                // fallthrough
              }
            }

            proxyReq.setHeader('host', 'usw-1.sealos.io:6443')
            return 'usw-1.sealos.io:6443'
          }

          proxy.on('proxyReq', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
            const normalizedAuthorization = normalizeAuthorization(req?.headers?.authorization)
            proxyReq.removeHeader('authorization')
            if (normalizedAuthorization) {
              proxyReq.setHeader('authorization', normalizedAuthorization)
            }
          })

          proxy.on('proxyReqWs', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
            const normalizedAuthorization = normalizeAuthorization(req?.headers?.authorization)
            proxyReq.removeHeader('authorization')
            if (normalizedAuthorization) {
              proxyReq.setHeader('authorization', normalizedAuthorization)
            }
          })
        },
      },
      '/chat-api': {
        target: 'https://nntlgzzjjfcz.staging-usw-1.sealos.io',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/chat-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
            proxyReq.setHeader('host', 'nntlgzzjjfcz.staging-usw-1.sealos.io')
          })
        },
      },
      '/chat-api-ws': {
        target: 'wss://nntlgzzjjfcz.staging-usw-1.sealos.io',
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/chat-api-ws/, ''),
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
            proxyReq.setHeader('host', 'nntlgzzjjfcz.staging-usw-1.sealos.io')
          })
        },
      },
    },
  },
})
