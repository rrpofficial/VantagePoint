/**
 * FUNCTIONAL — the ₹50 lakh tests run on TOTAL income, not on salary.
 *
 * `hniStatus` and `scheduleAl` both passed `profile.grossSalary` as
 * `totalIncome`. A taxpayer on ₹40 lakh salary who realised ₹20 lakh of capital
 * gain was therefore told they were below the threshold and that Schedule AL was
 * not required — an omitted disclosure, which is the expensive direction for
 * this particular mistake.
 *
 * Section 2(45) of the 1961 Act (section 2(103) of the 2025 Act) defines total
 * income as the total amount of income computed under ALL five heads, so the
 * house property, other sources and capital gains heads belong in the test
 * alongside salary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputeAdvanceTaxUC,
  EditModeUC,
  TradeUC,
  VaultUC,
  resetPorts,
  saveIncomeProfile,
  setIncomeProfile,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const FY = '2025-26';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

/** Comfortably under the ₹50,00,000 threshold on its own. */
const SALARY = '4000000';

const saveProfile = async (
  overrides: Partial<Record<string, { amount: string; currency: 'INR' }>> = {},
): Promise<void> => {
  expectOk(
    await saveIncomeProfile({
      financialYear: FY,
      assessmentYear: '2026-27',
      grossSalary: inr(SALARY),
      exemptAllowances: inr('0'),
      chapterViaDeductions: inr('0'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr('0'),
      tdsRemitted: inr('0'),
      tcsCollected: inr('0'),
      ...overrides,
    }),
  );
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-hni-'));
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

/** ₹20,00,000 of short-term gain on listed equity, realised inside FY 2025-26. */
const realiseGain = async () => {
  expectOk(
    await TradeUC.record({
      assetClass: 'DOMESTIC_EQUITY',
      side: 'BUY',
      tradeDate: '2025-04-10',
      symbol: 'ACME',
      quantity: '1000',
      pricePerUnit: inr('100'),
    }),
  );
  expectOk(
    await TradeUC.record({
      assetClass: 'DOMESTIC_EQUITY',
      side: 'SELL',
      tradeDate: '2025-06-15',
      symbol: 'ACME',
      quantity: '1000',
      pricePerUnit: inr('2100'),
    }),
  );
};

describe('Scenario: Capital gains count towards the HNI threshold', () => {
  it('leaves a salary-only taxpayer below it', async () => {
    const status = expectOk(await ComputeAdvanceTaxUC.hniStatus(FY));

    expect(status.isHni).toBe(false);
    expect(status.scheduleAlRequired).toBe(false);
  });

  it('crosses it once a gain is realised, though salary has not moved', async () => {
    await realiseGain();

    const status = expectOk(await ComputeAdvanceTaxUC.hniStatus(FY));

    expect(status.isHni).toBe(true);
    expect(status.reason).toBe('INCOME_ABOVE_50L');
    // The disclosure this bug suppressed.
    expect(status.scheduleAlRequired).toBe(true);
  });

  /*
   * A gain in ANOTHER year must not pull this year over the line — the helper
   * reads the same FY-scoped ledger the advance tax computation does.
   */
  it('does not carry the gain into a different financial year', async () => {
    await realiseGain();

    const status = expectOk(await ComputeAdvanceTaxUC.hniStatus('2024-25'));

    expect(status.isHni).toBe(false);
  });
});

describe('Scenario: The other heads of income count too', () => {
  it('counts house property and other sources, not salary alone', async () => {
    await saveProfile({
      housePropertyIncome: inr('700000'),
      otherSourcesIncome: inr('400000'),
    });

    const status = expectOk(await ComputeAdvanceTaxUC.hniStatus(FY));

    // 40,00,000 + 7,00,000 + 4,00,000 = 51,00,000.
    expect(status.isHni).toBe(true);
    expect(status.scheduleAlRequired).toBe(true);
  });
});
