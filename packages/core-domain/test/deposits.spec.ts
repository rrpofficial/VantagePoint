/**
 * US-1.9  — Fixed and recurring deposits with accrued interest (PRD FR-1.1)
 * US-1.12 — Custom family savings / chit schemes
 * US-1.13 — Cash in hand and bank balances
 */
import { describe, it, expect } from 'vitest';
import { AccrualEngine, AssetRegistry } from '@vantagepoint/core-domain';
import { expectMoney, inr } from '@vantagepoint/test-kit';

describe('US-1.9 deposits', () => {
  describe('Scenario: FD accrues quarterly compounded interest to the valuation date', () => {
    const input = {
      principal: inr('1000000'),
      annualRatePct: '7.2',
      compounding: 'QUARTERLY' as const,
      startDate: '2025-04-01',
      asOf: '2026-03-31',
    };

    // ₹1,000,000 × (1 + 0.072/4)^4 = ₹1,000,000 × 1.018^4 = ₹1,073,967.43.
    // The original expectation of ₹1,073,970.86 was an arithmetic slip when the
    // test was authored; 1.018^4 = 1.073967432976.
    it('reaches an accrued value of ₹1,073,967.43', () => {
      expectMoney(AccrualEngine.depositAccruedValue(input).value, inr('1073967.43'));
    });

    it('reports ₹73,967.43 of accrued interest for FY 2025-26', () => {
      expectMoney(AccrualEngine.depositAccruedValue(input).accruedInterest, inr('73967.43'));
    });

    it('accrues more than simple interest at the same rate', () => {
      const { accruedInterest } = AccrualEngine.depositAccruedValue(input);
      expect(Number(accruedInterest.amount)).toBeGreaterThan(1000000 * 0.072);
    });
  });
});

describe('US-1.12 chit / family savings schemes', () => {
  describe('Scenario: Chit scheme tracks contributions paid and expected payout', () => {
    it('registers a CHIT_FUND as a domestic asset', () => {
      expect(AssetRegistry.jurisdictionOf('CHIT_FUND')).toBe('DOMESTIC');
    });

    it('totals ₹750,000 of contributions after 15 monthly instalments of ₹50,000', () => {
      const paid = AccrualEngine.recurringContributions({
        instalment: inr('50000'),
        startDate: '2025-01-01',
        asOf: '2026-03-31',
      });
      expectMoney(paid.contributions, inr('750000'));
      expect(paid.instalmentsPaid).toBe(15);
    });

    it('counts no instalment before the scheme starts', () => {
      const paid = AccrualEngine.recurringContributions({
        instalment: inr('50000'),
        startDate: '2025-01-01',
        asOf: '2024-12-31',
      });
      expect(paid.instalmentsPaid).toBe(0);
    });
  });
});

describe('US-1.13 cash holdings', () => {
  describe('Scenario: Cash in hand is included in net worth and Schedule AL movable assets', () => {
    it('registers CASH_IN_HAND as a domestic asset', () => {
      expect(AssetRegistry.jurisdictionOf('CASH_IN_HAND')).toBe('DOMESTIC');
    });

    it('registers BANK_BALANCE as a domestic asset', () => {
      expect(AssetRegistry.jurisdictionOf('BANK_BALANCE')).toBe('DOMESTIC');
    });
  });
});
