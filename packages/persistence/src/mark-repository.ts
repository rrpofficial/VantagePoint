/**
 * The daily marks store (Phase 6, §1.3 of the evolution plan).
 *
 * Schedule FA Table A3 needs the PEAK value a foreign holding reached during the
 * calendar year, which needs a daily price and exchange-rate series. This is
 * that series, generalised from the `fx_rates` shape: keyed, dated, decimal
 * string, with the document each figure came from.
 *
 * ## Coverage is checked, never assumed
 *
 * The API container has no route out (ADR-010), so a mark reaches this table
 * only from a statement the user imported or the SBI archive already loaded.
 * The series is therefore sparse by construction, and a peak taken over a sparse
 * series is an understated one — which is the failure the Black Money Act
 * punishes hardest. So `coverage` reports the gaps and the caller refuses.
 *
 * ## Why a gap of a few days is not a gap
 *
 * Markets and the SBI rate desk close at weekends and on holidays, and a price
 * that was never published did not move. Carrying the last mark across such a
 * break cannot hide a spike, because no trading happened in it. A break longer
 * than a long weekend is missing DATA rather than a closed market, and carrying
 * a mark across that could hide a real peak — so it is reported.
 */
import { Ok, VaultStateError, type IsoDate, type Result } from '@porttrack/shared-kernel';
import { Vault } from './vault.js';

/**
 * The longest run of dateless days treated as a closed market rather than
 * missing data. Covers a Friday-to-Monday weekend with public holidays either
 * side; Christmas to New Year in most markets is longer and will be reported.
 */
export const MAX_MARKET_CLOSURE_DAYS = 5;

export type MarkKind = 'CURRENCY' | 'ASSET';

export interface DailyMark {
  readonly kind: MarkKind;
  /** Currency code, or the instrument as the statement wrote it. */
  readonly key: string;
  readonly date: IsoDate;
  readonly value: string;
  /** Absent for a currency mark, which is a rate rather than an amount. */
  readonly currency?: string;
  readonly source: string;
  readonly sourceDocumentRef: string;
}

export interface MarkGap {
  readonly after: IsoDate;
  readonly before: IsoDate;
  readonly days: number;
}

export interface MarkCoverage {
  readonly covered: boolean;
  readonly firstMark?: IsoDate;
  readonly lastMark?: IsoDate;
  readonly markCount: number;
  readonly gaps: readonly MarkGap[];
  /** Plain-language statement of what is missing, for the refusal message. */
  readonly shortfall?: string;
}

interface MarkRow {
  readonly mark_key: string;
  readonly mark_date: string;
  readonly value: string;
  readonly currency: string | null;
  readonly source: string;
  readonly source_document_ref: string;
}

const key = (value: string) => value.trim().toUpperCase();

const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function requireUnlocked(): Result<void> {
  return Vault.isUnlocked()
    ? Ok(undefined)
    : { ok: false, error: new VaultStateError('vault is locked') };
}

export const MarkRepository = {
  /**
   * Records marks, newest-wins per (kind, key, date).
   *
   * An overwrite is allowed, unlike the FX rate store. A rate is a published
   * fact a tax figure may already rest on; a daily mark is an observation that a
   * corrected statement should be able to update, and nothing is frozen against
   * it — a snapshot stores its own values (ADR-006).
   */
  save(marks: readonly DailyMark[], recordedAt: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    const db = Vault.connection();
    const insert = db.prepare(
      `INSERT INTO daily_marks
         (mark_kind, mark_key, mark_date, value, currency, source, source_document_ref, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mark_kind, mark_key, mark_date) DO UPDATE SET
         value = excluded.value,
         currency = excluded.currency,
         source = excluded.source,
         source_document_ref = excluded.source_document_ref,
         recorded_at = excluded.recorded_at`,
    );

    db.transaction(() => {
      for (const mark of marks) {
        insert.run(
          mark.kind,
          key(mark.key),
          mark.date,
          mark.value,
          mark.currency ?? null,
          mark.source,
          mark.sourceDocumentRef,
          recordedAt,
        );
      }
    })();
    return Promise.resolve(Ok(undefined));
  },

  /**
   * Folds the rates and prices already in the vault into the marks series.
   *
   * `INSERT OR IGNORE`, not an upsert: a mark recorded by hand is a daily close
   * the holder read off a statement, and a sparse imported price must not
   * silently replace it. Re-running is therefore free, which is what lets this
   * be called after every import without tracking what it has already seen.
   */
  syncFromLedger(): Promise<Result<{ currencyMarks: number; assetMarks: number }>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    const db = Vault.connection();
    let currencyMarks = 0;
    let assetMarks = 0;

    db.transaction(() => {
      // TTBR only: it is the VALUATION rate (ADR-003), which is what a daily
      // mark means. The tax rate is month-end and belongs nowhere near a peak.
      currencyMarks = db
        .prepare(
          `INSERT OR IGNORE INTO daily_marks
             (mark_kind, mark_key, mark_date, value, currency, source, source_document_ref, recorded_at)
           SELECT 'CURRENCY', currency, rate_date, rate, NULL, source, source_document_ref, retrieved_at
             FROM fx_rates
            WHERE rate_type = 'TTBR'`,
        )
        .run().changes;

      assetMarks = db
        .prepare(
          `INSERT OR IGNORE INTO daily_marks
             (mark_kind, mark_key, mark_date, value, currency, source, source_document_ref, recorded_at)
           SELECT 'ASSET', UPPER(TRIM(instrument)), price_date, price, currency, source,
                  COALESCE(source_document, 'imported statement'), price_date
             FROM asset_prices`,
        )
        .run().changes;
    })();

    return Promise.resolve(Ok({ currencyMarks, assetMarks }));
  },

  /** Every mark in the window, oldest first. */
  between(kind: MarkKind, markKey: string, from: IsoDate, to: IsoDate): readonly DailyMark[] {
    if (!Vault.isUnlocked()) return [];
    const rows = Vault.connection()
      .prepare(
        `SELECT * FROM daily_marks
          WHERE mark_kind = ? AND mark_key = ? AND mark_date BETWEEN ? AND ?
          ORDER BY mark_date`,
      )
      .all(kind, key(markKey), from, to) as MarkRow[];

    return rows.map((row) => ({
      kind,
      key: row.mark_key,
      date: row.mark_date,
      value: row.value,
      ...(row.currency === null ? {} : { currency: row.currency }),
      source: row.source,
      sourceDocumentRef: row.source_document_ref,
    }));
  },

  /**
   * The series as a day-by-day map, carrying each mark forward over closed days.
   *
   * Carried forward only up to `MAX_MARKET_CLOSURE_DAYS`. Beyond that the days
   * are left ABSENT rather than filled — `coverage` will have reported the gap,
   * and a caller that ignored it must at least not receive an invented value.
   */
  seriesFor(
    kind: MarkKind,
    markKey: string,
    from: IsoDate,
    to: IsoDate,
  ): ReadonlyMap<IsoDate, string> {
    const marks = MarkRepository.between(kind, markKey, from, to);
    const series = new Map<IsoDate, string>();

    marks.forEach((mark, index) => {
      series.set(mark.date, mark.value);

      const next = marks[index + 1];
      const until = next === undefined ? to : next.date;
      const span = daysBetween(mark.date, until);
      if (span > MAX_MARKET_CLOSURE_DAYS) return;

      for (let offset = 1; offset < span; offset++) {
        const day = new Date(Date.parse(`${mark.date}T00:00:00Z`) + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        series.set(day, mark.value);
      }
    });

    return series;
  },

  /**
   * Whether the series can support a peak over the window, and where it cannot.
   *
   * Three ways to fail, each reported separately because each has a different
   * fix: no marks at all, a series that starts after the window does, and a
   * break inside it longer than a closed market.
   */
  coverage(kind: MarkKind, markKey: string, from: IsoDate, to: IsoDate): MarkCoverage {
    const marks = MarkRepository.between(kind, markKey, from, to);
    const label = kind === 'CURRENCY' ? `${markKey}/INR rates` : `prices for ${markKey}`;

    if (marks.length === 0) {
      return {
        covered: false,
        markCount: 0,
        gaps: [],
        shortfall: `no ${label} are recorded between ${from} and ${to}`,
      };
    }

    const first = marks[0];
    const last = marks[marks.length - 1];
    if (first === undefined || last === undefined) {
      return { covered: false, markCount: 0, gaps: [], shortfall: `no ${label} are recorded` };
    }

    const gaps: MarkGap[] = [];

    // A series that begins inside the window leaves the opening days unvalued,
    // and the peak may well have been in them.
    if (daysBetween(from, first.date) > MAX_MARKET_CLOSURE_DAYS) {
      gaps.push({ after: from, before: first.date, days: daysBetween(from, first.date) });
    }
    for (let index = 0; index + 1 < marks.length; index++) {
      const current = marks[index];
      const next = marks[index + 1];
      if (current === undefined || next === undefined) continue;
      const span = daysBetween(current.date, next.date);
      if (span > MAX_MARKET_CLOSURE_DAYS) {
        gaps.push({ after: current.date, before: next.date, days: span });
      }
    }
    if (daysBetween(last.date, to) > MAX_MARKET_CLOSURE_DAYS) {
      gaps.push({ after: last.date, before: to, days: daysBetween(last.date, to) });
    }

    const covered = gaps.length === 0;
    return {
      covered,
      firstMark: first.date,
      lastMark: last.date,
      markCount: marks.length,
      gaps,
      ...(covered
        ? {}
        : {
            shortfall:
              `${label} are missing for ` +
              gaps
                .map((gap) => `${String(gap.days)} days between ${gap.after} and ${gap.before}`)
                .join(', '),
          }),
    };
  },
};
