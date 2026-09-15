/**
 * US-2.2 — the historical SBI TT Buy archive (sbi-fx-ratekeeper layout).
 *
 * Mostly refusal and reporting tests, deliberately. The failure that matters is
 * not a file that won't parse — it is a file that parses into plausible wrong
 * numbers, or one that quietly drops days so a later lookup silently resolves to
 * a neighbouring date without anyone knowing a gap was crossed.
 */
import { describe, it, expect } from 'vitest';
import { SbiArchiveParser } from '@porttrack/fx-itbr';
import { expectErr, expectOk } from '@porttrack/test-kit';

const OPTIONS = {
  currency: 'USD' as const,
  retrievedAt: '2026-09-15T00:00:00.000+05:30',
  documentRef: 'sbi-fx-ratekeeper/SBI_REFERENCE_RATES_USD.csv',
};

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const PDF = 'https://github.com/sahilgupta/sbi-fx-ratekeeper/blob/main/pdf_files/2026/1/x.pdf';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const row = (stamp: string, ttBuy: string, pdf = PDF) =>
  `${stamp},${pdf},${ttBuy},72.50,71.59,72.65,71.00,72.85,70.70,73.00`;

describe('US-2.2 Scenario: The published archive is ingested', () => {
  it('reads the real layout', () => {
    const result = expectOk(
      SbiArchiveParser.parse(csv(row('2020-01-06 09:00', '71.65'), row('2020-01-07 09:00', '71.32')), OPTIONS),
    );

    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.date).toBe('2020-01-06');
    expect(result.records[0]?.rate).toBe('71.65');
    expect(result.records[0]?.rateType).toBe('TTBR');
  });

  /** The DATE column carries a time; the rate is keyed by day. */
  it('takes the date from a timestamped DATE column', () => {
    const result = expectOk(SbiArchiveParser.parse(csv(row('2026-07-31 09:14', '95')), OPTIONS));
    expect(result.records[0]?.date).toBe('2026-07-31');
  });

  /*
   * The best provenance available: SBI's own published document, not the archive
   * that transcribed it. A figure defended years later points at the card itself.
   */
  it('stores the row’s source PDF as the provenance reference', () => {
    const result = expectOk(SbiArchiveParser.parse(csv(row('2026-07-31 09:14', '95')), OPTIONS));
    expect(result.records[0]?.sourceDocumentRef).toBe(PDF);
  });

  it('falls back to the archive reference when a row names no PDF', () => {
    const result = expectOk(SbiArchiveParser.parse(csv(row('2026-07-31 09:14', '95', '')), OPTIONS));
    expect(result.records[0]?.sourceDocumentRef).toBe(OPTIONS.documentRef);
  });

  it('returns records in date order regardless of file order', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2026-03-31 09:00', '93.15'), row('2025-12-31 09:00', '89.47')),
        OPTIONS,
      ),
    );
    expect(result.records.map((record) => record.date)).toEqual(['2025-12-31', '2026-03-31']);
  });
});

describe('US-2.2 Scenario: Days SBI published no TT buy rate', () => {
  /*
   * 54 days in the real file carry TT BUY = 0 with a BILL BUY present: SBI's card
   * had no telegraphic-transfer rate that day. Refusing the file over this would
   * discard six years of good rates.
   */
  it('skips a zero rate rather than storing it', () => {
    const result = expectOk(
      SbiArchiveParser.parse(csv(row('2020-01-04 09:00', '0.00'), row('2020-01-06 09:00', '71.65')), OPTIONS),
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.date).toBe('2020-01-06');
  });

  /*
   * The gap has to be VISIBLE. A later lookup for 2020-01-04 will walk back to
   * the previous published day, which is correct — but only defensible if the
   * caller knew the day was missing rather than assuming it was covered.
   */
  it('reports the skipped day instead of dropping it silently', () => {
    const result = expectOk(
      SbiArchiveParser.parse(csv(row('2020-01-04 09:00', '0.00'), row('2020-01-06 09:00', '71.65')), OPTIONS),
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.date).toBe('2020-01-04');
  });

  it('treats an empty TT BUY cell the same as a zero', () => {
    const result = expectOk(
      SbiArchiveParser.parse(csv(row('2020-01-04 09:00', ''), row('2020-01-06 09:00', '71.65')), OPTIONS),
    );
    expect(result.skipped.map((day) => day.date)).toEqual(['2020-01-04']);
  });
});

describe('US-2.2 Scenario: SBI republished a card the same day', () => {
  /*
   * Twelve days in the real file carry two cards, and on some the rate differs.
   * Rule 115 asks for "the rate as on the specified date" and says nothing about
   * intraday revisions, so this is a choice — it must be deterministic and it
   * must be reported, never silently resolved.
   */
  it('takes the last card of the day by default', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-06-04 11:30', '83.05'), row('2024-06-04 16:00', '83.15')),
        OPTIONS,
      ),
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.rate).toBe('83.15');
  });

  it('takes the first card when asked to', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-06-04 11:30', '83.05'), row('2024-06-04 16:00', '83.15')),
        { ...OPTIONS, intraday: 'FIRST' },
      ),
    );

    expect(result.records[0]?.rate).toBe('83.05');
  });

  it('reports which card it took and which it discarded', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-06-04 11:30', '83.05'), row('2024-06-04 16:00', '83.15')),
        OPTIONS,
      ),
    );

    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]?.taken).toBe('2024-06-04 16:00');
    expect(result.revisions[0]?.discarded).toEqual(['2024-06-04 11:30']);
  });

  /** A changed rate is a decision that moved a number; an identical one is not. */
  it('flags a same-day revision that CHANGED the rate', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-06-04 11:30', '83.05'), row('2024-06-04 16:00', '83.15')),
        OPTIONS,
      ),
    );
    expect(result.revisions[0]?.ratesDiffer).toBe(true);
  });

  it('does not flag a same-day republish at the same rate', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-09-20 09:20', '83.10'), row('2024-09-20 12:20', '83.10')),
        OPTIONS,
      ),
    );
    expect(result.revisions[0]?.ratesDiffer).toBe(false);
  });

  it('orders cards by timestamp, not by file order', () => {
    const result = expectOk(
      SbiArchiveParser.parse(
        csv(row('2024-06-04 16:00', '83.15'), row('2024-06-04 11:30', '83.05')),
        OPTIONS,
      ),
    );
    expect(result.records[0]?.rate).toBe('83.15');
  });
});

describe('US-2.2 Scenario: A corrupted archive is refused, not absorbed', () => {
  /*
   * A misplaced decimal point produces a number that is still a number. Nothing
   * structural catches it; the band does.
   */
  it('refuses a rate below the plausible band', () => {
    expectErr(SbiArchiveParser.parse(csv(row('2020-01-06 09:00', '0.7165')), OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  it('refuses a rate above the plausible band', () => {
    expectErr(SbiArchiveParser.parse(csv(row('2020-01-06 09:00', '7165')), OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  it('names the date when it refuses a row', () => {
    const result = SbiArchiveParser.parse(csv(row('2020-01-06 09:00', '7165')), OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('2020-01-06');
  });

  it('refuses a non-ISO date rather than guessing the order', () => {
    expectErr(SbiArchiveParser.parse(csv(row('06/01/2020 09:00', '71.65')), OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  it('refuses a non-numeric rate', () => {
    expectErr(SbiArchiveParser.parse(csv(row('2020-01-06 09:00', 'N/A')), OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  /** A renamed column read by position yields rates from the wrong column. */
  it('refuses a changed layout wholesale, naming the missing column', () => {
    const result = SbiArchiveParser.parse('DATE,RATE\n2020-01-06 09:00,71.65', OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('TT BUY');
  });

  it('refuses an empty file', () => {
    expectErr(SbiArchiveParser.parse('', OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  it('refuses a file whose every row is unusable', () => {
    expectErr(SbiArchiveParser.parse(csv(row('2020-01-04 09:00', '0.00')), OPTIONS), 'SBI_ARCHIVE_FORMAT');
  });

  /** Nothing is returned on refusal, so nothing half-populates the store. */
  it('returns no records at all when one row is out of band', () => {
    const result = SbiArchiveParser.parse(
      csv(row('2020-01-06 09:00', '71.65'), row('2020-01-07 09:00', '7.132'), row('2020-01-08 09:00', '71.60')),
      OPTIONS,
    );
    expect(result.ok).toBe(false);
  });
});
