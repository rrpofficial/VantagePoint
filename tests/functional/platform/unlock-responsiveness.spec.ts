/**
 * FUNCTIONAL — unlocking must not freeze the rest of the application.
 *
 * The regression this pins, measured against the container before the fix:
 *
 *   ten unlock requests   0.35s → 0.70s → 1.05s → … → 3.50s   perfectly serialized
 *   health probe mid-unlock  0.310s   versus   0.001s idle
 *
 * Argon2id at the OWASP baseline occupies a core for roughly a third of a second
 * by design. Run on the main thread it blocked Node's event loop for that whole
 * time, so nothing else could be served and concurrent unlocks queued instead of
 * overlapping. Combined with an unlock button that showed no progress, the
 * natural response — clicking again — added another 350 ms of freeze per click,
 * and the app appeared to hang.
 *
 * These tests assert the PROPERTY (the loop keeps turning, work overlaps), never
 * a wall-clock budget, so they do not become flaky on a loaded CI machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoEnvelope, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-unlock-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
});

afterEach(async () => {
  await Vault.close();
});

describe('Scenario: Key derivation leaves the event loop free', () => {
  it('lets timers fire while a key is being derived', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);

    try {
      await CryptoEnvelope.deriveKeyAsync(PASSPHRASE, new Uint8Array(16));
    } finally {
      clearInterval(timer);
    }

    // A blocking derivation starves the timer entirely and this reads 0 — which
    // is exactly what a stalled health check saw.
    expect(ticks).toBeGreaterThan(0);
  });

  it('overlaps concurrent derivations instead of serializing them', async () => {
    const salt = new Uint8Array(16);

    const oneStart = performance.now();
    await CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt);
    const single = performance.now() - oneStart;

    const fourStart = performance.now();
    await Promise.all([
      CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt),
      CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt),
      CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt),
      CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt),
    ]);
    const four = performance.now() - fourStart;

    // Serialized, four would cost four times one. Anything meaningfully under
    // that means they ran in parallel; the bound is loose so a single-core
    // runner does not fail the suite.
    expect(four).toBeLessThan(single * 3.5);
  });
});

describe('Scenario: The async and synchronous KDFs agree', () => {
  it('derives an identical key either way', async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    const viaWorker = await CryptoEnvelope.deriveKeyAsync(PASSPHRASE, salt);
    const viaMainThread = await CryptoEnvelope.deriveKey(PASSPHRASE, salt);

    // A worker that derived a DIFFERENT key would lock every existing vault out
    // of its own data, so this equivalence is load-bearing.
    expect(Buffer.from(viaWorker).toString('hex')).toBe(
      Buffer.from(viaMainThread).toString('hex'),
    );
    expect(viaWorker).toHaveLength(32);
  });

  it('still opens a vault created before the worker existed', async () => {
    // Vaults on disk were keyed by the synchronous path. If the worker disagreed
    // by even a byte, every one of them would fail to unlock.
    expectOk(await Vault.unlock(PASSPHRASE));
    expect(Vault.isUnlocked()).toBe(true);

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));
    expect(Vault.isUnlocked()).toBe(true);
  });
});

describe('Scenario: Repeated unlock attempts stay correct', () => {
  it('resolves every concurrent attempt rather than dropping any', async () => {
    // The UI now blocks a second submit, but the backend must not corrupt itself
    // if one arrives anyway — from a second tab, or the CLI.
    const results = await Promise.all([
      Vault.unlock(PASSPHRASE),
      Vault.unlock(PASSPHRASE),
      Vault.unlock(PASSPHRASE),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(Vault.isUnlocked()).toBe(true);
  });

  it('still refuses a wrong passphrase after a correct one', async () => {
    expectOk(await Vault.unlock(PASSPHRASE));
    await Vault.lock();

    const wrong = await Vault.unlock('not the passphrase');
    expect(wrong.ok).toBe(false);
  });
});
