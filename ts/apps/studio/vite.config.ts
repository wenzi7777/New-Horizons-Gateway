// The renderer bundle of NH Studio. The app root (apps/studio) is Vite's
// root so index.html sits beside package.json; the bundle goes to
// dist/renderer with relative asset paths (base './') so Electron can load
// it from file://. `vite` alone serves the renderer in a plain browser on
// the mock StudioApi (src/renderer/mock.ts). splash.html is the start-up
// splash (src/renderer/splash/), a second page of the same build.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    // The ts/ workspace also holds NH Pocket (React Native), so npm hoists a
    // second React to the root; packages resolved from there (lucide-react)
    // would otherwise bundle it next to Studio's own and break every hook.
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      // Two pages: the app (index.html) and the start-up splash (splash.html).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
