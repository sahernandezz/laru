import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API comes from `laru serve` on 4100; open the token URL there once so the cookie exists.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4100' } },
});
