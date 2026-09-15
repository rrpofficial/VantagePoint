/**
 * FUNCTIONAL — trades typed in by hand (equity, ETF, mutual fund, unlisted).
 *
 * The point of these is not that a form saves something. It is that a hand-typed
 * trade and an imported one land on the SAME ledger by the SAME rules: one asset
 * per instrument however it arrived, FIFO depletion on a sell, and a disposal
 * record the capital-gains engine can read. A parallel write path for manual
 * entry would be a second set of rules, and the divergence would first show up
 * in a tax figure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerUC, TradeUC, resetPorts } from '@vantagepoint/app-services';
import { DuplicateTradeError } from '@vantagepoint/shared-kernel';
import { Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-trades-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
});

afterEach(async () => {
  await Vault.close();
});

const buy = (input: {
  assetClass?: string;
  symbol?: string;
  folioRef?: string;
  schemeName?: string;
  isin?: string;
  date?: string;
  qty?: string;
  price?: string;
  fees?: string;
  confirm?: boolean;
}) =>
  TradeUC.record({
    assetClass: input.assetClass ?? 'DOMESTIC_EQUITY',
    side: 'BUY',
    tradeDate: input.date ?? '2025-04-10',
    quantity: input.qty ?? '100',
    pricePerUnit: inr(input.price ?? '1500'),
    ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
    ...(input.folioRef === undefined ? {} : { folioRef: input.folioRef }),
    ...(input.schemeName === undefined ? {} : { schemeName: input.schemeName }),
    ...(input.isin === undefined ? {} : { isin: input.isin }),
    ...(input.fees === undefined ? {} : { fees: inr(input.fees) }),
    ...(input.confirm === undefined ? {} : { confirmDuplicate: input.confirm }),
  });

const sell = (input: {
  symbol?: string;
  date?: string;
  qty?: string;
  price?: string;
  confirm?: boolean;
}) =>
  TradeUC.record({
    assetClass: 'DOMESTIC_EQUITY',
    side: 'SELL',
    tradeDate: input.date ?? '2026-01-15',
    quantity: input.qty ?? '40',
    pricePerUnit: inr(input.price ?? '1800'),
    symbol: input.symbol ?? 'INFY',
    ...(input.confirm === undefined ? {} : { confirmDuplicate: input.confirm }),
  });

describe('Scenario: An equity purchase is typed in', () => {
  it('creates a holding with one lot at the stated cost', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500' }));

    const assets = await LedgerUC.assets();
    expect(assets).toHaveLength(1);
    expect(assets[0]?.assetClass).toBe('DOMESTIC_EQUITY');
    expect(assets[0]?.symbol).toBe('INFY');
    expect(assets[0]?.lots).toHaveLength(1);
    expect(assets[0]?.lots[0]?.quantity).toBe('100');
    expect(assets[0]?.lots[0]?.costPerUnit.amount).toBe('1500');
  });

  it('accepts an Indian-format quantity and price', async () => {
    expectOk(await buy({ symbol: 'RELIANCE', qty: '1,000', price: '2,450.50' }));

    const lot = (await LedgerUC.assets())[0]?.lots[0];
    expect(lot?.quantity).toBe('1000');
    expect(lot?.costPerUnit.amount).toBe('2450.5');
  });

  it('adds a second lot to the SAME holding on a later purchase', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500', date: '2025-04-10' }));
    expectOk(await buy({ symbol: 'INFY', qty: '50', price: '1700', date: '2025-09-01' }));

    const assets = await LedgerUC.assets();
    // One instrument, two lots — not two holdings of the same share.
    expect(assets).toHaveLength(1);
    expect(assets[0]?.lots).toHaveLength(2);
  });

  it('records brokerage against the lot rather than dropping it', async () => {
    expectOk(await buy({ symbol: 'INFY', fees: '250' }));

    expect((await LedgerUC.assets())[0]?.lots[0]?.fees.amount).toBe('250');
  });
});

describe('Scenario: A mutual fund and a debt fund are typed in', () => {
  it('records a fund against its folio, not a ticker', async () => {
    expectOk(
      await buy({
        assetClass: 'DOMESTIC_MUTUAL_FUND',
        folioRef: '12345678/91',
        qty: '1543.21',
        price: '64.8812',
      }),
    );

    const assets = await LedgerUC.assets();
    expect(assets[0]?.assetClass).toBe('DOMESTIC_MUTUAL_FUND');
    expect(assets[0]?.folioRef).toBe('12345678/91');
    expect(assets[0]?.lots[0]?.quantity).toBe('1543.21');
  });

  it('keeps an equity fund and a debt fund as separate holdings', async () => {
    // Both are DOMESTIC_MUTUAL_FUND; the folio is what separates them, and the
    // scheme category is what will drive their different tax treatment.
    expectOk(await buy({ assetClass: 'DOMESTIC_MUTUAL_FUND', folioRef: 'EQ-001' }));
    expectOk(await buy({ assetClass: 'DOMESTIC_MUTUAL_FUND', folioRef: 'DEBT-002' }));

    expect(await LedgerUC.assets()).toHaveLength(2);
  });

  it('records unlisted shares by company name', async () => {
    expectOk(
      await buy({ assetClass: 'UNLISTED_SHARES', schemeName: 'Acme Private Limited', qty: '500' }),
    );

    const assets = await LedgerUC.assets();
    expect(assets[0]?.assetClass).toBe('UNLISTED_SHARES');
    expect(assets[0]?.lots[0]?.quantity).toBe('500');
  });

  it('records a foreign holding as FOREIGN, which decides its disclosure', async () => {
    expectOk(await buy({ assetClass: 'FOREIGN_EQUITY', symbol: 'AAPL' }));

    // Jurisdiction is derived, never typed — it decides Schedule FA.
    expect((await LedgerUC.assets())[0]?.jurisdiction).toBe('FOREIGN');
  });
});

describe('Scenario: A sale is typed in', () => {
  it('depletes the holding FIFO and records a disposal', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500', date: '2025-04-10' }));

    const sold = expectOk(await sell({ symbol: 'INFY', qty: '40', price: '1800' }));

    expect(sold.exits).toBe(1);
    const assets = await LedgerUC.assets();
    // The original quantity is preserved; only what REMAINS moves.
    expect(assets[0]?.lots[0]?.quantity).toBe('100');
    expect(assets[0]?.lots[0]?.remainingQuantity).toBe('60');
    expect(await LedgerUC.exits()).toHaveLength(1);
  });

  it('takes the earliest lot first across two purchases', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500', date: '2025-04-10' }));
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1700', date: '2025-09-01' }));

    expectOk(await sell({ symbol: 'INFY', qty: '120', price: '1800' }));

    const lots = (await LedgerUC.assets())[0]?.lots ?? [];
    const byDate = [...lots].sort((a, b) => a.acquisitionDate.localeCompare(b.acquisitionDate));
    expect(byDate[0]?.remainingQuantity).toBe('0');
    expect(byDate[1]?.remainingQuantity).toBe('80');
  });

  it('reports a sale with nothing to sell rather than inventing a position', async () => {
    const result = expectOk(await sell({ symbol: 'NOTHELD', qty: '10' }));

    expect(result.exits).toBe(0);
    expect(result.unapplied.length).toBeGreaterThan(0);
    expect(await LedgerUC.exits()).toHaveLength(0);
  });
});

describe('Scenario: The same trade typed twice', () => {
  it('is refused until confirmed', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500' }));

    const second = await buy({ symbol: 'INFY', qty: '100', price: '1500' });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected a duplicate to be flagged');
    expect(second.error).toBeInstanceOf(DuplicateTradeError);
  });

  it('records both fills once confirmed, keeping the full quantity', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500' }));

    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500', confirm: true }));

    const lots = (await LedgerUC.assets())[0]?.lots ?? [];
    // Two lots, 200 units. Without a distinct lot id the second fill would merge
    // into the first and 100 units would simply vanish.
    expect(lots).toHaveLength(2);
    const total = lots.reduce((sum, lot) => sum + Number(lot.quantity), 0);
    expect(total).toBe(200);
  });

  it('does not flag a different price on the same day', async () => {
    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1500' }));

    expectOk(await buy({ symbol: 'INFY', qty: '100', price: '1510' }));

    expect((await LedgerUC.assets())[0]?.lots).toHaveLength(2);
  });
});

describe('Scenario: Input that would corrupt the ledger is refused', () => {
  it('refuses an asset class that is not a tradeable holding', async () => {
    const result = await TradeUC.record({
      assetClass: 'HAND_LOAN',
      side: 'BUY',
      tradeDate: '2025-04-10',
      quantity: '1',
      pricePerUnit: inr('100000'),
      symbol: 'X',
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a trade with no identifier at all', async () => {
    const result = await TradeUC.record({
      assetClass: 'DOMESTIC_EQUITY',
      side: 'BUY',
      tradeDate: '2025-04-10',
      quantity: '10',
      pricePerUnit: inr('100'),
    });

    expect(result.ok).toBe(false);
  });

  it.each([
    ['a quantity of zero', { qty: '0' }],
    ['a negative quantity', { qty: '-5' }],
    ['a price of zero', { price: '0' }],
    ['a quantity that is not a number', { qty: 'ten' }],
    ['a price that is not a number', { price: 'free' }],
  ])('refuses %s', async (_label, overrides) => {
    const result = await buy({ symbol: 'INFY', ...overrides });

    expect(result.ok).toBe(false);
    expect(await LedgerUC.assets()).toHaveLength(0);
  });

  it('refuses a date that is not ISO', async () => {
    const result = await buy({ symbol: 'INFY', date: '10/04/2025' });

    expect(result.ok).toBe(false);
  });

  it('is locked out when the vault is', async () => {
    await Vault.lock();

    expect((await buy({ symbol: 'INFY' })).ok).toBe(false);
  });
});
