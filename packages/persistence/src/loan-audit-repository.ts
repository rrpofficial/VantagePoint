/**
 * Hand-loan audit trail persistence (US-1.11).
 *
 * Append and read. There is deliberately no update and no delete: the value of
 * a trail is precisely that it cannot be tidied up, and a repository that
 * offered `amend` would make the table decorative.
 *
 * Rows are NOT cascade-deleted with their loan — see the v6 migration. That
 * means `listFor` can return entries for a loan that no longer exists, which is
 * the intended behaviour rather than an oversight.
 */
import { Err, Ok, VaultStateError, type Result } from '@vantagepoint/shared-kernel';
import type { LoanAuditAction, LoanAuditEntry } from '@vantagepoint/core-domain';
import { Vault } from './vault.js';

interface AuditRow {
  entry_id: string;
  asset_id: string;
  action: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  recorded_at: string;
}

function toEntry(row: AuditRow): LoanAuditEntry {
  return {
    entryId: row.entry_id,
    loanId: row.asset_id,
    action: row.action as LoanAuditAction,
    recordedAt: row.recorded_at,
    ...(row.field === null ? {} : { field: row.field }),
    ...(row.old_value === null ? {} : { oldValue: row.old_value }),
    ...(row.new_value === null ? {} : { newValue: row.new_value }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

export const LoanAuditRepository = {
  append(entries: readonly LoanAuditEntry[]): Promise<Result<void>> {
    if (entries.length === 0) return Promise.resolve(Ok(undefined));
    if (!Vault.isUnlocked()) {
      return Promise.resolve(Err(new VaultStateError('vault is locked')));
    }

    const db = Vault.connection();
    const insert = db.prepare(
      `INSERT INTO hand_loan_audit
         (entry_id, asset_id, action, field, old_value, new_value, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.entryId,
          entry.loanId,
          entry.action,
          entry.field ?? null,
          entry.oldValue ?? null,
          entry.newValue ?? null,
          entry.reason ?? null,
          entry.recordedAt,
        );
      }
    })();

    return Promise.resolve(Ok(undefined));
  },

  /** Newest first: the last thing that happened is the thing being asked about. */
  listFor(loanId: string): Promise<readonly LoanAuditEntry[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare(
        `SELECT * FROM hand_loan_audit
          WHERE asset_id = ?
          ORDER BY recorded_at DESC, rowid DESC`,
      )
      .all(loanId) as AuditRow[];
    return Promise.resolve(rows.map(toEntry));
  },

  all(): Promise<readonly LoanAuditEntry[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT * FROM hand_loan_audit ORDER BY recorded_at DESC, rowid DESC')
      .all() as AuditRow[];
    return Promise.resolve(rows.map(toEntry));
  },
};
