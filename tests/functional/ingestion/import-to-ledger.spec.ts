/**
 * FUNCTIONAL US-4.1 / US-8.3 — an import must change the portfolio.
 *
 * The regression this exists to prevent: ImportStatementUC used to parse a file,
 * return `created: 65`, and write nothing. Every unit test passed, the API
 * returned 200, and the dashboard stayed at ₹0. A report is not evidence of a
 * commit, so these tests assert on the LEDGER after the import, never on the
 * report alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ImportStatementUC, LedgerUC, ValuePortfolioUC, resetPorts } from '@vantagepoint/app-services';
import { AssetRepository, Vault } from '@vantagepoint/persistence';
import { TemplateRegistry } from '@vantagepoint/ingestion';
import { expectOk } from '@vantagepoint/test-kit';

const ROOT = resolve(import.meta.dirname, '../../..');
const PASSPHRASE = 'correct horse battery staple';
const tradebook = () => readFileSync(join(ROOT, 'tests/fixtures/zerodha/tradebook.csv'));

async function unlocked(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-import-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
}

const importTradebook = () =>
  ImportStatementUC.execute({
    file: tradebook(),
    fileName: 'tradebook.csv',
    parser: 'ZERODHA_TRADEBOOK',
    mode: 'STRICT',
  });

beforeEach(unlocked);
afterEach(async () => {
  await Vault.close();
});

describe('Scenario: Importing a tradebook creates holdings that survive a reload', () => {
  it('writes assets to the vault, not just to the report', async () => {
    expectOk(await importTradebook());

    const assets = await LedgerUC.assets();
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset.assetClass === 'DOMESTIC_EQUITY')).toBe(true);
  });

  it('survives a lock and unlock cycle', async () => {
    expectOk(await importTradebook());
    const before = await LedgerUC.assets();

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    expect(await LedgerUC.assets()).toEqual(before);
  });

  it('makes the portfolio valuation non-zero', async () => {
    // The original failure was invisible precisely here: valuation read from a
    // hard-coded empty array, so net worth was ₹0 however much was imported.
    const before = expectOk(await ValuePortfolioUC.execute('2026-03-31T23:59:59.999+05:30'));
    expect(before.netWorth.amount).toBe('0');

    expectOk(await importTradebook());

    const after = expectOk(await ValuePortfolioUC.execute('2026-03-31T23:59:59.999+05:30'));
    expect(Number(after.netWorth.amount)).toBeGreaterThan(0);
    expect(after.positions.length).toBeGreaterThan(0);
  });

  it('groups trades of the same symbol into one asset', async () => {
    expectOk(await importTradebook());
    const assets = await LedgerUC.assets();
    const ids = assets.map((asset) => asset.assetId);
    expect(new Set(ids).size).toBe(ids.length);

    const tcs = assets.find((asset) => asset.symbol === 'TCS');
    expect(tcs).toBeDefined();
    expect(tcs?.lots.length).toBeGreaterThan(0);
  });

  it('applies sells against the lots, reducing remaining quantity', async () => {
    expectOk(await importTradebook());
    const assets = await LedgerUC.assets();

    const sold = assets.flatMap((asset) => asset.lots).filter(
      (lot) => Number(lot.remainingQuantity) < Number(lot.quantity),
    );
    // The fixture contains 25 sells; if none reduced a lot, FIFO never ran.
    expect(sold.length).toBeGreaterThan(0);
  });
});

describe('Scenario: Re-importing the same statement is idempotent (US-4.7)', () => {
  it('creates nothing on the second import', async () => {
    expectOk(await importTradebook());
    const first = await LedgerUC.assets();

    const second = expectOk(await importTradebook());
    expect(second.created).toBe(0);
    expect(second.duplicates).toBeGreaterThan(0);

    expect(await LedgerUC.assets()).toEqual(first);
  });

  it('does not double the lot count', async () => {
    expectOk(await importTradebook());
    const lotsAfterFirst = (await LedgerUC.assets()).flatMap((asset) => asset.lots).length;

    expectOk(await importTradebook());
    const lotsAfterSecond = (await LedgerUC.assets()).flatMap((asset) => asset.lots).length;

    expect(lotsAfterSecond).toBe(lotsAfterFirst);
  });

  it('does not apply the same disposal twice', async () => {
    // The bug this catches: sells left no stored trace, so on a second import
    // they looked new and FIFO depleted the holding again. Lot counts stayed
    // identical throughout, which is why the check above did not notice.
    expectOk(await importTradebook());
    const remainingAfterFirst = (await LedgerUC.assets())
      .flatMap((asset) => asset.lots)
      .map((lot) => lot.remainingQuantity);
    const exitsAfterFirst = await LedgerUC.exits();

    expectOk(await importTradebook());
    const remainingAfterSecond = (await LedgerUC.assets())
      .flatMap((asset) => asset.lots)
      .map((lot) => lot.remainingQuantity);

    expect(remainingAfterSecond).toEqual(remainingAfterFirst);
    expect(await LedgerUC.exits()).toEqual(exitsAfterFirst);
  });
});

describe('Scenario: Disposals are recorded, not merely subtracted', () => {
  it('stores one exit per sell with its FIFO lot breakdown', async () => {
    expectOk(await importTradebook());

    const exits = await LedgerUC.exits();
    expect(exits.length).toBeGreaterThan(0);
    for (const exit of exits) {
      expect(exit.allocations.length).toBeGreaterThan(0);
      const allocated = exit.allocations.reduce(
        (sum, allocation) => sum + Number(allocation.quantity),
        0,
      );
      // Every unit disposed of must be attributed to a lot, or the cost basis of
      // the disposal is unknowable.
      expect(allocated).toBeCloseTo(Number(exit.quantity), 8);
    }
  });

  it('keeps exits when the holding is re-saved', async () => {
    expectOk(await importTradebook());
    const before = await LedgerUC.exits();

    const assets = await LedgerUC.assets();
    // AssetRepository.save replaces an asset's children wholesale; exits live
    // outside that aggregate precisely so this cannot erase them.
    for (const asset of assets) expectOk(await AssetRepository.save(asset));

    expect(await LedgerUC.exits()).toEqual(before);
  });
});

describe('Scenario: A VantagePoint CSV template creates the asset it describes', () => {
  it('imports a cash template as a bank balance, not as equity', async () => {
    const report = expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from('account_label,as_of_date,balance,currency\nSavings,2026-03-31,50000,INR\n'),
        fileName: 'bank.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      }),
    );

    expect(report.unapplied ?? []).toHaveLength(0);
    const assets = await LedgerUC.assets();
    expect(assets).toHaveLength(1);
    // The template states its asset class; nothing here is inferred from the
    // file format, which is what makes manual entry safe for tax treatment.
    expect(assets[0]?.assetClass).toBe('BANK_BALANCE');
    expect(assets[0]?.lots[0]?.costPerUnit.amount).toBe('50000');
  });

  it('imports a hand loan with its terms, identified by an opaque reference', async () => {
    const header = TemplateRegistry.definitions()
      .find((template) => template.name === 'Custom_HandLoans')!
      .columns.join(',');

    expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from(
          `${header}\nRajesh Sharma,,2025-04-01,,5000000,8.0,INR${','.repeat(18)}\n`,
        ),
        fileName: 'loans.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      }),
    );

    const assets = await LedgerUC.assets();
    expect(assets[0]?.assetClass).toBe('HAND_LOAN');
    expect(assets[0]?.handLoan?.interestBasis).toBe('SIMPLE');
    expect(assets[0]?.handLoan?.principal.amount).toBe('5000000');

    // The name is kept — the register is filtered and sorted by it — but the
    // ASSET ID, which reaches snapshots and exports, stays the hash.
    expect(assets[0]?.handLoan?.borrowerName).toBe('Rajesh Sharma');
    expect(assets[0]?.assetId).not.toContain('rajesh');
    expect(assets[0]?.assetId).toMatch(/brw_[0-9a-f]{16}/);
  });
});

describe('Scenario: Rows that cannot be placed are reported, never dropped', () => {
  it('reports an unrecognised header rather than importing it as something else', async () => {
    const result = await ImportStatementUC.execute({
      file: Buffer.from('alpha,beta,gamma\n1,2,3\n'),
      fileName: 'mystery.csv',
      parser: 'TEMPLATE',
      mode: 'STRICT',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TEMPLATE_HEADER_MISMATCH');
    expect(await LedgerUC.assets()).toEqual([]);
  });
});

describe('Scenario: A locked vault refuses the import outright', () => {
  it('does not parse into a vault it cannot write to', async () => {
    await Vault.lock();
    const result = await importTradebook();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VAULT_STATE');
  });
});

describe('Scenario: The ledger is the record, held only in the vault', () => {
  it('is empty in a brand-new vault', async () => {
    expect(await AssetRepository.all()).toEqual([]);
  });
});
