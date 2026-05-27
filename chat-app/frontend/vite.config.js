import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'Chat App',
        short_name: 'ChatApp',
        description: 'A simple real-time chat application',
        theme_color: '#ffffff'
      },
      devOptions: {
        enabled: true
      }
    })
  ],
})
