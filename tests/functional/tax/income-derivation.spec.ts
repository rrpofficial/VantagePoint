/**
 * FUNCTIONAL — other-sources income derived from the ledger (Phase 2, objective 7).
 *
 * `OtherSourcesAggregator` was written, unit-tested, and had **zero callers**.
 * `IncomeLedger.recordDividend` / `recordInterest` likewise: the `income_events`
 * table existed and was read, and nothing in the application ever wrote to it.
 *
 * So the only route into a tax figure was `IncomeProfile.otherSourcesIncome` — a
 * number the user types. A dividend recorded against a holding reached nothing;
 * interest accruing on a hand loan reached nothing.
 *
 * What these pin:
 *   - a recorded receipt reaches the advance-tax instalment;
 *   - the typed figure is COMPOSED with the derived one, never replaced by it;
 *   - hand-loan interest is the year's accrual, not the loan's lifetime;
 *   - what the user switched off is excluded AND reported, never silently gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputeAdvanceTaxUC,
  EditModeUC,
  IncomeUC,
  LedgerUC,
  LoanUC,
  TradeUC,
  VaultUC,
  resetPorts,
  saveIncomeInclusions,
  saveIncomeProfile,
  setIncomeProfile,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const FY = '2025-26';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const saveProfile = async (otherSources = '0'): Promise<void> => {
  expectOk(
    await saveIncomeProfile({
      financialYear: FY,
      assessmentYear: '2026-27',
      grossSalary: inr('2500000'),
      exemptAllowances: inr('0'),
      chapterViaDeductions: inr('0'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr(otherSources),
      tdsRemitted: inr('0'),
      tcsCollected: inr('0'),
    }),
  );
};

/** A holding to hang a dividend on. */
const holding = async (): Promise<string> => {
  const trade = expectOk(
    await TradeUC.record({
      assetClass: 'DOMESTIC_EQUITY',
      side: 'BUY',
      tradeDate: '2025-04-10',
      symbol: 'ACME',
      quantity: '1000',
      pricePerUnit: inr('100'),
    }),
  );
  return trade.assetId;
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-income-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
  await saveProfile();
});

afterEach(async () => {
  setIncomeProfile(undefined);
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

describe('Scenario: A recorded receipt reaches the tax computation', () => {
  it('records a dividend against the holding that produced it', async () => {
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'DIVIDEND',
        date: '2025-08-12',
        grossAmount: '45,000',
        taxWithheld: '4,500',
      }),
    );

    const assets = await LedgerUC.assets();
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    expect(asset?.incomeEvents).toHaveLength(1);
    expect(asset?.incomeEvents[0]?.grossAmount.amount).toBe('45000');
  });

  /** The gap this phase closes: the aggregator finally has something to sum. */
  it('carries it into derived other-sources income', async () => {
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'DIVIDEND',
        date: '2025-08-12',
        grossAmount: '45000',
      }),
    );

    const derived = expectOk(await IncomeUC.forYear(FY));
    expect(Number(derived.derived.amount)).toBeCloseTo(45_000, 0);
    expect(derived.items.map((item) => item.ruleRef)).toContain(
      'incomeTaxAct.section56.otherSources',
    );
  });

  it('raises the advance-tax instalment, which it previously did not', async () => {
    const assetId = await holding();
    const before = expectOk(
      await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }),
    );

    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'DIVIDEND',
        date: '2025-08-12',
        grossAmount: '500000',
      }),
    );

    const after = expectOk(
      await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }),
    );
    expect(Number(after.netPayable.amount)).toBeGreaterThan(Number(before.netPayable.amount));
  });

  /** A receipt in another year is not this year's income. */
  it('ignores a receipt dated outside the financial year', async () => {
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'DIVIDEND',
        date: '2026-08-12',
        grossAmount: '45000',
      }),
    );

    expect(Number(expectOk(await IncomeUC.forYear(FY)).derived.amount)).toBe(0);
  });

  it('records interest as well as dividends', async () => {
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'INTEREST',
        date: '2025-09-30',
        grossAmount: '12000',
      }),
    );

    expect(Number(expectOk(await IncomeUC.forYear(FY)).derived.amount)).toBeCloseTo(12_000, 0);
  });
});

describe('Scenario: The typed figure is composed, not replaced', () => {
  /*
   * A user has income this ledger does not know about — a savings account nobody
   * imported. Substituting the derived figure for theirs would silently drop it.
   */
  it('adds the derived figure to the one entered manually', async () => {
    await saveProfile('30000');
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({
        assetId,
        kind: 'DIVIDEND',
        date: '2025-08-12',
        grossAmount: '45000',
      }),
    );

    const derived = expectOk(await IncomeUC.forYear(FY));
    expect(Number(derived.manual.amount)).toBeCloseTo(30_000, 0);
    expect(Number(derived.derived.amount)).toBeCloseTo(45_000, 0);
    expect(Number(derived.total.amount)).toBeCloseTo(75_000, 0);
  });

  /** Both appear in the trace, so a double-counted receipt is visible. */
  it('names the manual entry as its own line', async () => {
    await saveProfile('30000');
    const derived = expectOk(await IncomeUC.forYear(FY));

    expect(derived.items.map((item) => item.label)).toContain(
      'Entered manually in the income profile',
    );
  });
});

describe('Scenario: Hand-loan interest is the YEAR’s accrual', () => {
  const lend = async () => {
    expectOk(
      await LoanUC.record({
        borrowerName: 'A Borrower',
        principal: inr('1000000'),
        interestRatePct: '12',
        loanDate: '2024-04-01',
      }),
    );
  };

  /*
   * `handLoanAccruedInterest` is cumulative from the loan's start. Using the
   * closing figure would tax the whole life of the loan in EVERY year it is
   * open — an error that grows with the age of the loan and never corrects.
   */
  it('counts one year of interest on a loan two years old, not two', async () => {
    expectOk(await saveIncomeInclusions({ handLoanInterest: true, chitFundReturns: false, sellToCoverGains: false }));
    await lend();

    const derived = expectOk(await IncomeUC.forYear(FY));
    // ₹10,00,000 at 12% for FY 2025-26 alone = ₹1,20,000, not ₹2,40,000.
    expect(Number(derived.derived.amount)).toBeCloseTo(120_000, -2);
  });

  it('is excluded by default, because it is a position the taxpayer takes', async () => {
    await lend();

    const derived = expectOk(await IncomeUC.forYear(FY));
    expect(Number(derived.derived.amount)).toBe(0);
  });

  /*
   * Excluded is not the same as invisible. A user who recorded the loan and sees
   * no interest in the figure needs to know it is a setting, not a bug — and how
   * large the choice is.
   */
  it('reports what it excluded, and why, with the amount', async () => {
    await lend();

    const derived = expectOk(await IncomeUC.forYear(FY));
    expect(derived.excluded).toHaveLength(1);
    expect(derived.excluded[0]?.label).toContain('Hand loan interest');
    expect(derived.excluded[0]?.reason).toContain('switched off');
    expect(Number(derived.excluded[0]?.amount.amount)).toBeCloseTo(120_000, -2);
  });

  it('stops excluding it once the setting is switched on', async () => {
    await lend();
    expect(expectOk(await IncomeUC.forYear(FY)).excluded).toHaveLength(1);

    expectOk(await saveIncomeInclusions({ handLoanInterest: true, chitFundReturns: false, sellToCoverGains: false }));
    expect(expectOk(await IncomeUC.forYear(FY)).excluded).toHaveLength(0);
  });
});

describe('Scenario: Input that would corrupt the ledger is refused', () => {
  it('refuses a receipt against a holding that does not exist', async () => {
    expectErr(
      await IncomeUC.record({
        assetId: 'ast_nonexistent',
        kind: 'DIVIDEND',
        date: '2025-08-12',
        grossAmount: '1000',
      }),
      'VAULT_STATE',
    );
  });

  it('refuses a date that is not ISO', async () => {
    const assetId = await holding();
    expectErr(
      await IncomeUC.record({ assetId, kind: 'DIVIDEND', date: '12-08-2025', grossAmount: '1000' }),
      'VAULT_STATE',
    );
  });

  it('refuses an amount of zero', async () => {
    const assetId = await holding();
    expectErr(
      await IncomeUC.record({ assetId, kind: 'DIVIDEND', date: '2025-08-12', grossAmount: '0' }),
      'VAULT_STATE',
    );
  });

  /*
   * The asset aggregate replaces its children wholesale on save, so a second
   * receipt must carry the first forward. A bare append would drop it.
   */
  it('keeps earlier receipts when a later one is recorded', async () => {
    const assetId = await holding();
    expectOk(
      await IncomeUC.record({ assetId, kind: 'DIVIDEND', date: '2025-06-01', grossAmount: '10000' }),
    );
    expectOk(
      await IncomeUC.record({ assetId, kind: 'DIVIDEND', date: '2025-09-01', grossAmount: '15000' }),
    );

    expect(Number(expectOk(await IncomeUC.forYear(FY)).derived.amount)).toBeCloseTo(25_000, 0);
  });
});
