import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The Express server (npm run dev in the project root)
const API_SERVER = 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Forwards API and WebSocket traffic to Express, so the browser sees one
    // origin in development, just like in production where Express serves this app
    proxy: {
      '/matches': API_SERVER,
      '/ws': { target: API_SERVER, ws: true },
    },
  },
})
