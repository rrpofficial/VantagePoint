/**
 * US-8.8 — Backup, restore and export (PRD NFR-1); Phase 7.
 *
 * The round trip that matters is not "the file exists". It is: take a backup,
 * restore it into a directory that has never held a vault, unlock with the same
 * passphrase, and get the SAME net worth back. An untested restore is not a
 * backup — the failure surfaces only when the original is already gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupUC,
  EditModeUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { Backup, SnapshotRepository, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const dir = () => mkdtempSync(join(tmpdir(), 'vantagepoint-backup-'));
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

/** A vault only exists on disk once it has been unlocked — migrations run then. */
async function openedVault(dataDir = dir()): Promise<string> {
  expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  return dataDir;
}

/** Through `VaultUC`, so the in-memory profile and rate store follow the vault. */
async function unlockedVault(dataDir = dir()): Promise<string> {
  expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  return dataDir;
}

const netWorth = async (): Promise<string> =>
  expectOk(await ValuePortfolioUC.execute('2026-09-15T00:00:00+00:00')).netWorth.amount;

beforeEach(() => {
  resetPorts();
});

afterEach(async () => {
  await Vault.close();
});

describe('US-8.8 Scenario: Encrypted backup round-trips exactly', () => {
  it('produces a backup artifact on disk', async () => {
    await openedVault();
    const path = expectOk(await Backup.backup(join(dir(), 'backup.vpb')));
    expect(existsSync(path)).toBe(true);
  });

  it('refuses to back up a vault that was never unlocked', async () => {
    expectOk(await Vault.open({ dataDir: dir(), fileName: 'vault.db' }));
    const result = await Backup.backup(join(dir(), 'backup.vpb'));
    expect(result.ok).toBe(false);
  });

  it('restores every snapshot with an identical contentHash', async () => {
    await openedVault();
    const before = await SnapshotRepository.listIds();
    const hashesBefore = await Promise.all(
      before.map(async (id) => (await SnapshotRepository.findById(id))?.contentHash),
    );

    const archive = expectOk(await Backup.backup(join(dir(), 'backup.vpb')));
    const target = dir();
    expectOk(await Backup.restore(archive, target));
    await Vault.close();
    expectOk(await Vault.open({ dataDir: target, fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));

    const after = await SnapshotRepository.listIds();
    const hashesAfter = await Promise.all(
      after.map(async (id) => (await SnapshotRepository.findById(id))?.contentHash),
    );
    expect(after).toEqual(before);
    expect(hashesAfter).toEqual(hashesBefore);
  });

  it('keeps the backup encrypted at rest', async () => {
    await openedVault();
    const archive = expectOk(await Backup.backup(join(dir(), 'backup.vpb')));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(archive, 'latin1')).not.toContain('ABCDE1234F');
  });
});

/**
 * Phase 7 — the wired path. `Backup` was correct and complete from US-8.8 and
 * had no use case, route or button; these exercise the one a user can reach.
 */
describe('Phase 7 Scenario: A backup taken from Settings restores to the same net worth', () => {
  it('restores into an empty directory and reports the same figure', async () => {
    await unlockedVault();
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-06-02',
        symbol: 'INFY',
        quantity: '100',
        pricePerUnit: inr('1500'),
      }),
    );
    const before = await netWorth();
    expect(before).not.toBe('0');

    const archive = expectOk(await BackupUC.create());
    expect(archive.fileName).toMatch(/^VantagePoint-backup-.*\.vpb$/);

    // A directory that has never held a vault — the disaster-recovery path.
    await Vault.close();
    const fresh = dir();
    expectOk(await Vault.open({ dataDir: fresh, fileName: 'vault.db' }));
    const report = expectOk(await BackupUC.restore(archive.bytes));
    expect(report.replacedExistingVault).toBe(false);

    expectOk(await VaultUC.unlock(PASSPHRASE));
    expect(await netWorth()).toBe(before);
  });

  it('leaves the restored vault locked, so it opens with the archive’s own passphrase', async () => {
    await unlockedVault();
    const archive = expectOk(await BackupUC.create());

    await Vault.close();
    expectOk(await Vault.open({ dataDir: dir(), fileName: 'vault.db' }));
    expectOk(await BackupUC.restore(archive.bytes));

    expect(Vault.isUnlocked()).toBe(false);
  });

  it('refuses to back up a locked vault', async () => {
    expectOk(await Vault.open({ dataDir: dir(), fileName: 'vault.db' }));
    expect((await BackupUC.create()).ok).toBe(false);
  });

  /*
   * The archive is JSON, so any JSON file parses. Without the magic string a
   * restore would write whatever `database` happened to decode to over the
   * vault, and the user would discover that with nothing left to compare it to.
   */
  it('refuses a file that is not a VantagePoint archive, leaving the vault untouched', async () => {
    const dataDir = await unlockedVault();
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-06-02',
        symbol: 'INFY',
        quantity: '10',
        pricePerUnit: inr('1500'),
      }),
    );
    const before = await netWorth();
    expectOk(await EditModeUC.enable(PASSPHRASE));

    const notAnArchive = new Uint8Array(Buffer.from('{"hello":"world"}', 'utf8'));
    const result = await BackupUC.restore(notAnArchive);
    expect(result.ok).toBe(false);

    expectOk(await VaultUC.unlock(PASSPHRASE));
    expect(await netWorth()).toBe(before);
    expect(existsSync(join(dataDir, 'vault.db'))).toBe(true);
  });

  it('refuses to restore over an existing vault while edit mode is off', async () => {
    await unlockedVault();
    const archive = expectOk(await BackupUC.create());

    const result = await BackupUC.restore(archive.bytes);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EDIT_MODE_REQUIRED');
    // Refused BEFORE the vault was closed, so the session is still usable.
    expect(Vault.isUnlocked()).toBe(true);
  });

  it('copies the vault it replaces aside, so a wrong restore is recoverable', async () => {
    await unlockedVault();
    const archive = expectOk(await BackupUC.create());
    expectOk(await EditModeUC.enable(PASSPHRASE));

    const report = expectOk(await BackupUC.restore(archive.bytes));

    expect(report.replacedExistingVault).toBe(true);
    expect(report.supersededCopy).toBeDefined();
    expect(existsSync(report.supersededCopy ?? '')).toBe(true);
    expect(existsSync(`${report.supersededCopy ?? ''}.meta.json`)).toBe(true);
  });

  /*
   * The salt is the half a naive backup drops. A database restored without it
   * derives a different key from the same passphrase and fails `quick_check`,
   * which reads as a wrong passphrase — the most misleading possible failure.
   */
  it('carries the key-derivation salt, so the restored vault opens at all', async () => {
    await unlockedVault();
    const archive = expectOk(await BackupUC.create());

    const target = dir();
    expectOk(await Backup.restoreBytes(archive.bytes, target));
    expect(existsSync(join(target, 'vault.db.meta.json'))).toBe(true);

    await Vault.close();
    expectOk(await Vault.open({ dataDir: target, fileName: 'vault.db' }));
    expectOk(await VaultUC.unlock(PASSPHRASE));
  });

  it('refuses an archive whose key metadata is unreadable, before writing anything', async () => {
    const target = dir();
    const corrupt = new Uint8Array(
      Buffer.from(
        JSON.stringify({
          magic: 'vantagepoint.vault.backup',
          version: 1,
          database: Buffer.from('not a database').toString('base64'),
          meta: 'this is not json',
        }),
        'utf8',
      ),
    );

    const result = await Backup.restoreBytes(corrupt, target);

    expect(result.ok).toBe(false);
    expect(existsSync(join(target, 'vault.db'))).toBe(false);
  });

  it('accepts a version-1 archive written before the magic string existed', async () => {
    await unlockedVault();
    const archive = expectOk(await BackupUC.create());
    const parsed = JSON.parse(Buffer.from(archive.bytes).toString('utf8')) as Record<string, unknown>;
    delete parsed.magic;

    const legacy = join(dir(), 'legacy.vpb');
    writeFileSync(legacy, JSON.stringify(parsed));
    const target = dir();

    expectOk(await Backup.restore(legacy, target));
    await Vault.close();
    expectOk(await Vault.open({ dataDir: target, fileName: 'vault.db' }));
    expectOk(await VaultUC.unlock(PASSPHRASE));
  });
});
