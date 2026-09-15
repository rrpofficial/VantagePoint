import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Container acceptance suite (PRD FR-8 / Module 8).
 *
 * Standalone rather than `mergeConfig(base, …)`: vitest merges array options by
 * concatenation, so extending the base config silently ran the unit suite too.
 *
 * Requires a Docker daemon — it builds real images and starts the real compose
 * stack, so timeouts are generous and files run serially (one stack at a time).
 * The global fetch trap is intentionally NOT loaded here: these tests are meant
 * to talk to the running containers.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@vantagepoint/test-kit': path.resolve(root, 'tests/test-kit/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/container/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
