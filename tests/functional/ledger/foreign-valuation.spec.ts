/**
 * FUNCTIONAL — a portfolio holding foreign-currency assets can be valued.
 *
 * `ValuationInput.fx` is the twin of `ValuationInput.prices`, and it had the
 * same defect: the port existed from the first commit and **nothing in the
 * application ever supplied it**. The only implementation anywhere was a test
 * fixture.
 *
 * `prices` failing open meant every holding was carried at cost — wrong, but
 * quiet. `fx` fails CLOSED: `toInr` throws `RateUnavailableError` rather than
 * invent a rate, which is the right instinct, but the throw escaped
 * `ValuePortfolioUC.execute`, became a 500, and the Dashboard — which drops a
 * failed valuation on the floor — sat on "Loading your portfolio…" forever.
 *
 * So a single USD holding blanked net worth, allocation and the holdings count
 * for the entire portfolio, including every rupee asset.
 *
 * The properties:
 *   - a foreign holding is converted and counted, with a rupee-only portfolio
 *     unaffected;
 *   - the valuation rate is the ITBR on the valuation date (ADR-003), NOT the
 *     Rule 115 month-end rate that tax uses;
 *   - a bank holiday resolves to the last published rate, not to a failure;
 *   - with no rate at all it still REFUSES rather than inventing one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ImportStatementUC,
  RatesUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectErr, expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-09-15T10:00:00+05:30';

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const rateRow = (stamp: string, ttBuy: string) =>
  `${stamp},https://example.invalid/x.pdf,${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;

const seedRates = (rows: readonly string[]) =>
  RatesUC.importArchive({
    csv: [HEADER, ...rows].join('\n'),
    currency: 'USD',
    documentRef: 'test',
  });

/** Ten shares at $207.87, priced by the statement at $259.43. */
const HOLDINGS = [
  'Record Type,Symbol,Plan Type,Date Acquired,Sellable Qty.,Est. Market Value,Grant Number,Grant Date,Vest Date,Purchased Qty.,Est. Cost Basis (per share):',
  'Grant,ACME,Rest. Stock,22-SEP-2023,10,"$2,594.30",00146549,22-MAR-2022,22-SEP-2023,10,$207.87',
  'Overall Total,,,,,"$2,594.30",,,,,',
].join('\n');

const importHoldings = () =>
  ImportStatementUC.execute({
    file: Buffer.from(HOLDINGS, 'utf8'),
    fileName: 'ByStatus_expanded_sellable.csv',
    parser: 'ETRADE_HOLDINGS',
    mode: 'LENIENT',
  });

/** A rupee holding, so the blast radius of a foreign failure is visible. */
const recordDomestic = () =>
  TradeUC.record({
    assetClass: 'DOMESTIC_EQUITY',
    side: 'BUY',
    tradeDate: '2025-04-10',
    symbol: 'INDCO',
    quantity: '100',
    pricePerUnit: { amount: '500', currency: 'INR' },
  });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-fx-value-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

describe('Scenario: A USD holding is valued in rupees', () => {
  it('converts it and counts it in net worth', async () => {
    expectOk(await seedRates([rateRow('2026-09-15 09:00', '90.00')]));
    expectOk(await importHoldings());

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));

    // 10 × $259.43 = $2,594.30 → × 90.00 = ₹2,33,487.
    const position = valuation.positions.find((p) => p.assetClass === 'FOREIGN_EQUITY');
    expect(position).toBeDefined();
    expect(position?.marketValue.currency).toBe('INR');
    expect(Number(position?.marketValue.amount)).toBeCloseTo(233_487, 0);

    // The USD figure is retained alongside, which is what the Holdings screen
    // shows in the source-currency column.
    expect(position?.nativeValue?.currency).toBe('USD');
    expect(Number(position?.nativeValue?.amount)).toBeCloseTo(2_594.3, 2);

    expect(Number(valuation.netWorth.amount)).toBeCloseTo(233_487, 0);
  });

  /*
   * The bug as reported: the Dashboard showed "Loading your portfolio…" with
   * equity assets recorded. One unconvertible position must not take the whole
   * valuation — and the rupee assets — down with it.
   */
  it('does not blank the rupee side of the portfolio', async () => {
    expectOk(await seedRates([rateRow('2026-09-15 09:00', '90.00')]));
    expectOk(await recordDomestic());
    expectOk(await importHoldings());

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));

    expect(valuation.positions).toHaveLength(2);
    expect(Number(valuation.byAssetClass.DOMESTIC_EQUITY?.amount)).toBeCloseTo(50_000, 0);
    expect(Number(valuation.grossAssets.amount)).toBeCloseTo(283_487, 0);
  });

  /*
   * ADR-003. The valuation rate is the rate on the DAY, not the Rule 115
   * month-end rate that the tax computation uses. Seeding the two differently is
   * the only way to tell which one the screen is showing.
   */
  it('uses the rate on the valuation date, not the Rule 115 month-end rate', async () => {
    expectOk(
      await seedRates([
        rateRow('2026-08-31 09:00', '80.00'), // Rule 115 rate for a September event
        rateRow('2026-09-15 09:00', '90.00'), // the rate on the day
      ]),
    );
    expectOk(await importHoldings());

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));

    expect(Number(valuation.grossAssets.amount)).toBeCloseTo(233_487, 0);
  });

  /** A Sunday is not a missing rate; the last published one stands. */
  it('falls back to the last published rate over a non-publishing day', async () => {
    expectOk(await seedRates([rateRow('2026-09-11 09:00', '90.00')]));
    expectOk(await importHoldings());

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));

    expect(Number(valuation.grossAssets.amount)).toBeCloseTo(233_487, 0);
  });
});

describe('Scenario: No rate exists at all', () => {
  /*
   * Still a refusal. Substituting 1.0 would report a $2,594 holding as ₹2,594 —
   * an error of the whole exchange rate, in a number the user is asked to trust.
   */
  it('refuses rather than inventing a rate', async () => {
    expectOk(await importHoldings());

    expectErr(await ValuePortfolioUC.execute(AS_OF), 'RATE_UNAVAILABLE');
  });

  /** And says which currency and date, so it is fixable from the message. */
  it('names the currency and the date it could not convert', async () => {
    expectOk(await importHoldings());

    const result = await ValuePortfolioUC.execute(AS_OF);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('USD');
      expect(result.error.message).toContain('2026-09-15');
    }
  });
});
