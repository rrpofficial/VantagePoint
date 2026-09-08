/**
 * persistence — encrypted SQLite vault on the HOST bind mount (ADR-012),
 * page-level AES-256-CBC + HMAC-SHA512 whole-file encryption (ADR-015),
 * forward-only migrations, repositories.
 */
import type { Result } from '@porttrack/shared-kernel';
import type { Asset, ExitTransaction, Liability, LoanAuditEntry } from '@porttrack/core-domain';
import type { Snapshot } from '@porttrack/snapshot';
import { Vault } from './vault.js';
import { currentVersion, runMigrations } from './migrations.js';
import { deriveKey, deriveKeyAsync, zeroise } from './crypto.js';
export { SnapshotRepository, type SnapshotSummary } from './snapshot-repository.js';
export { Backup } from './backup.js';

export { Vault } from './vault.js';
export type { VaultConfig, VaultHandle } from './vault.js';
export { MIGRATIONS } from './migrations.js';

/** Key derivation and zeroisation for the vault (ADR-014). */
export const CryptoEnvelope = {
  deriveKey: (passphrase: string, salt: Uint8Array): Promise<Uint8Array> =>
    Promise.resolve(deriveKey(passphrase, salt)),
  /** Off the event loop. What a server must use — see crypto.ts. */
  deriveKeyAsync: (passphrase: string, salt: Uint8Array): Promise<Uint8Array> =>
    deriveKeyAsync(passphrase, salt),
  zeroise,
};

export const MigrationRunner = {
  run: (): Promise<Result<number>> =>
    Promise.resolve({ ok: true, value: runMigrations(Vault.connection(), new Date().toISOString()) }),
  currentVersion: (): Promise<number> => Promise.resolve(currentVersion(Vault.connection())),
};

/* ---------------------------------------------------------- repositories */

export interface AssetRepositoryOps {
  save(asset: Asset): Promise<Result<void>>;
  /** One transaction for the batch, so a failed import commits nothing. */
  saveAll(assets: readonly Asset[]): Promise<Result<void>>;
  findById(assetId: string): Promise<Asset | undefined>;
  all(): Promise<readonly Asset[]>;
  deleteAll(): Promise<Result<void>>;
}

export interface LiabilityRepositoryOps {
  save(liability: Liability): Promise<Result<void>>;
  all(): Promise<readonly Liability[]>;
}

export interface SnapshotRepositoryOps {
  /** Write-once. Re-persisting an existing id with a different hash is an error. */
  persistImmutable(snapshot: Snapshot): Promise<Result<void>>;
  findById(snapshotId: string): Promise<Snapshot | undefined>;
  exists(snapshotId: string): Promise<boolean>;
  listIds(): Promise<readonly string[]>;
}

export interface BackupOps {
  backup(destination: string): Promise<Result<string>>;
  restore(source: string, destination: string): Promise<Result<void>>;
}

export interface ExitRepositoryOps {
  saveAll(exits: readonly ExitTransaction[]): Promise<Result<void>>;
  all(): Promise<readonly ExitTransaction[]>;
}

export interface LoanAuditRepositoryOps {
  /** Append-only. No update, no delete — that is what makes the trail evidence. */
  append(entries: readonly LoanAuditEntry[]): Promise<Result<void>>;
  listFor(loanId: string): Promise<readonly LoanAuditEntry[]>;
  all(): Promise<readonly LoanAuditEntry[]>;
}

export {
  AssetRepository,
  ExitRepository,
  LiabilityRepository,
  SettingsRepository,
} from './asset-repository.js';
export { LoanAuditRepository } from './loan-audit-repository.js';
export { ChitScheduleRepository } from './chit-schedule-repository.js';
