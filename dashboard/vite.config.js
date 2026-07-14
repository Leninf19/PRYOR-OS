import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Was 6000 (silencing the warning instead of addressing it). Now that
    // pages are route-split (see App.jsx's React.lazy), the vendor chunk
    // (react+react-dom+recharts, ~525KB) is the largest real chunk -- set
    // just above it so a genuinely oversized future chunk still warns.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'recharts'],
        },
      },
    },
  },
})
