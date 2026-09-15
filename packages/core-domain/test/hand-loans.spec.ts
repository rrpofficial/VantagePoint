/**
 * US-1.11 — Hand loans with interest accrual (PRD FR-1 AC)
 */
import { describe, it, expect } from 'vitest';
import { AccrualEngine, ValuationEngine, type HandLoan } from '@vantagepoint/core-domain';
import { MaskingPipeline } from '@vantagepoint/pii-masker';
import { aHandLoan, aHandLoanAsset, expectMoney, inr, SYNTHETIC } from '@vantagepoint/test-kit';

const LOAN: HandLoan = aHandLoan({ assetId: 'ast_handloan_002' });

describe('US-1.11 hand loans', () => {
  describe('Scenario: Tracking hand loans with interest (PRD FR-1 AC)', () => {
    it('values the principal at ₹5,000,000 on 2026-03-31', () => {
      const valuation = ValuationEngine.value({
        assets: [aHandLoanAsset(LOAN)],
        liabilities: [],
        asOf: '2026-03-31T23:59:59.999+05:30',
      });
      expectMoney(valuation.positions[0]?.costBasis ?? inr('0'), inr('5000000'));
    });

    it('includes principal plus accrued interest in net worth', () => {
      const valuation = ValuationEngine.value({
        assets: [aHandLoanAsset(LOAN)],
        liabilities: [],
        asOf: '2026-03-31T23:59:59.999+05:30',
      });
      expectMoney(valuation.netWorth, inr('5400000'));
    });

    it('accrues ₹400,000 of interest over the full year to 2026-03-31', () => {
      expectMoney(AccrualEngine.handLoanAccruedInterest(LOAN, '2026-03-31'), inr('400000'));
    });

    it('accrues zero interest on the start date itself', () => {
      expectMoney(AccrualEngine.handLoanAccruedInterest(LOAN, '2025-04-01'), inr('0'));
    });
  });

  describe('Scenario: Partial repayment reduces principal and stops interest on the repaid part', () => {
    const withRepayment: HandLoan = {
      ...LOAN,
      repayments: [{ date: '2025-10-01', principal: inr('2000000') }],
    };

    // On a 30/360 basis (see daycount.ts) the two periods are 180 days each:
    // ₹5,000,000 × 8% × ½ = ₹200,000, then ₹3,000,000 × 8% × ½ = ₹120,000.
    // The original ₹320,547.95 mixed ACT/365 for one leg with 30/360 for the other.
    it('accrues ₹320,000 to 2026-03-31 across the two principal periods', () => {
      expectMoney(
        AccrualEngine.handLoanAccruedInterest(withRepayment, '2026-03-31'),
        inr('320000'),
      );
    });

    it('reduces the outstanding principal to ₹3,000,000 after the repayment', () => {
      expectMoney(
        AccrualEngine.handLoanOutstandingPrincipal(withRepayment, '2026-03-31'),
        inr('3000000'),
      );
    });

    it('accrues less than the un-repaid loan over the same period', () => {
      const full = Number(AccrualEngine.handLoanAccruedInterest(LOAN, '2026-03-31').amount);
      const partial = Number(
        AccrualEngine.handLoanAccruedInterest(withRepayment, '2026-03-31').amount,
      );
      expect(partial).toBeLessThan(full);
    });
  });

  describe('Scenario: Borrower name is a PII reference, never plain text in AI payloads', () => {
    it('masks the borrower name when serialised for an AI payload', () => {
      const masked = MaskingPipeline.maskPayload({
        assetClass: 'HAND_LOAN',
        borrowerName: SYNTHETIC.PERSON,
        principalAmount: 5000000,
      });
      expect(masked.borrowerName).toBe('[REDACTED_NAME]');
    });

    it('leaves the non-PII principal amount untouched', () => {
      const masked = MaskingPipeline.maskPayload({
        assetClass: 'HAND_LOAN',
        borrowerName: SYNTHETIC.PERSON,
        principalAmount: 5000000,
      });
      expect(masked.principalAmount).toBe(5000000);
    });
  });
});
