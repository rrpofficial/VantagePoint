/**
 * FX rate persistence (US-2.1, PRD FR-2.1).
 *
 * The one repository in this package with a SYNCHRONOUS surface, and deliberately
 * so. Rate lookup sits inside `DualRateConverter.convert`, which is called from
 * pure valuation and capital-gains code on every position and every disposal.
 * Making it async would turn the whole of `fx-itbr`, `tax-engine` and
 * `core-domain` async for an operation that is a primary-key read against a
 * local file — better-sqlite3 is synchronous, so there is nothing to await.
 *
 * Write-once per (currency, date, source), matching the in-memory store it
 * replaces: re-putting an identical rate is idempotent, a differing one is a
 * conflict. Corrections travel the amendment path (US-2.6) so that a frozen
 * snapshot can never change value without a record of why.
 */
import {
  Err,
  Ok,
  RateConflictError,
  VaultStateError,
  type Currency,
  type DomainError,
  type IsoDate,
  type Result,
} from '@porttrack/shared-kernel';
import { Vault } from './vault.js';

/**
 * Structurally identical to `fx-itbr`'s RateRecord, declared here rather than
 * imported: persistence must not depend on a domain package, and the API test
 * asserts that boundary. The shape is pinned by a round-trip test.
 */
export interface StoredRate {
  readonly currency: Currency;
  readonly date: IsoDate;
  readonly rate: string;
  readonly source: string;
  readonly rateType: 'TTBR' | 'TTSR' | 'REFERENCE';
  readonly retrievedAt: string;
  readonly sourceDocumentRef: string;
}

interface RateRow {
  readonly currency: string;
  readonly rate_date: string;
  readonly source: string;
  readonly rate: string;
  readonly rate_type: string;
  readonly retrieved_at: string;
  readonly source_document_ref: string;
}

const toRate = (row: RateRow): StoredRate => ({
  currency: row.currency as Currency,
  date: row.rate_date,
  rate: row.rate,
  source: row.source,
  rateType: row.rate_type as StoredRate['rateType'],
  retrievedAt: row.retrieved_at,
  sourceDocumentRef: row.source_document_ref,
});

export const RateRepository = {
  put(record: StoredRate): Result<void> {
    if (!Vault.isUnlocked()) return Err(new VaultStateError('vault is locked'));
    const db = Vault.connection();

    const existing = db
      .prepare('SELECT * FROM fx_rates WHERE currency = ? AND rate_date = ? AND source = ?')
      .get(record.currency, record.date, record.source) as RateRow | undefined;

    if (existing !== undefined) {
      // Idempotent on an identical value: re-importing the same sheet, or seeding
      // the bundled dataset twice, must not be an error.
      if (existing.rate === record.rate) return Ok(undefined);
      return Err(
        new RateConflictError(
          `conflicting ${record.currency} rate for ${record.date} from ${record.source}: ` +
            `stored ${existing.rate}, received ${record.rate}`,
        ),
      );
    }

    db.prepare(
      `INSERT INTO fx_rates
         (currency, rate_date, source, rate, rate_type, retrieved_at, source_document_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.currency,
      record.date,
      record.source,
      record.rate,
      record.rateType,
      record.retrievedAt,
      record.sourceDocumentRef,
    );
    return Ok(undefined);
  },

  /**
   * One transaction for the batch: a rate sheet is all-or-nothing.
   *
   * A conflicting row aborts the whole sheet rather than importing the rows
   * before it. Half a sheet is the dangerous outcome — the missing dates then
   * resolve through the fallback chain as though SBI had never published them,
   * which is indistinguishable from a genuine gap.
   */
  putAll(records: readonly StoredRate[]): Result<number> {
    if (!Vault.isUnlocked()) return Err(new VaultStateError('vault is locked'));

    let conflict: DomainError | undefined;
    let written = 0;

    try {
      Vault.connection().transaction(() => {
        written = 0;
        for (const record of records) {
          const result = RateRepository.put(record);
          if (!result.ok) {
            conflict = result.error;
            // better-sqlite3 rolls back on a throw, and this is the only way to
            // abort from inside the transaction callback. It is caught below —
            // letting it escape would turn a reported conflict into a crash.
            throw new Error('abort: rate conflict');
          }
          written += 1;
        }
      })();
    } catch (cause) {
      if (conflict !== undefined) return Err(conflict);
      throw cause;
    }

    return Ok(written);
  },

  get(currency: Currency, date: IsoDate, source: string): StoredRate | undefined {
    if (!Vault.isUnlocked()) return undefined;
    const row = Vault.connection()
      .prepare('SELECT * FROM fx_rates WHERE currency = ? AND rate_date = ? AND source = ?')
      .get(currency, date, source) as RateRow | undefined;
    return row === undefined ? undefined : toRate(row);
  },

  /** Most recent rate on or before `date`, so a lookup survives a bank holiday. */
  latestOnOrBefore(currency: Currency, date: IsoDate, source: string): StoredRate | undefined {
    if (!Vault.isUnlocked()) return undefined;
    const row = Vault.connection()
      .prepare(
        `SELECT * FROM fx_rates
          WHERE currency = ? AND source = ? AND rate_date <= ?
          ORDER BY rate_date DESC
          LIMIT 1`,
      )
      .get(currency, source, date) as RateRow | undefined;
    return row === undefined ? undefined : toRate(row);
  },

  /** What the vault holds, for the Settings screen and for seeding decisions. */
  coverage(): readonly {
    currency: string;
    source: string;
    count: number;
    earliest: string;
    latest: string;
  }[] {
    if (!Vault.isUnlocked()) return [];
    return Vault.connection()
      .prepare(
        `SELECT currency, source, count(*) AS count,
                min(rate_date) AS earliest, max(rate_date) AS latest
           FROM fx_rates
          GROUP BY currency, source
          ORDER BY currency, source`,
      )
      .all() as { currency: string; source: string; count: number; earliest: string; latest: string }[];
  },

  count(): number {
    if (!Vault.isUnlocked()) return 0;
    return (Vault.connection().prepare('SELECT count(*) AS n FROM fx_rates').get() as { n: number })
      .n;
  },
};
