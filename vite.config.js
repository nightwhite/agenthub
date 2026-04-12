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
        target: 'https://staging-usw-1.sealos.io:6443',
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/k8s-api/, ''),
        router: (req) => {
          const customServer = req.headers['x-k8s-server']
          if (typeof customServer === 'string' && customServer.trim()) {
            return customServer.trim()
          }
          return 'https://staging-usw-1.sealos.io:6443'
        },
        configure: (proxy) => {
          const applyProxyHeaders = (proxyReq, req) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')

            const customServer = req?.headers?.['x-k8s-server']
            if (typeof customServer === 'string' && customServer.trim()) {
              try {
                const targetUrl = new URL(customServer.trim())
                proxyReq.setHeader('host', targetUrl.host)
                return
              } catch {
                // fallthrough
              }
            }

            proxyReq.setHeader('host', 'staging-usw-1.sealos.io:6443')
          }

          proxy.on('proxyReq', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
          })

          proxy.on('proxyReqWs', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
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
