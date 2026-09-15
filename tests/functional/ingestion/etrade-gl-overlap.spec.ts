/**
 * FUNCTIONAL — what a G&L import does to shares the ledger ALREADY holds.
 *
 * The G&L export describes closed round trips, so importing it re-states
 * acquisitions that may already be on the books from an earlier import or a
 * hand-typed trade. Getting this wrong doubles a holding, and a doubled RSU lot
 * is not a visible error — it is a plausible portfolio with twice the cost basis
 * and, once sold, roughly half the gain.
 *
 * These pin down which overlaps are absorbed and which are not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ImportStatementUC,
  RatesUC,
  TradeUC,
  VaultUC,
  resetPorts,
} from '@porttrack/app-services';
import { AssetRepository, ExitRepository, Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const FIXTURE = join(import.meta.dirname, '../../fixtures/etrade/gains-losses-expanded.csv');

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const rateRow = (stamp: string, ttBuy: string) =>
  `${stamp},https://example.invalid/x.pdf,${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;
const RATES = [
  HEADER,
  rateRow('2021-01-31 09:00', '73.10'),
  rateRow('2025-12-31 09:00', '89.47'),
  rateRow('2026-02-28 09:00', '91.20'),
  rateRow('2026-04-30 09:00', '94.00'),
  rateRow('2026-05-31 09:00', '94.60'),
].join('\n');

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-gl-overlap-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
  expectOk(
    await RatesUC.importArchive({ csv: RATES, currency: 'USD', documentRef: 'test' }),
  );
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

const importGl = () =>
  ImportStatementUC.execute({
    file: readFileSync(FIXTURE),
    fileName: 'G&L_Expanded.csv',
    parser: 'ETRADE_GL',
    mode: 'LENIENT',
  });

const lotsOf = async (assetClass: string) => {
  const assets = await AssetRepository.all();
  return assets.filter((a) => a.assetClass === assetClass).flatMap((a) => a.lots);
};

describe('Scenario: The same G&L file imported twice', () => {
  /*
   * The ordinary case, and the one a user WILL hit: they re-download the year's
   * export after a later sale and import the whole thing again.
   */
  it('recognises every row the second time and creates nothing', async () => {
    expectOk(await importGl());
    const second = expectOk(await importGl());

    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(8);
  });

  it('leaves the holdings and disposals exactly as they were', async () => {
    expectOk(await importGl());
    const lotsBefore = (await lotsOf('RSU')).length;
    const exitsBefore = (await ExitRepository.all()).length;

    expectOk(await importGl());

    expect((await lotsOf('RSU')).length).toBe(lotsBefore);
    expect((await ExitRepository.all()).length).toBe(exitsBefore);
  });
});

describe('Scenario: The vest is already on the ledger as an RSU', () => {
  /*
   * The overlap that IS absorbed. An earlier E*TRADE transaction-history import
   * records the release as an RSU lot, and the natural key the ledger rebuilds
   * for it — kind, date, symbol, quantity, cost per unit — is the same key the
   * G&L acquisition produces. Same asset id, same key, so the row is a duplicate.
   */
  it('absorbs a matching RSU lot rather than opening a second one', async () => {
    const history = [
      'TransactionDate,TransactionType,Symbol,Quantity,Price,FmvAtVest',
      // The 2021 vest from the fixture: 20 shares at $150. ISO, because the
      // transaction-history reader accepts ISO and `10-Feb-2021` but not the
      // US slash form the G&L export uses — the two files genuinely differ.
      '2021-02-10,RSU Release,ACME,20,150,150',
    ].join('\n');

    expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from(history, 'utf8'),
        fileName: 'history.csv',
        parser: 'ETRADE',
        mode: 'LENIENT',
      }),
    );
    const before = await lotsOf('RSU');

    const report = expectOk(await importGl());

    // One acquisition recognised; the rest of the file is new.
    expect(report.duplicates).toBeGreaterThan(0);
    const after = await lotsOf('RSU');
    const acquiredIn2021 = after.filter((lot) => lot.acquisitionDate === '2021-02-10');
    expect(acquiredIn2021).toHaveLength(1);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('Scenario: One order split across two rows', () => {
  /*
   * The bug that left six tranches overstated against real data.
   *
   * A broker reports ONE order against ONE tranche on ONE day as several rows
   * where a wash-sale adjustment applies to part of the fill — real pairs from an
   * E*TRADE export are 5.002/0.998 and 4.998/1.002. The disposal id was built
   * from order, tranche and date, so both rows produced the same id, the second
   * was discarded as already-seen, and its units were never taken off the
   * holding. Nothing reported it: the import said "created", and the position was
   * simply too big.
   */
  const SPLIT = [
    'Record Type,Symbol,Plan Type,Quantity,Date Acquired,Adjusted Cost Basis,Date Sold,Total Proceeds,Adjusted Gain/Loss,Order Type,Grant Number,Vest Date,Order Number',
    'Sell,ACME,RS,5.002,09/22/2023,"$1,039.67",09/25/2023,"$1,023.64",-$16.03,RS STC,00117893,09/22/2023,76324960',
    'Sell,ACME,RS,0.998,09/22/2023,$207.55,09/25/2023,$204.35,-$3.20,RS STC,00117893,09/22/2023,76324960',
  ].join('\n');

  const importSplit = () =>
    ImportStatementUC.execute({
      file: Buffer.from(SPLIT, 'utf8'),
      fileName: 'split.csv',
      parser: 'ETRADE_GL',
      mode: 'LENIENT',
    });

  it('records both halves of a split fill, not just the first', async () => {
    expectOk(await importSplit());

    const exits = await ExitRepository.all();

    expect(exits).toHaveLength(2);
    expect(new Set(exits.map((exit) => exit.txnId)).size).toBe(2);
    // And the units add up: 5.002 + 0.998 = 6, all of it off the holding.
    const disposed = exits.reduce((sum, exit) => sum + Number(exit.quantity), 0);
    expect(disposed).toBeCloseTo(6, 6);
  });

  /*
   * Quantity in the disposal id must not cost idempotency: a second import of
   * the same file must leave the ledger exactly as it was.
   *
   * The assertion is on STATE, not on the report's `created` count, and that is
   * deliberate. Duplicate detection rebuilds its keys from stored lots, and a
   * slice's own per-unit cost is not the lot's: E*TRADE apportions a wash-sale
   * adjustment across the halves of a split fill, so 5.002 units cost 207.85085
   * each and the other 0.998 cost 207.96593. The lot keeps the first, the second
   * slice's key therefore cannot be reconstructed, and the row is counted as new.
   *
   * It is not applied — the projection sees the tranche already present and does
   * nothing — so the ledger is right and only the tally is generous. Asserting
   * `created === 0` would be asserting the tally rather than the behaviour.
   */
  it('leaves the ledger unchanged on a second import of the same file', async () => {
    expectOk(await importSplit());
    const before = (await AssetRepository.all()).flatMap((asset) => asset.lots);

    expectOk(await importSplit());
    const after = (await AssetRepository.all()).flatMap((asset) => asset.lots);

    expect(await ExitRepository.all()).toHaveLength(2);
    expect(after).toHaveLength(before.length);
    // The tranche is still 6 units, not 12.
    expect(after.map((lot) => lot.quantity)).toEqual(before.map((lot) => lot.quantity));
    expect(after.map((lot) => lot.remainingQuantity)).toEqual(
      before.map((lot) => lot.remainingQuantity),
    );
  });
});

describe('Scenario: The vest is on the ledger at a slightly different price', () => {
  /*
   * The sharp edge of key-based matching, pinned so it is a known property
   * rather than a surprise.
   *
   * The natural key includes cost per unit. The G&L derives that by dividing the
   * stated total by the quantity; a transaction history states a price directly.
   * When the two disagree by even a cent — different rounding, a fee folded in —
   * nothing matches and the vest is recorded twice.
   *
   * There is no safe automatic fix: loosening the key to ignore price would
   * suppress a genuine second vest of the same size on the same day, which is
   * ordinary for a quarterly grant. The answer is to not import both files for
   * the same period, and the import report's counts are what make a double
   * visible.
   */
  it('records a second lot when the cost per unit differs at all', async () => {
    const history = [
      'TransactionDate,TransactionType,Symbol,Quantity,Price,FmvAtVest',
      // $150.01 against the G&L's $150.00.
      '2021-02-10,RSU Release,ACME,20,150.01,150.01',
    ].join('\n');

    expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from(history, 'utf8'),
        fileName: 'history.csv',
        parser: 'ETRADE',
        mode: 'LENIENT',
      }),
    );

    expectOk(await importGl());

    const acquiredIn2021 = (await lotsOf('RSU')).filter(
      (lot) => lot.acquisitionDate === '2021-02-10',
    );
    expect(acquiredIn2021).toHaveLength(2);
  });
});

describe('Scenario: The same shares are already held as plain foreign equity', () => {
  /*
   * The overlap that is NOT absorbed, and the one worth knowing about.
   *
   * A hand-typed trade or a Vested import files the shares as FOREIGN_EQUITY. The
   * G&L files them as RSU — a different asset class, therefore a different asset
   * id AND a different natural key (`BUY` versus `RSU_VEST`). Nothing matches, so
   * both survive side by side.
   *
   * That is the correct ledger outcome: they genuinely are different tax objects,
   * and silently merging an RSU into a plain equity holding would lose the
   * perquisite basis. But the user sees their position apparently double, so the
   * behaviour is pinned here and called out in the import report.
   */
  it('keeps them separate, so the same symbol appears under two asset classes', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'FOREIGN_EQUITY',
        side: 'BUY',
        tradeDate: '2021-02-10',
        symbol: 'ACME',
        quantity: '20',
        pricePerUnit: { amount: '150', currency: 'USD' },
      }),
    );

    const report = expectOk(await importGl());

    // Nothing was recognised as a duplicate of the manual trade.
    expect(report.created).toBe(8);

    const classes = (await AssetRepository.all())
      .filter((a) => a.symbol === 'ACME')
      .map((a) => a.assetClass)
      .sort();
    expect(classes).toContain('FOREIGN_EQUITY');
    expect(classes).toContain('RSU');
  });
});
