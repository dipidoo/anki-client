import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Pages serves the app under /anki-client/ on github.io
export default defineConfig({
  base: '/anki-client/',
  plugins: [preact()],
  build: {
    // Keep sourcemaps for now — minified stacks aren't debuggable from an iPhone.
    // ~50KB extra over the wire, fine. Revisit once shape stabilizes.
    sourcemap: true,
  },
});
