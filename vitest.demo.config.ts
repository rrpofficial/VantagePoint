import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(root, `packages/${name}/src/index.ts`);

/**
 * The walking skeleton (`pnpm demo`). Standalone rather than `mergeConfig(base, …)`:
 * vitest merges array options by concatenation, so extending the base config would
 * run the entire suite alongside it — the same trap the container config hit.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@vantagepoint/shared-kernel': pkg('shared-kernel'),
      '@vantagepoint/core-domain': pkg('core-domain'),
      '@vantagepoint/fx-itbr': pkg('fx-itbr'),
      '@vantagepoint/tax-engine': pkg('tax-engine'),
      '@vantagepoint/snapshot': pkg('snapshot'),
      '@vantagepoint/ingestion': pkg('ingestion'),
      '@vantagepoint/compliance': pkg('compliance'),
      '@vantagepoint/pii-masker': pkg('pii-masker'),
      '@vantagepoint/persistence': pkg('persistence'),
      '@vantagepoint/adapters-fx': pkg('adapters-fx'),
      '@vantagepoint/app-services': pkg('app-services'),
      '@vantagepoint/platform': pkg('platform'),
      '@vantagepoint/test-kit': path.resolve(root, 'tests/test-kit/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/manual/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
  },
});
