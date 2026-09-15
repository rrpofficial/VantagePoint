import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(root, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@porttrack/shared-kernel': pkg('shared-kernel'),
      '@porttrack/core-domain': pkg('core-domain'),
      '@porttrack/fx-itbr': pkg('fx-itbr'),
      '@porttrack/tax-engine': pkg('tax-engine'),
      '@porttrack/snapshot': pkg('snapshot'),
      '@porttrack/ingestion': pkg('ingestion'),
      '@porttrack/compliance': pkg('compliance'),
      '@porttrack/exporters': pkg('exporters'),
      '@porttrack/pii-masker': pkg('pii-masker'),
      '@porttrack/persistence': pkg('persistence'),
      '@porttrack/adapters-fx': pkg('adapters-fx'),
      '@porttrack/app-services': pkg('app-services'),
      '@porttrack/platform': pkg('platform'),
      '@porttrack/test-kit': path.resolve(root, 'tests/test-kit/index.ts'),
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
