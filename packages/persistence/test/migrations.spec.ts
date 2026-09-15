/**
 * US-8.3 — Repository layer and migrations (PRD NFR-1)
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, MigrationRunner, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const dataDir = () => mkdtempSync(join(tmpdir(), 'vantagepoint-migrate-'));

async function unlockedVault(dir = dataDir()) {
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  const handle = expectOk(await Vault.unlock(PASSPHRASE));
  return { dir, handle };
}

describe('US-8.3 Scenario: Migrations are forward-only and versioned', () => {
  it('brings an empty database to the current schema version', async () => {
    const { handle } = await unlockedVault();
    expect(handle.schemaVersion).toBe(MIGRATIONS.length);
    await Vault.close();
  });

  it('is a no-op on a second run', async () => {
    await unlockedVault();
    const first = expectOk(await MigrationRunner.run());
    const second = expectOk(await MigrationRunner.run());
    expect(second).toBe(first);
    await Vault.close();
  });

  it('reports the applied version through currentVersion()', async () => {
    await unlockedVault();
    expect(await MigrationRunner.currentVersion()).toBe(MIGRATIONS.length);
    await Vault.close();
  });

  it('persists the schema across lock and unlock', async () => {
    const dir = dataDir();
    await unlockedVault(dir);
    await Vault.close();

    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    const reopened = expectOk(await Vault.unlock(PASSPHRASE));
    expect(reopened.schemaVersion).toBe(MIGRATIONS.length);
    await Vault.close();
  });

  it('declares strictly increasing, contiguous migration versions', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });

  it('creates every table the ledger depends on', async () => {
    await unlockedVault();
    const names = Vault.connection()
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tables = names.map((row) => row.name);
    for (const table of ['assets', 'lots', 'liabilities', 'hand_loans', 'snapshots']) {
      expect(tables).toContain(table);
    }
    await Vault.close();
  });

  it('stores money columns as TEXT, never REAL (ADR-002)', async () => {
    await unlockedVault();
    const columns = Vault.connection().prepare('PRAGMA table_info(lots)').all() as {
      name: string;
      type: string;
    }[];
    for (const column of ['cost_per_unit', 'quantity', 'remaining_quantity', 'fees', 'stt']) {
      const found = columns.find((c) => c.name === column);
      expect(found?.type, `${column} must not be a float column`).toBe('TEXT');
    }
    await Vault.close();
  });

  it('enforces foreign keys once unlocked', async () => {
    await unlockedVault();
    expect(Vault.connection().pragma('foreign_keys', { simple: true })).toBe(1);
    await Vault.close();
  });
});

describe('US-8.3 Scenario: The vault refuses work while locked', () => {
  it('throws when a connection is requested before unlock', async () => {
    expectOk(await Vault.open({ dataDir: dataDir(), fileName: 'vault.db' }));
    expect(() => Vault.connection()).toThrowError(/locked/i);
    await Vault.close();
  });

  it('reports isUnlocked false before unlock and true after', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    expect(Vault.isUnlocked()).toBe(false);
    expectOk(await Vault.unlock(PASSPHRASE));
    expect(Vault.isUnlocked()).toBe(true);
    await Vault.close();
  });

  it('locks again on request', async () => {
    await unlockedVault();
    await Vault.lock();
    expect(Vault.isUnlocked()).toBe(false);
    await Vault.close();
  });
});
