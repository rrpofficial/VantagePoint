/**
 * Snapshot persistence (US-3.1, ADR-006).
 *
 * Write-once. Re-persisting an id whose content hash differs is refused: a frozen
 * compliance artifact that silently changes is worse than none, because it is
 * still trusted. Re-persisting an IDENTICAL snapshot is a no-op, so a scheduler
 * that runs twice is harmless.
 */
import { Err, Ok, SnapshotDivergenceError, type Result } from '@vantagepoint/shared-kernel';
import type { Snapshot } from '@vantagepoint/snapshot';
import { Vault } from './vault.js';

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly payload: string;
  readonly content_hash: string;
}

interface SummaryRow {
  readonly snapshot_id: string;
  readonly kind: string;
  readonly scope: string;
  readonly as_of: string;
  readonly content_hash: string;
  readonly created_at: string;
}

export interface SnapshotSummary {
  readonly snapshotId: string;
  readonly kind: string;
  readonly scope: string;
  readonly asOf: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export const SnapshotRepository = {
  persistImmutable(snapshot: Snapshot): Promise<Result<void>> {
    const db = Vault.connection();
    const existing = db
      .prepare('SELECT snapshot_id, payload, content_hash FROM snapshots WHERE snapshot_id = ?')
      .get(snapshot.snapshotId) as SnapshotRow | undefined;

    if (existing !== undefined) {
      if (existing.content_hash === snapshot.contentHash) return Promise.resolve(Ok(undefined));
      return Promise.resolve(
        Err(
          new SnapshotDivergenceError(
            `snapshot ${snapshot.snapshotId} already exists with a different content hash; ` +
              'a frozen snapshot is never overwritten',
          ),
        ),
      );
    }

    db.prepare(
      `INSERT INTO snapshots (snapshot_id, kind, scope, as_of, payload, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshot.snapshotId,
      snapshot.kind,
      snapshot.scope,
      snapshot.asOf,
      JSON.stringify(snapshot),
      snapshot.contentHash,
      snapshot.createdAt,
    );
    return Promise.resolve(Ok(undefined));
  },

  findById(snapshotId: string): Promise<Snapshot | undefined> {
    if (!Vault.isUnlocked()) return Promise.resolve(undefined);
    const row = Vault.connection()
      .prepare('SELECT payload FROM snapshots WHERE snapshot_id = ?')
      .get(snapshotId) as { payload: string } | undefined;
    return Promise.resolve(row === undefined ? undefined : (JSON.parse(row.payload) as Snapshot));
  },

  exists(snapshotId: string): Promise<boolean> {
    if (!Vault.isUnlocked()) return Promise.resolve(false);
    const row = Vault.connection()
      .prepare('SELECT 1 AS present FROM snapshots WHERE snapshot_id = ?')
      .get(snapshotId);
    return Promise.resolve(row !== undefined);
  },

  /**
   * Summaries for the snapshot list. Deliberately not the full payload: a
   * listing of twenty snapshots would otherwise deserialise twenty complete
   * portfolios to show twenty rows.
   */
  list(): Promise<readonly SnapshotSummary[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare(
        `SELECT snapshot_id, kind, scope, as_of, content_hash, created_at
         FROM snapshots ORDER BY as_of DESC, snapshot_id`,
      )
      .all() as SummaryRow[];
    return Promise.resolve(
      rows.map((row) => ({
        snapshotId: row.snapshot_id,
        kind: row.kind,
        scope: row.scope,
        asOf: row.as_of,
        contentHash: row.content_hash,
        createdAt: row.created_at,
      })),
    );
  },

  listIds(): Promise<readonly string[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT snapshot_id FROM snapshots ORDER BY as_of')
      .all() as { snapshot_id: string }[];
    return Promise.resolve(rows.map((row) => row.snapshot_id));
  },
};
