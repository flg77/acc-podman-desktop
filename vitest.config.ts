import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // @podman-desktop/api ships types only (no JS entry).  In
      // unit tests we replace it with the per-test mock or the
      // shared stub below.
      '@podman-desktop/api': resolve(__dirname, './tests/_mocks/podman-desktop-api.ts'),
    },
  },
});
