/**
 * FUNCTIONAL — an E*TRADE G&L import, end to end, with its Rule 115 rates.
 *
 * The parser's own tests cover which columns are read. What these cover is the
 * thing the parser cannot do alone: every foreign figure reaching the vault
 * carries the SBI TT buy rate for the last day of the month preceding its own
 * leg, stored beside it, so the rupee figure is reproducible years later.
 *
 * The scenario that makes this worth a functional test is the long-held RSU:
 * vested in 2021, sold in 2026. Its cost converts at the January-2021 basis and
 * its proceeds at the April-2026 basis, five years and twenty rupees to the
 * dollar apart. A single-date conversion erases that difference entirely, and
 * the money it erases is taxable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ImportStatementUC,
  RatesUC,
  VaultUC,
  resetPorts,
} from '@porttrack/app-services';
import { AssetRepository, ExitRepository, Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const REF = 'sbi-fx-ratekeeper/SBI_REFERENCE_RATES_USD.csv';

const FIXTURE = join(import.meta.dirname, '../../fixtures/etrade/gains-losses-expanded.csv');

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const PDF = 'https://github.com/sahilgupta/sbi-fx-ratekeeper/blob/main/pdf_files/x.pdf';
const row = (stamp: string, ttBuy: string) =>
  `${stamp},${PDF},${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;

/*
 * Month-end rates, deliberately far apart so a figure converted at the wrong one
 * is unmistakable rather than merely slightly off.
 *
 * These are the Rule 115 basis dates for the fixture's legs:
 *   vest 2021-02-10 → 2021-01-31    sale 2026-05-20 → 2026-04-30
 *   vest 2026-01-15 → 2025-12-31    sale 2026-01-16 → 2025-12-31
 *   vest 2026-03-22 → 2026-02-28    sale 2026-03-23 → 2026-02-28
 *   vest 2026-06-15 → 2026-05-31    sale 2026-06-22 → 2026-05-31
 */
const RATES = [
  HEADER,
  row('2021-01-31 09:00', '73.10'),
  row('2025-12-31 09:00', '89.47'),
  row('2026-02-28 09:00', '91.20'),
  row('2026-04-30 09:00', '94.00'),
  row('2026-05-31 09:00', '94.60'),
].join('\n');

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porttrack-gl-'));
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

const seedRates = () =>
  RatesUC.importArchive({ csv: RATES, currency: 'USD', documentRef: REF });

const importGl = () =>
  ImportStatementUC.execute({
    file: readFileSync(FIXTURE),
    fileName: 'G&L_Expanded.csv',
    parser: 'ETRADE_GL',
    mode: 'LENIENT',
  });

describe('Scenario: The G&L export reaches the ledger', () => {
  it('creates holdings and the disposals that closed them', async () => {
    expectOk(await seedRates());
    const report = expectOk(await importGl());

    // Four good rows, each yielding an acquisition and a disposal.
    expect(report.created).toBe(8);
    // The one deliberately malformed date, reported rather than dropped.
    expect(report.rejected).toBe(1);

    const exits = await ExitRepository.all();
    expect(exits).toHaveLength(4);
  });

  /*
   * ONE holding for one symbol, whatever the award. RSU and ESPP were once asset
   * classes of their own, which split a company's shares across two assets —
   * double counted, and matched FIFO in two separate queues.
   */
  it('files every award under one FOREIGN_EQUITY holding per symbol', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const assets = await AssetRepository.all();
    expect(assets).toHaveLength(1);
    expect(assets[0]?.assetClass).toBe('FOREIGN_EQUITY');

    // Both award kinds live on the lots of that single holding.
    const kinds = new Set(assets[0]?.lots.map((lot) => lot.equityAward?.kind));
    expect(kinds.has('RSU')).toBe(true);
    expect(kinds.has('ESPP')).toBe(true);
  });

  /*
   * Both legs of a row must land on ONE asset. When they do not, the sale finds
   * nothing to deplete and is reported as unapplied — the holding stays on the
   * books and the disposal disappears from the gain.
   */
  it('leaves no disposal unapplied', async () => {
    expectOk(await seedRates());
    const report = expectOk(await importGl());

    expect(report.unapplied ?? []).toEqual([]);
  });
});

describe('Scenario: Each leg carries the rate for its own Rule 115 basis month', () => {
  it('stamps a lot from the month preceding the VEST', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const lots = (await AssetRepository.all()).flatMap((a) => a.lots);
    const vested2021 = lots.find((lot) => lot.acquisitionDate === '2021-02-10');

    // Basis date 2021-01-31. Compared numerically: the store normalises a
    // decimal string, so `73.10` comes back as `73.1` and both are the rate.
    expect(Number(vested2021?.fx?.taxRate)).toBe(73.1);
    expect(vested2021?.fx?.taxRateSource).toBe('SBI_ITBR');
  });

  it('stamps a disposal from the month preceding the SALE', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const sale = (await ExitRepository.all()).find((exit) => exit.exitDate === '2026-05-20');

    // Basis date 2026-04-30 — a different month from the vest, five years apart.
    expect(Number(sale?.fx?.taxRate)).toBe(94);
  });

  /*
   * The point of the whole exercise, asserted directly: the two legs of one
   * holding do NOT share a rate. Collapsing them is the bug this guards.
   */
  it('gives the vest and the sale different rates', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const lots = (await AssetRepository.all()).flatMap((a) => a.lots);
    const vest = lots.find((lot) => lot.acquisitionDate === '2021-02-10');
    const sale = (await ExitRepository.all()).find((exit) => exit.exitDate === '2026-05-20');

    expect(vest?.fx?.taxRate).not.toBe(sale?.fx?.taxRate);
  });

  /*
   * The rule, end to end, as arithmetic.
   *
   *   gain = (sp$ × q × TTBuy[month-end before sale])
   *        − (vp$ × q × TTBuy[month-end before vest])
   *
   * The 2021 RSU: 20 units vested at $150, sold 2026-05-20 at $250. Matched to
   * the tranche the file names, so the legs are five years apart:
   *
   *   cost     = 20 × $150 × 73.10 (basis 2021-01-31) = ₹219,300
   *   proceeds = 20 × $250 × 94.00 (basis 2026-04-30) = ₹470,000
   *   gain     =                                        ₹250,700
   *
   * Converting the gain once at the sale rate instead would give
   * (250 − 150) × 20 × 94.00 = ₹188,000 — understating it by ₹62,700 of rupee
   * depreciation that is genuinely taxable.
   */
  it('stores both legs and the gain, each leg at its own basis month', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const sale = (await ExitRepository.all()).find((exit) => exit.exitDate === '2026-05-20');

    expect(Number(sale?.costBasisTaxInr?.amount)).toBeCloseTo(20 * 150 * 73.1, 2);
    expect(Number(sale?.proceedsTaxInr?.amount)).toBeCloseTo(20 * 250 * 94, 2);
    expect(Number(sale?.taxableGainInr?.amount)).toBeCloseTo(250_700, 2);

    // The single-rate answer is NOT what was stored.
    expect(Number(sale?.taxableGainInr?.amount)).not.toBeCloseTo(188_000, 2);
  });

  /*
   * And it is matched to the tranche the SOURCE named, not oldest-first.
   *
   * Matching FIFO re-derives an answer the broker's own statement contradicts:
   * this sale would have drawn on two 2026 lots instead of the 2021 vest it
   * actually disposed of, for a gain of ₹107,795 against the real ₹250,700.
   */
  it('matches each disposal to the tranche its source names', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const exits = await ExitRepository.all();

    expect(exits.every((exit) => exit.lotMatching === 'SPECIFIC')).toBe(true);
    const sale = exits.find((exit) => exit.exitDate === '2026-05-20');
    expect(sale?.allocations).toHaveLength(1);
    expect(sale?.allocations[0]?.acquisitionDate).toBe('2021-02-10');
  });

  /*
   * Regression. `allocateFifo` used to drop the lot's acquisition date when it
   * built an allocation, so `rule115Legs` found none, fell back to the exit's own
   * date, and converted the COST leg at the SALE month's rate. Every imported
   * foreign disposal silently became a one-date conversion — ADR-003 held in the
   * unit tests, where allocations are hand-built with dates, and nowhere else.
   */
  it('carries each lot’s acquisition date onto the disposal', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const exits = await ExitRepository.all();
    const everyAllocation = exits.flatMap((exit) => exit.allocations);

    expect(everyAllocation.length).toBeGreaterThan(0);
    expect(everyAllocation.every((a) => a.acquisitionDate !== undefined)).toBe(true);
  });

  it('stores the rupee value of the proceeds beside the dollars', async () => {
    expectOk(await seedRates());
    expectOk(await importGl());

    const sale = (await ExitRepository.all()).find((exit) => exit.exitDate === '2026-05-20');

    // 20 shares at $250 = $5,000, at the 2026-05-20 valuation rate of 94.00.
    expect(sale?.pricePerUnit.currency).toBe('USD');
    expect(sale?.valuationInr?.currency).toBe('INR');
    expect(Number(sale?.valuationInr?.amount)).toBeCloseTo(5000 * 94, 2);
  });
});

describe('Scenario: A rate that does not exist is reported, never invented', () => {
  /*
   * The failure this codebase must never have. With no rates seeded, every
   * foreign figure is unconvertible — and the right behaviour is to store the
   * dollars, omit the rupees, and SAY SO. A substituted or nearest-date rate
   * would produce a tax figure that looks entirely ordinary and is wrong.
   */
  it('imports the rows but leaves them unpriced when no rate is available', async () => {
    const report = expectOk(await importGl());

    expect(report.created).toBe(8);

    const unpriced = report.unpriced ?? [];
    expect(unpriced.length).toBeGreaterThan(0);
    expect(unpriced.every((leg) => leg.currency === 'USD')).toBe(true);

    const sale = (await ExitRepository.all()).find((exit) => exit.exitDate === '2026-05-20');
    expect(sale?.fx).toBeUndefined();
    expect(sale?.valuationInr).toBeUndefined();
    // The dollar figures are intact — it is only the rupee value that is absent.
    expect(sale?.pricePerUnit.amount).toBe('250');
  });
});
