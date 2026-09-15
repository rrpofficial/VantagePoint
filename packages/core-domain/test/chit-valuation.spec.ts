/**
 * US-1.12 — a chit fund's contribution to net worth.
 *
 * The register knows what a chit is worth; these check the valuation engine
 * agrees, because net worth is computed from assets and not from the register.
 * The two disagreeing is exactly the class of bug that had hand loans showing
 * ₹4,00,000 on a dashboard and ₹30,00,000 on their own tab.
 */
import { describe, it, expect } from 'vitest';
import { ValuationEngine, type Asset, type ChitFund } from '@vantagepoint/core-domain';
import { inr } from '@vantagepoint/test-kit';

const AS_OF = '2025-12-31T00:00:00+05:30';

const emi = (date: string, amount: string) => ({
  emiId: `emi_${date}`,
  date,
  amount: inr(amount),
  mode: 'BANK_TRANSFER' as const,
  paidTo: 'Sri Balaji Chits',
});

const chitFund = (overrides: Partial<ChitFund> = {}): ChitFund => ({
  assetId: 'chit_0001',
  org: 'Sri Balaji Chits',
  label: '5L / 25 months',
  targetAmount: inr('500000'),
  startDate: '2025-04-01',
  endDate: '2027-04-01',
  durationMonths: 25,
  emiType: 'CONSTANT',
  status: 'ACTIVE',
  emis: [emi('2025-04-05', '20000'), emi('2025-05-05', '20000'), emi('2025-06-05', '20000')],
  ...overrides,
});

const chitAsset = (overrides: Partial<ChitFund> = {}): Asset => ({
  assetId: overrides.assetId ?? 'chit_0001',
  assetClass: 'CHIT_FUND',
  jurisdiction: 'DOMESTIC',
  currency: 'INR',
  lots: [],
  incomeEvents: [],
  corporateActions: [],
  liquidity: 'ILLIQUID',
  chitFund: chitFund(overrides),
});

const value = (assets: readonly Asset[]) =>
  ValuationEngine.value({ assets, liabilities: [], asOf: AS_OF });

describe('US-1.12 Scenario: An active chit counts at what has been paid in', () => {
  it('values the chit at its accumulated instalments', () => {
    const result = value([chitAsset()]);

    // Three instalments of ₹20,000 — not the ₹5,00,000 the chit is named after.
    expect(result.positions[0]?.marketValue.amount).toBe('60000');
    expect(result.grossAssets.amount).toBe('60000');
  });

  it('reports it as an illiquid domestic asset', () => {
    const position = value([chitAsset()]).positions[0];

    expect(position?.assetClass).toBe('CHIT_FUND');
    expect(position?.jurisdiction).toBe('DOMESTIC');
    expect(position?.liquidity).toBe('ILLIQUID');
  });

  it('lands in the chit-fund slice of the allocation', () => {
    const result = value([chitAsset()]);

    expect(result.byAssetClass.CHIT_FUND?.amount).toBe('60000');
  });
});

describe('US-1.12 Scenario: A withdrawn chit leaves net worth entirely', () => {
  it('values a withdrawn chit at nil', () => {
    const result = value([
      chitAsset({ status: 'WITHDRAWN', withdrawnDate: '2025-07-01', withdrawnAmount: inr('420000') }),
    ]);

    // The pot taken is cash in a bank account and is counted there. Carrying the
    // ₹60,000 of instalments here as well would count the same money twice.
    expect(result.positions[0]?.marketValue.amount).toBe('0');
    expect(result.grossAssets.amount).toBe('0');
    expect(result.netWorth.amount).toBe('0');
  });

  it('removes only the withdrawn chit, leaving the others counted', () => {
    const result = value([
      chitAsset(),
      chitAsset({
        assetId: 'chit_0002',
        status: 'WITHDRAWN',
        withdrawnDate: '2025-07-01',
        withdrawnAmount: inr('420000'),
      }),
    ]);

    expect(result.grossAssets.amount).toBe('60000');
  });
});

describe('US-1.12 Scenario: The valuation date is respected', () => {
  it('counts only instalments paid by the valuation date', () => {
    const result = ValuationEngine.value({
      assets: [chitAsset()],
      liabilities: [],
      asOf: '2025-05-31T00:00:00+05:30',
    });

    // Two instalments by 31 May; the June one has not been paid yet.
    expect(result.positions[0]?.marketValue.amount).toBe('40000');
  });

  it('values a chit with no instalments yet at nil rather than failing', () => {
    const result = value([chitAsset({ emis: [] })]);

    expect(result.positions[0]?.marketValue.amount).toBe('0');
  });
});
