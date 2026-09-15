/**
 * FUNCTIONAL — advance tax computed from the ledger (US-5.10, objective 6).
 *
 * The engine was always right; nothing reached it. `ComputeAdvanceTaxUC` passed
 * `exits: []`, `assetClasses: {}` and `alreadyPaid: 0` as literals, so every
 * instalment was salary-only and no disposal a user recorded ever changed a
 * figure. These pin the wiring, not the arithmetic.
 *
 * Four properties, each of which was absent:
 *   - a realised gain raises the instalment;
 *   - a gain realised AFTER the quarter's due date does not;
 *   - a payment already made reduces the next quarter instead of being re-demanded;
 *   - a gain with no exchange rate is REPORTED, never silently dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputeAdvanceTaxUC,
  EditModeUC,
  RatesUC,
  TradeUC,
  VaultUC,
  resetPorts,
  saveIncomeProfile,
  setIncomeProfile,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const FY = '2025-26';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const rateRow = (stamp: string, ttBuy: string) =>
  `${stamp},https://example.invalid/x.pdf,${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-advance-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));

  // A salary, so gains land on a real marginal rate rather than on nothing.
  expectOk(
    await saveIncomeProfile({
      financialYear: FY,
      assessmentYear: '2026-27',
      grossSalary: inr('2500000'),
      exemptAllowances: inr('0'),
      chapterViaDeductions: inr('0'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr('0'),
      tdsRemitted: inr('0'),
      tcsCollected: inr('0'),
    }),
  );
});

afterEach(async () => {
  setIncomeProfile(undefined);
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

/** A domestic buy and sell, both inside FY 2025-26, realising a gain. */
const realiseGain = async (sellDate: string) => {
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
      tradeDate: sellDate,
      symbol: 'ACME',
      quantity: '1000',
      pricePerUnit: inr('300'),
    }),
  );
};

describe('Scenario: A realised gain reaches the instalment', () => {
  it('raises the demand when a sale is recorded', async () => {
    const before = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }));

    // ₹2,00,000 of short-term gain on listed equity.
    await realiseGain('2025-06-15');

    const after = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }));

    expect(Number(after.netPayable.amount)).toBeGreaterThan(Number(before.netPayable.amount));
    expect(after.capitalGains?.gains).toHaveLength(1);
  });

  /*
   * Only gains realised BY the due date are in scope. Demanding tax in the
   * 15-June instalment on a sale made in December asks for tax on income the
   * taxpayer had not yet earned.
   */
  it('ignores a gain realised after the quarter’s due date', async () => {
    await realiseGain('2025-12-20');

    const q1 = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q1' }));
    const q4 = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }));

    expect(q1.capitalGains?.gains ?? []).toHaveLength(0);
    expect(q4.capitalGains?.gains).toHaveLength(1);
  });

  /** A disposal in another year is not this year's business. */
  it('ignores a disposal from a different financial year', async () => {
    await realiseGain('2025-06-15');

    const other = expectOk(
      await ComputeAdvanceTaxUC.execute({ financialYear: '2024-25', quarter: 'Q4' }),
    );

    expect(other.capitalGains?.gains ?? []).toHaveLength(0);
  });
});

describe('Scenario: Tax already paid is credited, not re-demanded', () => {
  it('reduces the demand by a recorded payment', async () => {
    await realiseGain('2025-06-15');
    const before = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }));

    expectOk(
      await ComputeAdvanceTaxUC.recordPayment({
        financialYear: FY,
        quarter: 'Q1',
        amount: '50000',
        paidOn: '2025-06-14',
        challanRef: 'CHLN-001',
      }),
    );

    const after = expectOk(await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }));

    expect(Number(before.netPayable.amount) - Number(after.netPayable.amount)).toBeCloseTo(50_000, 0);
    expect(Number(after.alreadyPaid.amount)).toBe(50_000);
  });

  it('accepts an Indian-format amount, as the form allows', async () => {
    const payment = expectOk(
      await ComputeAdvanceTaxUC.recordPayment({
        financialYear: FY,
        quarter: 'Q2',
        amount: '1,00,000',
        paidOn: '2025-09-14',
      }),
    );

    expect(payment.amount.amount).toBe('100000');
  });

  it('refuses a payment that is not a number, rather than storing it', async () => {
    expectErr(
      await ComputeAdvanceTaxUC.recordPayment({
        financialYear: FY,
        quarter: 'Q2',
        amount: 'later',
        paidOn: '2025-09-14',
      }),
      'INVALID_AMOUNT',
    );
  });

  it('refuses a payment with no date', async () => {
    expectErr(
      await ComputeAdvanceTaxUC.recordPayment({
        financialYear: FY,
        quarter: 'Q2',
        amount: '1000',
        paidOn: '',
      }),
      'VAULT_STATE',
    );
  });

  /*
   * Deleting a payment RAISES every later instalment, so it is gated. Recording
   * one is not: a challan that exists can only make the demand more accurate.
   */
  it('gates deleting a payment behind edit mode', async () => {
    const payment = expectOk(
      await ComputeAdvanceTaxUC.recordPayment({
        financialYear: FY,
        quarter: 'Q1',
        amount: '1000',
        paidOn: '2025-06-14',
      }),
    );
    EditModeUC.disable();

    expectErr(await ComputeAdvanceTaxUC.deletePayment(payment.paymentId), 'EDIT_MODE_REQUIRED');
    expect(await ComputeAdvanceTaxUC.payments(FY)).toHaveLength(1);
  });
});

describe('Scenario: A gain with no exchange rate is reported, never dropped', () => {
  /*
   * The failure mode this guards. A foreign disposal with no Rule 115 rate is
   * EXCLUDED from the totals — the alternative, passing the dollar figure
   * through as rupees, understates the tax by about 99%. Excluded silently it
   * would be just as wrong, so the instalment has to carry the omission.
   */
  it('leaves an unconvertible disposal out and names it', async () => {
    // A rate for the BUY month only, so the sale month cannot resolve.
    expectOk(
      await RatesUC.importArchive({
        csv: [HEADER, rateRow('2025-03-31 09:00', '83.50')].join('\n'),
        currency: 'USD',
        documentRef: 'test',
      }),
    );

    expectOk(
      await TradeUC.record({
        assetClass: 'FOREIGN_EQUITY',
        side: 'BUY',
        tradeDate: '2025-04-10',
        symbol: 'FRGN',
        quantity: '100',
        pricePerUnit: { amount: '50', currency: 'USD' },
      }),
    );
    expectOk(
      await TradeUC.record({
        assetClass: 'FOREIGN_EQUITY',
        side: 'SELL',
        tradeDate: '2025-11-20',
        symbol: 'FRGN',
        quantity: '100',
        pricePerUnit: { amount: '90', currency: 'USD' },
      }),
    );

    const result = expectOk(
      await ComputeAdvanceTaxUC.execute({ financialYear: FY, quarter: 'Q4' }),
    );

    expect(result.capitalGains?.unconvertible ?? []).toHaveLength(1);
    expect(result.capitalGains?.unconvertible[0]?.currency).toBe('USD');
    // And it is NOT in the totals: $4,000 of gain must not appear as ₹4,000.
    expect(result.capitalGains?.gains ?? []).toHaveLength(0);
  });
});
