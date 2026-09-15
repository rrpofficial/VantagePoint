/**
 * FUNCTIONAL — market prices, and valuing a holding at what it is WORTH.
 *
 * The `PriceSource` port existed from the first commit and nothing ever supplied
 * it, so `marketValueOf` looked for a quote, found none, and fell back to cost
 * basis — for every holding, on every screen. Three of those screens then
 * labelled that cost "value" and "net worth".
 *
 * The properties that matter:
 *   - a price stated in a statement reaches the store, and values the holding;
 *   - an UNPRICED holding is still carried at cost, not at zero and not omitted;
 *   - the price carries its date, because it arrives by import and is not live;
 *   - a statement that contradicts itself about a price is not guessed from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ImportStatementUC,
  LedgerUC,
  RatesUC,
  TradeUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { PriceRepository, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const rateRow = (stamp: string, ttBuy: string) =>
  `${stamp},https://example.invalid/x.pdf,${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;

/** Two tranches of one symbol, both quoting the same market value per share. */
const HOLDINGS = [
  'Record Type,Symbol,Plan Type,Date Acquired,Sellable Qty.,Est. Market Value,Grant Number,Grant Date,Vest Date,Purchased Qty.,Est. Cost Basis (per share):',
  'Grant,ACME,Rest. Stock,22-SEP-2023,10,"$2,594.30",00146549,22-MAR-2022,22-SEP-2023,10,$207.87',
  'Grant,ACME,Rest. Stock,22-DEC-2023,5,"$1,297.15",00146549,22-MAR-2022,22-DEC-2023,5,$266.80',
  'Overall Total,,,,,"$3,891.45",,,,,',
].join('\n');

const importHoldings = (csv = HOLDINGS) =>
  ImportStatementUC.execute({
    file: Buffer.from(csv, 'utf8'),
    fileName: 'ByStatus_expanded_sellable.csv',
    parser: 'ETRADE_HOLDINGS',
    mode: 'LENIENT',
  });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-prices-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
  expectOk(
    await RatesUC.importArchive({
      csv: [HEADER, rateRow('2026-08-31 09:00', '95.30')].join('\n'),
      currency: 'USD',
      documentRef: 'test',
    }),
  );
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

describe('Scenario: A statement’s price reaches the store', () => {
  it('records one price per instrument, with the document it came from', async () => {
    expectOk(await importHoldings());

    const prices = PriceRepository.all();

    expect(prices).toHaveLength(1);
    expect(prices[0]?.instrument).toBe('ACME');
    // $2,594.30 over 10 units, and $1,297.15 over 5 — the same $259.43.
    expect(Number(prices[0]?.price)).toBeCloseTo(259.43, 2);
    expect(prices[0]?.sourceDocument).toBe('ByStatus_expanded_sellable.csv');
  });

  /*
   * The whole point of the exercise. 15 units at $259.43 is $3,891.45 — the
   * file's own Overall Total — against a cost of $3,412.70.
   */
  it('values the holding at market, and reports the unrealised gain', async () => {
    expectOk(await importHoldings());

    const asset = (await LedgerUC.assets()).find((a) => a.symbol === 'ACME');

    expect(Number(asset?.marketValue?.amount)).toBeCloseTo(3891.45, 2);
    expect(Number(asset?.costBasis.amount)).toBeCloseTo(10 * 207.87 + 5 * 266.8, 2);
    expect(Number(asset?.unrealisedInr?.amount)).toBeCloseTo(
      (3891.45 - (10 * 207.87 + 5 * 266.8)) * 95.3,
      0,
    );
  });

  /** Both figures converted at the same rate, or the difference is meaningless. */
  it('converts value and cost through the same rate', async () => {
    expectOk(await importHoldings());

    const asset = (await LedgerUC.assets()).find((a) => a.symbol === 'ACME');

    expect(Number(asset?.marketValueInr?.amount)).toBeCloseTo(3891.45 * 95.3, 0);
    expect(Number(asset?.costBasisInr?.amount)).toBeCloseTo(
      (10 * 207.87 + 5 * 266.8) * 95.3,
      0,
    );
  });

  /*
   * A price arrives by import, never from a feed — the API container has no
   * route out (ADR-010). So it is as at the day the statement was loaded, and
   * that date travels with it or the figure goes quietly stale.
   */
  it('dates the price, so a screen cannot imply it is live', async () => {
    expectOk(await importHoldings());

    const asset = (await LedgerUC.assets()).find((a) => a.symbol === 'ACME');

    expect(asset?.priceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(asset?.marketPricePerUnit?.amount)).toBeCloseTo(259.43, 2);
  });
});

describe('Scenario: An unpriced holding is carried at cost', () => {
  /*
   * Property, unlisted shares, hand loans and chits have no market price and
   * never will. Carrying them at cost is the correct answer — the failure would
   * be valuing them at zero, or dropping them from the total.
   */
  it('leaves market value absent rather than inventing one', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2026-04-10',
        symbol: 'NOPRICE',
        quantity: '100',
        pricePerUnit: { amount: '50', currency: 'INR' },
      }),
    );

    const asset = (await LedgerUC.assets()).find((a) => a.symbol === 'NOPRICE');

    expect(asset?.marketValue).toBeUndefined();
    expect(asset?.unrealisedInr).toBeUndefined();
    // But the cost is there, and in rupees, so a total can still include it.
    expect(Number(asset?.costBasisInr?.amount)).toBeCloseTo(5000, 2);
  });
});

describe('Scenario: A statement that contradicts itself is not guessed from', () => {
  /*
   * Two rows of one symbol quoting different prices per share means the export
   * is inconsistent. Picking one would be inventing a valuation; the holding is
   * carried at cost instead, which is the answer that cannot be wrong.
   */
  it('stores no price when two rows disagree about it', async () => {
    const CONFLICTING = [
      'Record Type,Symbol,Plan Type,Date Acquired,Sellable Qty.,Est. Market Value,Grant Number,Grant Date,Vest Date,Purchased Qty.,Est. Cost Basis (per share):',
      'Grant,ACME,Rest. Stock,22-SEP-2023,10,"$2,594.30",00146549,22-MAR-2022,22-SEP-2023,10,$207.87',
      // $300.00 a share, against $259.43 above.
      'Grant,ACME,Rest. Stock,22-DEC-2023,5,"$1,500.00",00146549,22-MAR-2022,22-DEC-2023,5,$266.80',
    ].join('\n');

    expectOk(await importHoldings(CONFLICTING));

    expect(PriceRepository.all()).toHaveLength(0);
    const asset = (await LedgerUC.assets()).find((a) => a.symbol === 'ACME');
    expect(asset?.marketValue).toBeUndefined();
    expect(Number(asset?.costBasis.amount)).toBeGreaterThan(0);
  });
});
