/**
 * US-4.5b — the E*TRADE Gains & Losses (Expanded) reader.
 *
 * The scenarios that matter here are the ones where a wrong answer looks
 * ordinary: an RSU costed at the $0.00 it was granted for, a fractional vest
 * reconstructed from a rounded per-share column, a US date read as a British
 * one, or the whole file read by the parser meant for the other E*TRADE export.
 * Every one of those produces a plausible number that is wrong by real money.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { EtradeGainsLossesParser } from '@vantagepoint/ingestion';
import type { ParsedTransaction } from '@vantagepoint/ingestion';
import { expectErr, expectOk } from '@vantagepoint/test-kit';

const FIXTURE = join(
  import.meta.dirname,
  '../../../tests/fixtures/etrade/gains-losses-expanded.csv',
);

const load = () => readFileSync(FIXTURE, 'utf8');
// `parseWithErrors`, not `parse`: these scenarios are as much about which rows
// were REFUSED as about which were read.
const parse = (csv: string) => EtradeGainsLossesParser.parseWithErrors(csv, 'gl.csv');

/**
 * A compact file carrying only the columns the parser requires, for the edge
 * cases. The real export has 47 columns and writing them out per scenario would
 * bury the one cell each test is actually about.
 */
const COMPACT_HEADER =
  'Record Type,Symbol,Plan Type,Quantity,Date Acquired,Adjusted Cost Basis,Date Sold,Total Proceeds,Adjusted Gain/Loss,Order Type';

const compact = (...rows: readonly string[]) => [COMPACT_HEADER, ...rows].join('\n');

const acquisitions = (txns: readonly ParsedTransaction[]) =>
  txns.filter((t) => t.kind === 'RSU_VEST' || t.kind === 'ESPP_PURCHASE');
const sells = (txns: readonly ParsedTransaction[]) => txns.filter((t) => t.kind === 'SELL');

describe('US-4.5b Scenario: The file is recognised, or refused by name', () => {
  it('refuses the plain transaction history, naming the other importer', () => {
    const history = 'TransactionDate,TransactionType,Symbol,Quantity,Price\n01/02/2026,Sold,ACME,5,100';

    const result = parse(history);

    expectErr(result, 'TEMPLATE_HEADER_MISMATCH');
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('Gains & Losses');
    // The recovery, not just the complaint.
    expect(result.error.message).toContain('E*TRADE transaction history');
  });

  /*
   * The export opens with a totals row. It is not a transaction, and reporting
   * it as a rejection would put a permanent error on every clean import.
   */
  it('skips the Summary row silently rather than rejecting it', () => {
    const outcome = expectOk(parse(load()));

    expect(outcome.errors).toHaveLength(1); // the deliberately bad date, below
    expect(outcome.errors[0]?.column).toBe('Date Sold');
  });
});

describe('US-4.5b Scenario: One row is a round trip, so it becomes two transactions', () => {
  it('emits an acquisition and a disposal for every sale row', () => {
    const outcome = expectOk(parse(load()));

    // Four good rows in the fixture; the fifth has an unparseable date.
    expect(acquisitions(outcome.transactions)).toHaveLength(4);
    expect(sells(outcome.transactions)).toHaveLength(4);
  });

  it('dates each leg from its own column, not from the sale', () => {
    const outcome = expectOk(parse(load()));
    const long = acquisitions(outcome.transactions).find((t) => t.date === '2021-02-10');

    expect(long).toBeDefined();
    // The matching disposal is five years later — two different Rule 115 months,
    // which is the whole reason the legs are kept apart.
    expect(sells(outcome.transactions).some((t) => t.date === '2026-05-20')).toBe(true);
  });

  /*
   * Both legs must resolve to the SAME asset. When they do not, the sale finds
   * no lot to deplete and is silently reported as unapplied — the holding stays
   * on the books and the disposal vanishes from the gain.
   */
  it('states one asset class on both legs, so the sale finds its lot', () => {
    const outcome = expectOk(parse(load()));

    // FOREIGN_EQUITY on every leg: equity compensation is not an asset class of
    // its own, and splitting it into one would put the same company's shares in
    // two holdings with two FIFO queues.
    expect(outcome.transactions.every((t) => t.assetClass === 'FOREIGN_EQUITY')).toBe(true);

    // The AWARD is what distinguishes them, and it is on both legs of each row.
    for (const kind of ['RSU', 'ESPP'] as const) {
      const legs = outcome.transactions.filter((t) => t.equityAward?.kind === kind);
      expect(legs.filter((t) => t.kind === 'SELL').length).toBeGreaterThan(0);
      expect(legs.filter((t) => t.kind !== 'SELL').length).toBeGreaterThan(0);
    }
  });
});

describe('US-4.5b Scenario: The cost basis is the value already taxed as salary', () => {
  /*
   * The single most expensive mistake available in this file. An RSU's
   * Acquisition Cost is $0.00 — the shares were granted. Costing the lot at zero
   * taxes the entire vest value a second time, having already been taxed as a
   * perquisite.
   */
  it('costs an RSU at its vest value, never at the $0.00 it was granted for', () => {
    const outcome = expectOk(parse(load()));
    const vest = acquisitions(outcome.transactions).find((t) => t.date === '2021-02-10');

    // $3,000 over 20 shares.
    expect(vest?.pricePerUnit.amount).toBe('150');
    expect(vest?.pricePerUnit.currency).toBe('USD');
  });

  it('costs an ESPP lot at fair market value, including the taxed discount', () => {
    const outcome = expectOk(parse(load()));
    const purchase = outcome.transactions.find((t) => t.kind === 'ESPP_PURCHASE');

    // $4,000 adjusted basis over 25, NOT the $3,400 actually paid.
    expect(purchase?.pricePerUnit.amount).toBe('160');
  });

  it('carries the ordinary income as the per-unit perquisite', () => {
    const outcome = expectOk(parse(load()));
    const purchase = outcome.transactions.find((t) => t.kind === 'ESPP_PURCHASE');

    // $600 discount over 25 shares.
    expect(purchase?.perquisiteValue?.amount).toBe('24');
  });
});

describe('US-4.5b Scenario: Fractional vests keep their money', () => {
  /*
   * A vest of 12.5 shares is ordinary, and the per-share columns are rounded to
   * two decimals. Reading the rounded figure and multiplying back loses money
   * against the total the file states — straight into a capital gain.
   */
  it('reproduces the stated total exactly from the derived per-unit figure', () => {
    const outcome = expectOk(parse(load()));
    const fractional = acquisitions(outcome.transactions).find((t) => t.quantity === '12.5');

    expect(fractional).toBeDefined();
    const total = new Decimal(fractional?.pricePerUnit.amount ?? '0').times('12.5');
    expect(total.toFixed(2)).toBe('2500.00');
  });
});

describe('US-4.5b Scenario: A row that cannot be trusted is refused, not guessed', () => {
  it('rejects one bad date by row and keeps the rest of the file', () => {
    const outcome = expectOk(parse(load()));

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.expectedFormat).toBe('MM/DD/YYYY');
    // The other four rows still came through.
    expect(sells(outcome.transactions)).toHaveLength(4);
  });

  /*
   * The integrity guard. When proceeds minus cost does not reproduce the gain the
   * file itself states, this parser has read a column that is not the column it
   * thinks it is. Every figure from that row is then suspect.
   */
  it('refuses a row whose own stated gain does not reconcile', () => {
    const outcome = expectOk(
      parse(
        compact(
          'Sell,ACME,RS,10,01/15/2026,"$2,000.00",01/16/2026,"$2,010.00","$999.00",RS STC',
        ),
      ),
    );

    expect(outcome.transactions).toHaveLength(0);
    expect(outcome.errors[0]?.column).toBe('Adjusted Gain/Loss');
    expect(outcome.errors[0]?.reason).toContain('do not line up');
  });

  it('refuses a disposal dated before its own acquisition', () => {
    const outcome = expectOk(
      parse(compact('Sell,ACME,RS,10,06/15/2026,"$2,000.00",01/16/2026,"$2,010.00","$10.00",RS STC')),
    );

    expect(outcome.transactions).toHaveLength(0);
    expect(outcome.errors[0]?.reason).toContain('sold before it was acquired');
  });

  it('refuses a plan type it cannot tell apart, rather than defaulting to one', () => {
    const outcome = expectOk(
      parse(compact('Sell,ACME,WARRANT,10,01/15/2026,"$2,000.00",01/16/2026,"$2,010.00","$10.00",Other')),
    );

    expect(outcome.transactions).toHaveLength(0);
    expect(outcome.errors[0]?.column).toBe('Plan Type');
  });

  it('refuses a zero or negative quantity', () => {
    const outcome = expectOk(
      parse(compact('Sell,ACME,RS,0,01/15/2026,"$2,000.00",01/16/2026,"$2,010.00","$10.00",RS STC')),
    );

    expect(outcome.errors[0]?.column).toBe('Quantity');
  });
});

describe('US-4.5b Scenario: Dates are read the way the source writes them', () => {
  /*
   * `03/04/2026` is a valid date under both conventions and four weeks apart. A
   * month's difference selects a different Rule 115 basis rate, and near a year
   * end, a different financial year.
   */
  it('reads MM/DD/YYYY, so 03/04 is 4 March and not 3 April', () => {
    const outcome = expectOk(
      parse(compact('Sell,ACME,RS,10,03/04/2026,"$2,000.00",03/20/2026,"$2,010.00","$10.00",RS STC')),
    );

    expect(acquisitions(outcome.transactions)[0]?.date).toBe('2026-03-04');
  });

  it('refuses an impossible calendar date instead of rolling it over', () => {
    const outcome = expectOk(
      parse(compact('Sell,ACME,RS,10,02/30/2026,"$2,000.00",03/20/2026,"$10.00",$0.00,RS STC')),
    );

    expect(outcome.transactions).toHaveLength(0);
    expect(outcome.errors[0]?.column).toBe('Date Acquired');
  });
});

describe('US-4.5b Scenario: Sell-to-cover is a disposal like any other', () => {
  /*
   * Shares sold on vest day to fund US withholding. The gain is usually pennies,
   * but the proceeds are real and the disposal is real — dropping them
   * understates both.
   */
  it('imports RS STC rows rather than treating them as an artefact', () => {
    const outcome = expectOk(parse(load()));
    const sameDayish = sells(outcome.transactions).filter((t) => t.date === '2026-01-16');

    expect(sameDayish).toHaveLength(1);
    expect(sameDayish[0]?.pricePerUnit.amount).toBe('201');
  });
});
