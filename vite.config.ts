import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [solid(), crx({ manifest })],
});
