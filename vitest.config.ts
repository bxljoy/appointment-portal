import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'infra',
          include: ['infra/test/**/*.test.ts'],
          // These cases run real esbuild/CDK synthesis, not just in-memory assertions.
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test/setup.ts'],
        },
      },
    ],
  },
});
