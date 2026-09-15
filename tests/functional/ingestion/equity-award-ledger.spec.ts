/**
 * FUNCTIONAL — grants, tranches and sell-to-cover, once they reach the ledger.
 *
 * Three properties, each of which was wrong or absent before:
 *
 *  1. A tranche sold under TWO orders produces two disposals, not one. Exit ids
 *     used to be derived from the lot, so a sell-to-cover on vest day and a
 *     manual sale of the same vest collided and the second was silently dropped
 *     as already-seen — its proceeds simply absent from the gain.
 *  2. Grant and tranche detail survives into storage, so an RSU and an ESPP are
 *     distinguishable in one table and a figure can be traced to the grant it
 *     came from.
 *  3. Sell-to-cover is excluded from capital gains BY DEFAULT and reported,
 *     never dropped quietly — and the disposals where that exclusion stops being
 *     immaterial are flagged.
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
import { CapitalGainsEngine, TaxRuleTable } from '@porttrack/tax-engine';
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
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-award-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
  expectOk(await RatesUC.importArchive({ csv: RATES, currency: 'USD', documentRef: 'test' }));
  expectOk(
    await ImportStatementUC.execute({
      file: readFileSync(FIXTURE),
      fileName: 'G&L_Expanded.csv',
      parser: 'ETRADE_GL',
      mode: 'LENIENT',
    }),
  );
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

const allLots = async () => (await AssetRepository.all()).flatMap((a) => a.lots);

/*
 * Every equity-compensation lot is FOREIGN_EQUITY now; the AWARD says how it was
 * acquired. Keyed that way so a subject map still classifies each disposal.
 */
const subjectsFor = (exits: readonly { txnId: string }[]) =>
  Object.fromEntries(exits.map((exit) => [exit.txnId, 'FOREIGN_EQUITY' as const]));

describe('Scenario: A lot knows the grant it came from', () => {
  it('stores grant, tranche and award kind on every equity lot', async () => {
    const lots = await allLots();

    expect(lots.length).toBeGreaterThan(0);
    for (const lot of lots) {
      expect(lot.equityAward).toBeDefined();
      expect(lot.equityAward?.grantRef).toMatch(/^(grant|offer)_/);
    }
  });

  /*
   * "Same table, but tell them apart." Both live in `lots`; the award kind is
   * what distinguishes them, and an ESPP carries a purchase date where an RSU
   * carries a vest date.
   */
  it('distinguishes RSU from ESPP, each with the date that applies to it', async () => {
    const lots = await allLots();
    const rsu = lots.find((lot) => lot.equityAward?.kind === 'RSU');
    const espp = lots.find((lot) => lot.equityAward?.kind === 'ESPP');

    expect(rsu?.equityAward?.vestDate).toBeDefined();
    expect(rsu?.equityAward?.purchaseDate).toBeUndefined();

    expect(espp?.equityAward?.purchaseDate).toBeDefined();
    expect(espp?.equityAward?.vestDate).toBeUndefined();
  });

  /*
   * The ESPP distinction that matters for tax: what was PAID is not the cost
   * basis. Section 49(2AA) sets the basis at fair market value on the purchase
   * date; the discount below it was already charged as salary. Both are stored
   * so the figure can be checked, and they must differ.
   */
  it('stores the ESPP purchase price separately from its cost basis', async () => {
    const espp = (await allLots()).find((lot) => lot.equityAward?.kind === 'ESPP');

    const paid = Number(espp?.equityAward?.purchasePrice?.amount);
    const basis = Number(espp?.costPerUnit.amount);

    expect(paid).toBeGreaterThan(0);
    expect(basis).toBeGreaterThan(paid);
    expect(Number(espp?.equityAward?.discountPerUnit?.amount)).toBeCloseTo(basis - paid, 2);
  });

  /** An RSU costs nothing to acquire, so basis and FMV at vest are the same. */
  it('costs an RSU lot at its vest FMV', async () => {
    const rsu = (await allLots()).find((lot) => lot.equityAward?.kind === 'RSU');

    expect(rsu?.equityAward?.fmvAtAcquisition?.amount).toBe(rsu?.costPerUnit.amount);
  });
});

describe('Scenario: One tranche, two sell orders', () => {
  /*
   * The regression. Exit ids were derived from the LOT, so a sell-to-cover and a
   * later manual sale of the same vest produced one id — and the second was
   * dropped as an already-seen exit, taking its proceeds out of the gain.
   */
  it('records every disposal, and gives each its own identity', async () => {
    const exits = await ExitRepository.all();

    expect(exits).toHaveLength(4);
    expect(new Set(exits.map((exit) => exit.txnId)).size).toBe(4);
  });

  it('keeps the broker’s order reference on each disposal', async () => {
    const exits = await ExitRepository.all();

    expect(exits.every((exit) => exit.orderRef !== undefined)).toBe(true);
  });
});

describe('Scenario: Sell-to-cover is flagged, excluded, and reported', () => {
  it('marks the vest-day block as sell-to-cover and the rest as ordinary sales', async () => {
    const exits = await ExitRepository.all();
    const stc = exits.filter((exit) => exit.disposalKind === 'SELL_TO_COVER');

    // Two RS STC rows in the fixture.
    expect(stc).toHaveLength(2);
    expect(exits.filter((exit) => exit.disposalKind === 'SALE')).toHaveLength(2);
  });

  it('leaves sell-to-cover out of the gain by default, and says which', async () => {
    const exits = await ExitRepository.all();
    const subjects = subjectsFor(exits);

    const result = CapitalGainsEngine.compute(exits, subjects, expectOk(TaxRuleTable.rulesFor('2025-26')));

    // Excluded from the totals...
    expect(result.gains).toHaveLength(2);
    // ...and named, rather than silently absent.
    expect(result.excludedSellToCover).toHaveLength(2);
  });

  it('includes them when the taxpayer says to', async () => {
    const exits = await ExitRepository.all();
    const subjects = subjectsFor(exits);
    const rules = expectOk(TaxRuleTable.rulesFor('2025-26'));

    const included = CapitalGainsEngine.compute(exits, subjects, rules, {
      includeSellToCover: true,
    });

    expect(included.gains).toHaveLength(4);
    expect(included.excludedSellToCover).toHaveLength(0);
  });

  /*
   * What the exclusion actually costs, once matching is right.
   *
   * With the sale matched to the tranche it funded, a sell-to-cover really is
   * the day's intraday movement — ₹894 and ₹456 here. That is the reasoning
   * behind excluding them, and it holds ONLY because the disposal is matched to
   * its own vest. Matched oldest-first it consumed a 2021 lot instead, and the
   * same exclusion silently dropped over ₹50,000.
   *
   * The amount is reported either way, so the choice stays an informed one
   * rather than an assumption about how the matching happened to run.
   */
  it('reports how much was left out, and it is now genuinely small', async () => {
    const exits = await ExitRepository.all();
    const subjects = subjectsFor(exits);

    const result = CapitalGainsEngine.compute(
      exits,
      subjects,
      expectOk(TaxRuleTable.rulesFor('2025-26')),
    );

    const excludedTotal = result.excludedSellToCover.reduce(
      (sum, d) => sum + Number(d.gainInr?.amount ?? 0),
      0,
    );

    expect(result.excludedSellToCover).toHaveLength(2);
    // Every exclusion carries its amount, so none of them is invisible.
    expect(result.excludedSellToCover.every((d) => d.gainInr !== undefined)).toBe(true);
    expect(excludedTotal).toBeLessThan(2_000);
  });

  /*
   * And matched to its own vest, a same-day sell-to-cover no longer spans two
   * basis months — vest and sale fall in the same month, so one Rule 115 rate
   * applies to both legs and there is no FX divergence to exclude either.
   */
  it('no longer spans different basis months', async () => {
    const exits = await ExitRepository.all();
    const subjects = subjectsFor(exits);

    const result = CapitalGainsEngine.compute(
      exits,
      subjects,
      expectOk(TaxRuleTable.rulesFor('2025-26')),
    );

    expect(result.excludedSellToCover.some((d) => d.straddlesBasisMonths)).toBe(false);
  });

  /*
   * A sell-to-cover disposes of the shares that just vested, not of a holding
   * from years earlier. Asserted directly because it is the whole correction.
   */
  it('matches a sell-to-cover to the vest it funded', async () => {
    const stc = (await ExitRepository.all()).find(
      (exit) => exit.disposalKind === 'SELL_TO_COVER' && exit.exitDate === '2026-01-16',
    );

    expect(stc?.lotMatching).toBe('SPECIFIC');
    // The vest was the day before, not five years before.
    expect(stc?.allocations[0]?.acquisitionDate).toBe('2026-01-15');
  });
});
