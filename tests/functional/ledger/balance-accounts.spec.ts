/**
 * FUNCTIONAL — Phase 5: balance-type assets and live accruals (objectives 1, 4).
 *
 * The acceptance criterion is one sentence: **enter a fixed deposit; its value
 * grows between two valuations without any trade being recorded.** That had been
 * impossible since US-1.8 — `depositAccruedValue`, `recurringContributions`,
 * `epfProjection` and `gratuity` were all written, unit-tested and unreachable,
 * because nothing could enter an asset for them to run on.
 *
 * The risk register also asks for a golden-value guard on the valuer registry
 * (D-3), since it rewrote the dispatch every net-worth figure passes through.
 * That is the last scenario here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BalanceUC,
  EditModeUC,
  ImportStatementUC,
  IncomeUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { saveIncomeProfile } from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const at = (date: string) => `${date}T00:00:00+00:00`;
const netWorthAt = async (date: string): Promise<number> =>
  Number(expectOk(await ValuePortfolioUC.execute(at(date))).netWorth.amount);

beforeEach(async () => {
  resetPorts();
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-balances-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
});

describe('Phase 5 Scenario: A fixed deposit grows without a trade being recorded', () => {
  it('is worth more a year on than the day it was booked', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'HDFC FD 7.1%',
        institutionName: 'HDFC Bank',
        openingBalance: '5,00,000',
        openedOn: '2025-04-01',
        annualRatePct: '7.1',
        compounding: 'QUARTERLY',
      }),
    );

    const atOpening = await netWorthAt('2025-04-01');
    const aYearOn = await netWorthAt('2026-03-31');

    expect(atOpening).toBe(500_000);
    // No trade, no import, no price feed — only the clock moving.
    expect(aYearOn).toBeGreaterThan(atOpening);
    // ₹5,00,000 × (1 + 0.071/4)⁴ — four whole quarters on a 30/360 year.
    expect(aYearOn).toBeCloseTo(536_456.42, 2);
  });

  it('stops accruing at maturity rather than compounding indefinitely', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'Matured FD',
        openingBalance: '100000',
        openedOn: '2024-04-01',
        maturityDate: '2025-04-01',
        annualRatePct: '8',
        compounding: 'ANNUAL',
      }),
    );

    const atMaturity = await netWorthAt('2025-04-01');
    const threeYearsLater = await netWorthAt('2028-04-01');

    expect(atMaturity).toBe(108_000);
    expect(threeYearsLater).toBe(atMaturity);
  });

  it('prefers the certificate’s maturity amount once the deposit has matured', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'Bank-stated FD',
        openingBalance: '100000',
        openedOn: '2024-04-01',
        maturityDate: '2025-04-01',
        maturityValue: '108250',
        annualRatePct: '8',
        compounding: 'ANNUAL',
      }),
    );

    // Before maturity the computed figure governs; applying the maturity amount
    // early would report a full term's interest on day one.
    expect(await netWorthAt('2024-10-01')).toBeLessThan(108_250);
    expect(await netWorthAt('2025-04-01')).toBe(108_250);
  });

  it('carries a balance with no stated rate FLAT, and says why', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'Rate not to hand',
        openingBalance: '250000',
        openedOn: '2025-04-01',
      }),
    );

    expect(await netWorthAt('2030-04-01')).toBe(250_000);

    const register = expectOk(await BalanceUC.register('2030-04-01'));
    // Never invented. A plausible 7% here would put a fabricated return into net
    // worth and, through the other-sources derivation, into a tax figure.
    expect(register.accounts[0]?.flatReason).toContain('no interest rate was recorded');
  });
});

describe('Phase 5 Scenario: Each balance kind uses the arithmetic it should', () => {
  it('compounds a recurring deposit per instalment, not on the whole sum at once', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'RECURRING_DEPOSIT',
        label: 'SBI RD',
        openingBalance: '0',
        openedOn: '2025-04-01',
        monthlyContribution: '10000',
        annualRatePct: '7',
        compounding: 'QUARTERLY',
      }),
    );

    const register = expectOk(await BalanceUC.register('2026-03-31'));
    const view = register.accounts[0];

    // Twelve instalments, inclusive of the opening month.
    expect(view?.instalmentsPaid).toBe(12);
    expect(view?.contributed.amount).toBe('120000');
    expect(Number(view?.accruedInterest.amount)).toBeGreaterThan(0);
    /*
     * The guard against compounding the whole ₹1,20,000 from April. A single
     * compounding would credit the March instalment with a year of interest;
     * the honest figure is closer to half a year's on the average balance.
     */
    expect(Number(view?.accruedInterest.amount)).toBeLessThan(120_000 * 0.07 * 0.75);
  });

  it('runs provident fund interest on the running balance, not the opening one', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'EPF',
        label: 'EPF — Acme',
        openingBalance: '1000000',
        openedOn: '2025-04-01',
        monthlyContribution: '15000',
        employerContribution: '15000',
        annualRatePct: '8.25',
      }),
    );

    const view = expectOk(await BalanceUC.register('2026-03-31')).accounts[0];

    /*
     * ELEVEN contributions, not twelve: the balance is stated as at 1 April, so
     * April's contribution is already inside it and May through March follow.
     * Counting the opening month again is a day-one overstatement.
     */
    expect(view?.contributed.amount).toBe('1330000');
    // Flat 8.25% on the ₹10,00,000 opening balance would be ₹82,500. Interest on
    // the running balance is materially more, which is the distinction
    // `epfProjection` exists to make.
    expect(Number(view?.accruedInterest.amount)).toBeGreaterThan(82_500);
  });

  it('pays no gratuity below five completed years, and grows with service', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'GRATUITY',
        label: 'Gratuity — Acme',
        openingBalance: '0',
        openedOn: '2021-06-01',
        lastDrawnMonthly: '200000',
      }),
    );

    const atFour = expectOk(await BalanceUC.register('2025-05-31')).accounts[0];
    const atFive = expectOk(await BalanceUC.register('2026-06-01')).accounts[0];

    expect(atFour?.value.amount).toBe('0');
    expect(atFour?.flatReason).toContain('five completed years');
    // 15/26 × ₹2,00,000 × 5 completed years.
    expect(atFive?.value.amount).toBe('576923.08');
    /*
     * Cost basis equals the entitlement, so nothing shows as a gain. Gratuity is
     * earned rather than bought, and it is exempt under s.10(10) besides.
     */
    expect(atFive?.accruedInterest.amount).toBe('0');
  });

  it('leaves a stated balance where it was put, and explains that it will not move', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'NPS_TIER_I',
        label: 'NPS Tier I',
        openingBalance: '850000',
        openedOn: '2026-03-31',
      }),
    );

    expect(await netWorthAt('2027-03-31')).toBe(850_000);
    expect(expectOk(await BalanceUC.register()).accounts[0]?.flatReason).toContain(
      'only when you restate it',
    );
  });

  it('drops a closed account to nil, so the proceeds are not counted twice', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'Withdrawn FD',
        openingBalance: '300000',
        openedOn: '2025-04-01',
        annualRatePct: '7',
      }),
    );
    expectOk(await EditModeUC.enable(PASSPHRASE));
    const accounts = expectOk(await BalanceUC.register()).accounts;
    expectOk(await BalanceUC.close(accounts[0]?.account.assetId ?? '', '2026-04-01'));

    expect(await netWorthAt('2026-03-31')).toBeGreaterThan(300_000);
    expect(await netWorthAt('2026-04-01')).toBe(0);
  });
});

describe('Phase 5 Scenario: Restating a balance moves the accrual start with it', () => {
  it('does not re-accrue interest that is already inside the new figure', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'PPF',
        label: 'PPF',
        openingBalance: '500000',
        openedOn: '2025-04-01',
        annualRatePct: '7.1',
      }),
    );
    expectOk(await EditModeUC.enable(PASSPHRASE));
    const assetId = expectOk(await BalanceUC.register()).accounts[0]?.account.assetId ?? '';

    const restated = expectOk(
      await BalanceUC.restate({ assetId, openingBalance: '600000', asOf: '2026-04-01' }),
    );

    expect(restated.account.openingBalance.amount).toBe('600000');
    expect(restated.account.openedOn).toBe('2026-04-01');
    // Valued ON the restatement date it is exactly the stated figure — no
    // interest carried over from the superseded start.
    expect(expectOk(await BalanceUC.register('2026-04-01')).accounts[0]?.value.amount).toBe(
      '600000',
    );
  });

  it('refuses a restatement while edit mode is off', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'BANK_BALANCE',
        label: 'Salary account',
        openingBalance: '120000',
        openedOn: '2026-03-31',
      }),
    );
    const assetId = expectOk(await BalanceUC.register()).accounts[0]?.account.assetId ?? '';

    const result = await BalanceUC.restate({
      assetId,
      openingBalance: '999999',
      asOf: '2026-04-01',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EDIT_MODE_REQUIRED');
  });

  /*
   * Adding is ungated everywhere in this application; re-adding an account that
   * already exists is not adding, it is overwriting. Without this the additive
   * door would be a way to rewrite any balance with edit mode off.
   */
  it('refuses to overwrite an existing account through the additive path', async () => {
    const entry = {
      assetClass: 'FIXED_DEPOSIT' as const,
      label: 'HDFC FD',
      openingBalance: '100000',
      openedOn: '2025-04-01',
    };
    expectOk(await BalanceUC.record(entry));

    const again = await BalanceUC.record({ ...entry, openingBalance: '900000' });

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('EDIT_MODE_REQUIRED');
    expect(await netWorthAt('2025-04-01')).toBe(100_000);
  });
});

describe('Phase 5 Scenario: Input that would record a meaningless balance is refused', () => {
  it('refuses a gratuity entitlement with no wage to compute it from', async () => {
    const result = await BalanceUC.record({
      assetClass: 'GRATUITY',
      label: 'Gratuity',
      openingBalance: '0',
      openedOn: '2020-01-01',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a recurring deposit with no instalment', async () => {
    const result = await BalanceUC.record({
      assetClass: 'RECURRING_DEPOSIT',
      label: 'RD',
      openingBalance: '0',
      openedOn: '2025-04-01',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a class that is a trade rather than a balance', async () => {
    const result = await BalanceUC.record({
      assetClass: 'GOLD_PHYSICAL',
      label: 'Coins',
      openingBalance: '100000',
      openedOn: '2025-04-01',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('record it as a trade');
  });

  it('never stores the account number, only an opaque reference', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'BANK_BALANCE',
        label: 'Salary account',
        openingBalance: '120000',
        openedOn: '2026-03-31',
        accountNumber: '50100234567890',
      }),
    );

    const account = expectOk(await BalanceUC.register()).accounts[0]?.account;
    expect(account?.accountRef).toMatch(/^acct_[0-9a-f]{16}$/);
    expect(JSON.stringify(account)).not.toContain('50100234567890');
  });
});

/**
 * The import half of objective 1. `ingestion` cannot depend on `app-services`,
 * so the asset-class → arithmetic table exists in both — and a class added to
 * one and not the other would import as a flat balance with no error at all.
 *
 * Asserted behaviourally rather than by comparing the two tables, so this also
 * covers the template header, the parser and the projector attaching the bag.
 */
describe('Phase 5 Scenario: Every balance class the form offers also imports', () => {
  const HEADER =
    'asset_class,account_label,institution,account_number,balance,true_as_at,' +
    'interest_rate_pct,compounding,monthly_contribution,employer_contribution,' +
    'maturity_date,maturity_amount,last_drawn_monthly,closed_on,notes,currency';

  it('imports a row for each, with the arithmetic the form would have used', async () => {
    const classes = expectOk(await BalanceUC.classes());
    expect(classes.length).toBeGreaterThan(0);

    const rows = classes.map((entry, index) =>
      [
        entry.assetClass,
        `${entry.assetClass} account`,
        'A Bank',
        '',
        '100000',
        // Distinct dates keep ten rows as ten assets rather than one.
        `2025-04-0${String((index % 9) + 1)}`,
        '7',
        'QUARTERLY',
        '1000',
        '1000',
        '',
        '',
        '50000',
        '',
        '',
        'INR',
      ].join(','),
    );

    const report = expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from([HEADER, ...rows].join('\n'), 'utf8'),
        fileName: 'balances.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
        templateName: 'Custom_Balances',
      }),
    );
    expect(report.rejected, JSON.stringify(report.errors)).toBe(0);
    expect(report.created).toBe(classes.length);

    const imported = expectOk(await BalanceUC.register('2025-04-01')).accounts;
    for (const entry of classes) {
      const view = imported.find((row) => row.account.label === `${entry.assetClass} account`);
      expect(view, `${entry.assetClass} did not import`).toBeDefined();
      expect(view?.account.kind, `${entry.assetClass} imported as the wrong kind`).toBe(entry.kind);
    }
  });
});

describe('Phase 5 Scenario: Deposit interest reaches the tax figure', () => {
  /** `IncomeUC.forYear` composes the ledger with the profile's typed figure. */
  const withProfile = async (): Promise<void> => {
    expectOk(
      await saveIncomeProfile({
        financialYear: '2025-26',
        assessmentYear: '2026-27',
        grossSalary: inr('2000000'),
        exemptAllowances: inr('0'),
        chapterViaDeductions: inr('0'),
        housePropertyIncome: inr('0'),
        otherSourcesIncome: inr('0'),
        tdsRemitted: inr('0'),
        tcsCollected: inr('0'),
      }),
    );
  };

  it('counts fixed-deposit interest as income from other sources', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'HDFC FD',
        openingBalance: '1000000',
        openedOn: '2025-04-01',
        annualRatePct: '7',
        compounding: 'ANNUAL',
      }),
    );

    await withProfile();
    const derived = expectOk(await IncomeUC.forYear('2025-26'));

    // Unconditional: interest on a deposit is chargeable whether or not it has
    // been withdrawn, so there is no position for a setting to express.
    expect(Number(derived.derived.amount)).toBeGreaterThan(0);
    expect(derived.items.some((line) => line.label.includes('HDFC FD'))).toBe(true);
  });

  it('reports provident fund interest as excluded, with the reason, rather than taxing it', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'EPF',
        label: 'EPF — Acme',
        openingBalance: '2000000',
        openedOn: '2025-04-01',
        annualRatePct: '8.25',
      }),
    );

    await withProfile();
    const derived = expectOk(await IncomeUC.forYear('2025-26'));

    expect(derived.derived.amount).toBe('0');
    const excluded = derived.excluded.find((row) => row.label.includes('Provident fund'));
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toContain('s.10(11)/(12)');
    // Stated, so the size of what is being left out is visible.
    expect(Number(excluded?.amount.amount)).toBeGreaterThan(0);
  });

  it('counts only the YEAR’s accrual, not the whole life of the deposit', async () => {
    expectOk(
      await BalanceUC.record({
        assetClass: 'FIXED_DEPOSIT',
        label: 'Old FD',
        openingBalance: '1000000',
        openedOn: '2021-04-01',
        annualRatePct: '7',
        compounding: 'ANNUAL',
      }),
    );

    await withProfile();
    const derived = expectOk(await IncomeUC.forYear('2025-26'));

    /*
     * Four years of accrual sit inside this deposit by the start of FY 2025-26.
     * A cumulative figure would tax all of it again every year — an error that
     * grows with the age of the deposit and never corrects itself.
     */
    expect(Number(derived.derived.amount)).toBeLessThan(200_000);
    expect(Number(derived.derived.amount)).toBeGreaterThan(0);
  });
});

/**
 * D-3's golden-value guard, from the risk register: "Valuer registry changes a
 * net-worth figure → golden-value test on the existing fixture before and after."
 *
 * The registry replaced the `if/else if` chain that every net-worth figure passes
 * through, so a holding whose valuation is NOT a balance must come out at exactly
 * the figure it did before.
 */
describe('Phase 5 Scenario: The valuer registry does not move an existing figure', () => {
  it('values an ordinary equity holding at cost, exactly as the chain did', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-06-02',
        symbol: 'INFY',
        quantity: '100',
        pricePerUnit: inr('1500'),
        fees: inr('120'),
      }),
    );

    // Cost basis including charges — no price feed, so cost governs, which is
    // the conservative default the registry's fallback preserves.
    expect(await netWorthAt('2026-03-31')).toBe(150_120);
  });

  it('leaves an asset class with no valuer on the market-else-cost default', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'GOLD_PHYSICAL',
        side: 'BUY',
        tradeDate: '2025-06-02',
        symbol: 'Gold 24k',
        quantity: '50',
        pricePerUnit: inr('7000'),
      }),
    );

    expect(await netWorthAt('2026-03-31')).toBe(350_000);
  });
});
