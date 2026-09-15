/**
 * Global test setup.
 *
 * Hermetic-suite guarantee (plan §8): no test may issue a network request. Any
 * attempt fails the test loudly rather than silently hitting SBI/RBI/an LLM.
 */
import { beforeEach, afterEach } from 'vitest';

const originalFetch = globalThis.fetch;

class NetworkAccessInTestError extends Error {
  constructor(target: string) {
    super(
      `Network access attempted in a test (target: ${target}). ` +
        'Tests are hermetic — stub the EgressGateway or use a fixture in tests/fixtures/.',
    );
    this.name = 'NetworkAccessInTestError';
  }
}

beforeEach(() => {
  globalThis.fetch = ((input: unknown) => {
    throw new NetworkAccessInTestError(String(input));
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
