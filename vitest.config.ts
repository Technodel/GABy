import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/backups/**',
    ],
    env: {
      SUNY_SECRET_JWT: 'super-secret-key-change-in-production-123456',
    },
  },
});
