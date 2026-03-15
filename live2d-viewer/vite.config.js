import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/chat': 'http://localhost:4000',
      '/avatar': 'http://localhost:4000',
      '/environment': 'http://localhost:4000',
      '/customize': 'http://localhost:4000',
    },
  },
})
