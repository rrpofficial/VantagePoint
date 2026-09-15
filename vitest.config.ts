import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(root, `packages/${name}/src/index.ts`);

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
      '@vantagepoint/exporters': pkg('exporters'),
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
    include: ['packages/**/test/**/*.spec.ts', 'tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**', 'tests/container/**', 'tests/manual/**'],
    setupFiles: ['tests/test-kit/setup.ts'],
    /*
     * Deletes the temporary vaults the suite opens. Without it every run leaves
     * a directory per test behind, and they accumulate until the disk fills —
     * which surfaces as `VAULT_UNLOCK_FAILED` from unrelated tests rather than
     * as the ENOSPC it actually is.
     */
    globalSetup: ['tests/test-kit/teardown.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
