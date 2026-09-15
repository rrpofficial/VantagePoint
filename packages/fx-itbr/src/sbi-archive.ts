/**
 * Historical SBI TT Buy archive (US-2.2, FR-2.1).
 *
 * SBI publishes today's card and does not serve years of history, but a capital
 * gain on an RSU sold in 2026 needs the rate on the day it vested in 2020 — and
 * Rule 115 needs the last day of the month before each transfer, which may be
 * years back too. Those rates have to come from an archive.
 *
 * Built for the `sbi-fx-ratekeeper` layout (see README, "Where FX rates come
 * from"), which is a daily scrape of SBI's own published PDF cards:
 *
 *     DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,...
 *     2020-01-06 09:00,https://github.com/.../2020-01-06.pdf,71.65,72.50,...
 *
 * Three properties of the real file drive the design here, and each one would be
 * a silent wrong number if handled casually:
 *
 *  1. **DATE carries a time**, because SBI sometimes republishes intraday. Twelve
 *     days in the current file have two cards, and on some of them the TT buy
 *     rate DIFFERS. One has to be chosen, and which one is a judgement — so the
 *     choice is explicit, deterministic, and reported rather than buried.
 *  2. **TT BUY is 0.00 on 54 days**, where SBI's card carried no telegraphic
 *     transfer rate at all. Those days are skipped and COUNTED, never silently
 *     dropped: the resolver then walks back to the previous published day, which
 *     is correct, but only if the gap is known to exist.
 *  3. **Every row names the source PDF**, which is the best provenance available
 *     — better than naming the archive, because it points at SBI's own document.
 *     That URL is what gets stored against the rate.
 */
import { DomainError, Err, Ok, type Currency, type Result } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { RateRecord } from './types.js';

const REQUIRED_COLUMNS = ['DATE', 'TT BUY'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A coarse decimal-point check. SBI quotes every currency so the card figure
 * lands in a comparable range — that is what per-100 quoting for JPY achieves —
 * so a floor of 10 admits every real card and rejects an order-of-magnitude slip.
 */
const MIN_RATE = new Decimal('10');
const MAX_RATE = new Decimal('1000');

/**
 * The check that actually catches transcription errors.
 *
 * A static band cannot tell 7.132 from a real rate, but it is obviously a slipped
 * decimal beside the previous day's 71.65 — an order-of-magnitude error always
 * shows as a ~90% day-over-day move, and USD/INR has never moved anything like
 * 25% in a day. Applied only across dates close enough for the comparison to
 * mean something: over a long gap in the archive a large move is legitimate.
 */
const MAX_DAILY_MOVE_PCT = new Decimal('25');
const COMPARABLE_WINDOW_DAYS = 7;

const daysBetween = (earlier: string, later: string): number =>
  Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000,
  );

export class ArchiveFormatError extends DomainError {
  readonly code = 'SBI_ARCHIVE_FORMAT';
}

/** Which card governs on a day SBI published more than one. */
export type IntradayPolicy = 'FIRST' | 'LAST';

export interface ArchiveParseOptions {
  /** Currency the file describes. The archive publishes one file per currency. */
  readonly currency: Currency;
  /** Instant the file was obtained, for the audit trail. */
  readonly retrievedAt: string;
  /** The archive itself, used only when a row names no source PDF. */
  readonly documentRef: string;
  /**
   * Default LAST: the rate SBI ended the day quoting, and the one a card pulled
   * for that date after close would show. Rule 115 asks for "the rate as on the
   * specified date" without addressing intraday revisions, so this is a choice
   * rather than a reading — hence configurable, and reported per affected day.
   */
  readonly intraday?: IntradayPolicy;
}

/** A day SBI published no TT buy rate. Reported so the gap is known, not guessed at. */
export interface SkippedDay {
  readonly date: string;
  readonly reason: string;
}

/** A day with more than one card, and which one was taken. */
export interface IntradayRevision {
  readonly date: string;
  readonly taken: string;
  readonly discarded: readonly string[];
  /** True when the discarded cards quoted a DIFFERENT rate — worth a human look. */
  readonly ratesDiffer: boolean;
}

export interface ArchiveParseResult {
  readonly records: readonly RateRecord[];
  readonly skipped: readonly SkippedDay[];
  readonly revisions: readonly IntradayRevision[];
}

interface Candidate {
  readonly stamp: string;
  readonly rate: Decimal;
  readonly documentRef: string;
}

/** Splits a CSV line, tolerating quoted fields — PDF URLs contain no commas, but headers might. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseSbiArchive(
  csv: string,
  options: ArchiveParseOptions,
): Result<ArchiveParseResult> {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const headerLine = lines[0];
  if (headerLine === undefined) return Err(new ArchiveFormatError('the archive file is empty'));

  const header = splitCsv(headerLine).map((cell) => cell.toUpperCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    // Refused wholesale rather than read positionally: a reordered or renamed
    // column read by index yields plausible rates from the wrong column.
    return Err(
      new ArchiveFormatError(
        `archive layout changed: missing column(s) ${missing.join(', ')}. ` +
          `Expected at least: ${REQUIRED_COLUMNS.join(', ')}`,
      ),
    );
  }

  const dateAt = header.indexOf('DATE');
  const rateAt = header.indexOf('TT BUY');
  const pdfAt = header.indexOf('PDF FILE');

  // Grouped by DATE, because a day may carry several cards and the choice between
  // them cannot be made until all of them have been seen.
  const byDate = new Map<string, Candidate[]>();
  const skipped: SkippedDay[] = [];

  for (const [offset, line] of lines.slice(1).entries()) {
    const rowNumber = offset + 2;
    const cells = splitCsv(line);

    const stamp = cells[dateAt] ?? '';
    const date = stamp.slice(0, 10);
    if (!ISO_DATE.test(date)) {
      return Err(
        new ArchiveFormatError(`row ${String(rowNumber)}: "${stamp}" does not start with a YYYY-MM-DD date`),
      );
    }

    const raw = cells[rateAt] ?? '';
    let rate: Decimal;
    try {
      rate = new Decimal(raw === '' ? '0' : raw);
    } catch {
      return Err(
        new ArchiveFormatError(`row ${String(rowNumber)} (${date}): TT BUY "${raw}" is not a number`),
      );
    }

    /*
     * Zero means SBI's card carried no telegraphic-transfer rate that day, which
     * is a real and recurring state — not corruption, and not a reason to refuse
     * six years of good rates. Recorded so the resulting gap is visible.
     */
    if (rate.isZero()) {
      skipped.push({ date, reason: 'SBI published no TT buy rate on this card' });
      continue;
    }

    if (rate.lessThan(MIN_RATE) || rate.greaterThan(MAX_RATE)) {
      return Err(
        new ArchiveFormatError(
          `row ${String(rowNumber)} (${date}): TT BUY ${rate.toFixed()} for ${options.currency} is outside ` +
            `the plausible band ${MIN_RATE.toFixed()}–${MAX_RATE.toFixed()}; refusing the file`,
        ),
      );
    }

    const candidates = byDate.get(date) ?? [];
    candidates.push({
      stamp,
      rate,
      // The row's own PDF link is the best provenance there is: it names SBI's
      // published document, not the archive that transcribed it.
      documentRef: (pdfAt >= 0 ? cells[pdfAt] : undefined) || options.documentRef,
    });
    byDate.set(date, candidates);
  }

  const policy = options.intraday ?? 'LAST';
  const records: RateRecord[] = [];
  const revisions: IntradayRevision[] = [];
  let previous: { date: string; rate: Decimal } | undefined;

  for (const [date, candidates] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...candidates].sort((a, b) => a.stamp.localeCompare(b.stamp));
    const chosen = policy === 'FIRST' ? ordered[0] : ordered[ordered.length - 1];
    if (chosen === undefined) continue;

    if (previous !== undefined && daysBetween(previous.date, date) <= COMPARABLE_WINDOW_DAYS) {
      const movePct = chosen.rate.minus(previous.rate).dividedBy(previous.rate).times(100).abs();
      if (movePct.greaterThan(MAX_DAILY_MOVE_PCT)) {
        return Err(
          new ArchiveFormatError(
            `${date}: ${options.currency} moved ${movePct.toFixed(1)}% from ${previous.rate.toFixed()} ` +
              `on ${previous.date} to ${chosen.rate.toFixed()} — beyond the ${MAX_DAILY_MOVE_PCT.toFixed()}% ` +
              `plausible daily move, which is what a slipped decimal point looks like. Refusing the file.`,
          ),
        );
      }
    }
    previous = { date, rate: chosen.rate };

    if (ordered.length > 1) {
      const others = ordered.filter((candidate) => candidate !== chosen);
      revisions.push({
        date,
        taken: chosen.stamp,
        discarded: others.map((candidate) => candidate.stamp),
        // Same rate twice is housekeeping; a different rate is a decision that
        // changed a number, and the caller should be able to see which days.
        ratesDiffer: others.some((candidate) => !candidate.rate.equals(chosen.rate)),
      });
    }

    records.push({
      currency: options.currency,
      date,
      rate: chosen.rate.toFixed(),
      source: 'SBI_ITBR',
      rateType: 'TTBR',
      retrievedAt: options.retrievedAt,
      sourceDocumentRef: chosen.documentRef,
    });
  }

  if (records.length === 0) {
    return Err(new ArchiveFormatError('the archive file yielded no usable TT buy rates'));
  }

  return Ok({ records, skipped, revisions });
}
