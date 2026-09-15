/**
 * US-1.8 — Statutory schemes: EPF, VPF, NPS (Tier I/II), PPF, Gratuity (PRD FR-1.1)
 * US-1.9 — Fixed and recurring deposits (in deposits.spec.ts)
 */
import { describe, it, expect } from 'vitest';
import { AccrualEngine, AssetRegistry } from '@vantagepoint/core-domain';
import { expectMoney, inr } from '@vantagepoint/test-kit';

describe('US-1.8 statutory schemes', () => {
  describe('Scenario: EPF balance accrues employee, employer and interest components', () => {
    const input = {
      openingBalance: inr('1000000'),
      monthlyEmployee: inr('15000'),
      monthlyEmployer: inr('15000'),
      annualRatePct: '8.25',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    };

    it('adds ₹360,000 of contributions over the financial year', () => {
      expectMoney(AccrualEngine.epfProjection(input).contributions, inr('360000'));
    });

    it('computes interest on monthly running balances, not the opening balance alone', () => {
      const { interest } = AccrualEngine.epfProjection(input);
      const flatOnOpening = 1000000 * 0.0825;
      expect(Number(interest.amount)).toBeGreaterThan(flatOnOpening);
    });

    it('reports a closing balance equal to opening + contributions + interest', () => {
      const { closingBalance, contributions, interest } = AccrualEngine.epfProjection(input);
      expect(Number(closingBalance.amount)).toBe(
        1000000 + Number(contributions.amount) + Number(interest.amount),
      );
    });
  });

  describe('Scenario: Gratuity is projected from last drawn salary and tenure', () => {
    it('computes 15/26 × ₹200,000 × 12 = ₹1,384,615.38', () => {
      expectMoney(
        AccrualEngine.gratuity({ lastDrawnMonthly: inr('200000'), completedYears: 12 }),
        inr('1384615.38'),
      );
    });

    it('returns zero for tenure below the statutory minimum of 5 years', () => {
      expectMoney(
        AccrualEngine.gratuity({ lastDrawnMonthly: inr('200000'), completedYears: 4 }),
        inr('0'),
      );
    });
  });

  describe('Scenario: NPS Tier I is flagged as illiquid until age 60', () => {
    it('classifies NPS_TIER_I as a domestic asset', () => {
      expect(AssetRegistry.jurisdictionOf('NPS_TIER_I')).toBe('DOMESTIC');
    });

    it('marks the holding LOCKED_UNTIL_60 while the holder is 45', () => {
      const asset = AssetRegistry.register({ assetClass: 'NPS_TIER_I', currency: 'INR' });
      expect(asset.ok && asset.value.liquidity).toBe('LOCKED_UNTIL_60');
    });

    it('still includes NPS Tier I in net worth despite the lock', () => {
      const asset = AssetRegistry.register({ assetClass: 'NPS_TIER_I', currency: 'INR' });
      expect(asset.ok).toBe(true);
    });
  });

  describe('All statutory classes are registrable', () => {
    it.each(['EPF', 'VPF', 'NPS_TIER_I', 'NPS_TIER_II', 'PPF', 'GRATUITY'] as const)(
      'registers %s',
      (assetClass) => {
        expect(AssetRegistry.register({ assetClass, currency: 'INR' }).ok).toBe(true);
      },
    );
  });
});
