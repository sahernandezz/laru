import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// In development the API comes from `laru serve` on 4100; open the token URL there once so the cookie exists.
export default defineConfig({
  plugins: [react()],
  define: { __LARU_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4100' } },
});
