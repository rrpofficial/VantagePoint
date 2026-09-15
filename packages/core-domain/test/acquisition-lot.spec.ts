/**
 * US-1.2 — Record an acquisition lot with full cost basis (PRD FR-1.2)
 */
import { describe, it, expect } from 'vitest';
import { LotBook } from '@vantagepoint/core-domain';
import { expectErr, expectMoney, expectOk, inr } from '@vantagepoint/test-kit';

describe('US-1.2 acquisition lot', () => {
  describe('Scenario: Acquisition lot captures all mandated fields (FR-1.2)', () => {
    const input = {
      assetClass: 'DOMESTIC_EQUITY' as const,
      tradeDate: '2025-06-10',
      settlementDate: '2025-06-12',
      quantity: '100',
      pricePerUnit: inr('3850.00'),
      fees: inr('20.00'),
      stt: inr('385.00'),
      otherCharges: inr('5.50'),
    };

    it('stores the trade date', () => {
      expect(expectOk(LotBook.recordAcquisition(input)).acquisitionDate).toBe('2025-06-10');
    });

    it('stores the settlement date', () => {
      expect(expectOk(LotBook.recordAcquisition(input)).settlementDate).toBe('2025-06-12');
    });

    it('computes total cost basis of ₹385,410.50 including brokerage, STT and charges', () => {
      const lot = expectOk(LotBook.recordAcquisition(input));
      expectMoney(LotBook.totalCostBasis(lot), inr('385410.50'));
    });

    it('sets remainingQuantity to the full acquired quantity', () => {
      expect(expectOk(LotBook.recordAcquisition(input)).remainingQuantity).toBe('100');
    });
  });

  describe('Scenario: Settlement date defaults to T+1 for domestic equity when omitted', () => {
    it('derives 2025-06-11 from a 2025-06-10 trade date', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'DOMESTIC_EQUITY',
          tradeDate: '2025-06-10',
          quantity: '100',
          pricePerUnit: inr('3850.00'),
        }),
      );
      expect(lot.settlementDate).toBe('2025-06-11');
    });
  });

  describe('Scenario: Negative or zero quantity is rejected', () => {
    it.each(['0', '-1', '-100.5'])('rejects quantity %s with INVALID_QUANTITY', (quantity) => {
      expectErr(
        LotBook.recordAcquisition({
          assetClass: 'DOMESTIC_EQUITY',
          tradeDate: '2025-06-10',
          quantity,
          pricePerUnit: inr('3850.00'),
        }),
        'INVALID_QUANTITY',
      );
    });
  });

  describe('D5: money never degrades to a float', () => {
    it('keeps cost basis exact for a price with repeating-decimal risk', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'DOMESTIC_EQUITY',
          tradeDate: '2025-06-10',
          quantity: '3',
          pricePerUnit: inr('0.10'),
        }),
      );
      expectMoney(LotBook.totalCostBasis(lot), inr('0.30'));
    });
  });
});
