import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Pages serves the app under /anki-client/ on github.io
export default defineConfig({
  base: '/anki-client/',
  plugins: [preact()],
});
