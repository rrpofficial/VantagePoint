/**
 * US-5.7 — Rule 115 applied to BOTH legs of a foreign disposal.
 *
 * Cost converts at the last day of the month preceding acquisition; proceeds at
 * the last day of the month preceding transfer. The difference is the gain.
 *
 * The engine previously computed the gain in the foreign currency and converted
 * that single figure once, at the sale's rate. The two are not the same, and the
 * difference is real money: a lot vested when the dollar bought ₹74 and sold when
 * it bought ₹95 carries rupee appreciation that one conversion erases.
 *
 * Rates below are the genuine SBI TT buy figures for those month-ends, taken from
 * the archive documented in the README.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CapitalGainsEngine, TaxRuleTable } from '@porttrack/tax-engine';
import { RateStore, resetRateStore } from '@porttrack/fx-itbr';
import { anExit, expectOk, usd } from '@porttrack/test-kit';

const RULES = () => expectOk(TaxRuleTable.rulesFor('2025-26'));

/** Real month-end TT buy rates; see README, "Where FX rates come from". */
const MONTH_END: Readonly<Record<string, string>> = {
  '2020-02-29': '71.70',
  '2020-08-31': '73.20',
  '2022-02-28': '74.95',
  '2025-12-31': '89.47',
  '2026-03-31': '93.15',
  '2026-07-31': '95.00',
};

beforeEach(() => {
  resetRateStore();
  for (const [date, rate] of Object.entries(MONTH_END)) {
    expectOk(
      RateStore.put({
        currency: 'USD',
        date,
        rate,
        source: 'SBI_ITBR',
        rateType: 'TTBR',
        retrievedAt: `${date}T00:00:00.000+05:30`,
        sourceDocumentRef: `sbi-card-${date}.pdf`,
      }),
    );
  }
});

const subjects = { txn_1: 'FOREIGN_EQUITY' as const };

describe('US-5.7 Scenario: Each leg converts at its own Rule 115 basis', () => {
  /*
   * 10 units, cost $100, sold for $150, vested March 2020 and sold April 2026.
   *   cost     : 10 x 100 x 71.70 (28 Feb 2020 basis) = 71,700
   *   proceeds : 10 x 150 x 93.15 (31 Mar 2026 basis) = 139,725
   *   gain     : 68,025
   * A single conversion at the sale rate would give (150-100) x 10 x 93.15 =
   * 46,575 — understating by 21,450, the rupee's move over six years.
   */
  it('converts cost at the acquisition basis and proceeds at the transfer basis', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      quantity: '10',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    expect(result.gains[0]?.gain.amount).toBe('68025');
    expect(result.gains[0]?.gain.currency).toBe('INR');
  });

  it('does not produce the single-conversion figure', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      quantity: '10',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    // (150 - 100) x 10 x 93.15 — what converting the USD gain once would give.
    expect(result.gains[0]?.gain.amount).not.toBe('46575');
  });

  /*
   * The case the per-allocation granularity exists for. One sale order routinely
   * consumes lots from several vests — order 101513906 in the sample G&L file
   * covers four — and each carries its own basis month.
   */
  it('converts each allocation at its own basis when one sale spans several vests', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-08-28',
      quantity: '20',
      pricePerUnit: usd('200'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
        { lotId: 'L2', quantity: '10', costPerUnit: usd('120'), acquisitionDate: '2022-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    // proceeds 20 x 200 x 95.00              = 380,000
    // cost L1  10 x 100 x 71.70 (29 Feb 2020) =  71,700
    // cost L2  10 x 120 x 74.95 (28 Feb 2022) =  89,940
    expect(result.gains[0]?.gain.amount).toBe('218360');
  });

  it('uses the same basis for both legs when vest and sale share a month', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-01-23',
      quantity: '8',
      pricePerUnit: usd('228.42875'),
      allocations: [
        { lotId: 'L1', quantity: '8', costPerUnit: usd('228.09'), acquisitionDate: '2026-01-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    /*
     * Both legs resolve to 31 Dec 2025 at 89.47, so the two-date method must
     * collapse to the single-conversion answer — a useful check that it does not
     * distort the ordinary same-month case:
     *   proceeds 8 x 228.42875 x 89.47 = 163,500.16
     *   cost     8 x 228.09    x 89.47 = 163,257.70
     *   gain                            =     242.46
     * which equals 8 x (228.42875 - 228.09) x 89.47. The figures are row 3 of the
     * sample G&L file: 8 CRM units vested 22 Jan 2026, sold the next day.
     */
    expect(result.gains[0]?.gain.amount).toBe('242.46');
  });

  /** A domestic disposal has nothing to convert and must be untouched. */
  it('leaves an INR disposal alone', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      quantity: '10',
      pricePerUnit: { amount: '150', currency: 'INR' },
      allocations: [
        {
          lotId: 'L1',
          quantity: '10',
          costPerUnit: { amount: '100', currency: 'INR' },
          acquisitionDate: '2020-03-22',
        },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], { txn_1: 'DOMESTIC_EQUITY' }, RULES());

    expect(result.gains[0]?.gain.amount).toBe('500');
  });
});

describe('US-5.7 Scenario: A missing rate makes the total incomplete, not wrong', () => {
  /*
   * The regression this replaces. The old path returned the foreign-currency
   * figure unchanged when no rate resolved, and the totals then added it as
   * rupees — a USD 1,000 gain became ₹1,000, understating tax by ~99%.
   */
  it('excludes a disposal whose basis rate is unavailable', () => {
    resetRateStore(); // no rates at all

    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      quantity: '10',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    expect(result.gains).toHaveLength(0);
    expect(result.taxableLtcg.amount).toBe('0');
  });

  it('reports which disposal could not be converted, and why', () => {
    resetRateStore();

    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    expect(result.unconvertible).toHaveLength(1);
    expect(result.unconvertible[0]?.txnId).toBe('txn_1');
    expect(result.unconvertible[0]?.currency).toBe('USD');
  });

  it('never reports a foreign amount as though it were rupees', () => {
    resetRateStore();

    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    const result = CapitalGainsEngine.compute([exit], subjects, RULES());

    // 500 is the USD gain. It must appear nowhere in the INR totals.
    expect(result.gains.map((gain) => gain.gain.amount)).not.toContain('500');
  });

  it('reports nothing unconvertible when every rate resolves', () => {
    const exit = anExit({
      txnId: 'txn_1',
      exitDate: '2026-04-06',
      pricePerUnit: usd('150'),
      allocations: [
        { lotId: 'L1', quantity: '10', costPerUnit: usd('100'), acquisitionDate: '2020-03-22' },
      ],
    });

    expect(CapitalGainsEngine.compute([exit], subjects, RULES()).unconvertible).toEqual([]);
  });
});
