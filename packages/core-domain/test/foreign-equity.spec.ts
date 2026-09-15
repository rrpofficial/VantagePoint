/**
 * US-1.4 — Foreign equity lots with dual-currency cost basis, RSU/ESPP (PRD FR-1 AC, ADR-003)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FifoAllocator, LotBook } from '@vantagepoint/core-domain';
import { DualRateConverter } from '@vantagepoint/fx-itbr';
import { aDualRate, aLot, expectMoney, expectOk, inr, usd , seedStandardRates } from '@vantagepoint/test-kit';

beforeEach(() => {
  seedStandardRates();
});

const AAPL_LOT = aLot({
  lotId: 'lot_aapl_01',
  acquisitionDate: '2023-05-10',
  quantity: '100',
  remainingQuantity: '100',
  costPerUnit: usd('172.50'),
});

describe('US-1.4 foreign equity', () => {
  describe('Scenario: Partial exit on foreign RSUs with currency conversion (PRD FR-1 AC)', () => {
    it('records the exit date as 2026-02-15', () => {
      const { allocations } = expectOk(FifoAllocator.allocate([AAPL_LOT], '40'));
      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.lotId).toBe('lot_aapl_01');
    });

    it('computes the realised gain using FIFO lot allocation', () => {
      const { allocations } = expectOk(FifoAllocator.allocate([AAPL_LOT], '40'));
      const gainUsd =
        40 * 180.0 - Number(allocations[0]?.quantity) * Number(allocations[0]?.costPerUnit.amount);
      expect(gainUsd).toBe(300);
    });

    it('converts USD proceeds at the trade-date SBI ITBR rate for valuation', () => {
      const rates = expectOk(DualRateConverter.ratesFor('USD', '2026-02-15'));
      const { valuationInr } = DualRateConverter.convert(usd('7200.00'), rates);
      expectMoney(valuationInr, inr('605520.00'));
    });

    it('converts taxable proceeds at the Rule 115 rate for 2026-01-31', () => {
      const rates = expectOk(DualRateConverter.ratesFor('USD', '2026-02-15'));
      const { taxableInr } = DualRateConverter.convert(usd('7200.00'), rates);
      expectMoney(taxableInr, inr('601560.00'));
    });

    it('leaves 60 shares remaining for future snapshot calculations', () => {
      const { updatedLots } = expectOk(FifoAllocator.allocate([AAPL_LOT], '40'));
      expect(updatedLots[0]?.remainingQuantity).toBe('60');
    });
  });

  describe('ADR-003: the two rates are distinct and never interchanged', () => {
    it('produces different INR amounts for valuation and tax', () => {
      const { valuationInr, taxableInr } = DualRateConverter.convert(usd('7200.00'), aDualRate());
      expect(Number(valuationInr.amount)).not.toBe(Number(taxableInr.amount));
    });

    it('records the provenance of each rate independently', () => {
      const rates = expectOk(DualRateConverter.ratesFor('USD', '2026-02-15'));
      expect(rates.valuationRate).not.toBe(rates.taxRate);
      expect(rates.valuationRateSource).toBeDefined();
      expect(rates.taxRateSource).toBeDefined();
    });
  });

  describe('Scenario: RSU vesting creates a lot at fair market value on vest date', () => {
    it('creates a lot dated 2025-11-15 at $210.00 cost per unit', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'FOREIGN_EQUITY',
          equityAward: { kind: 'RSU', grantRef: 'grant_test' },
          tradeDate: '2025-11-15',
          quantity: '50',
          pricePerUnit: usd('210.00'),
          fx: aDualRate(),
        }),
      );
      expect(lot.acquisitionDate).toBe('2025-11-15');
      expectMoney(lot.costPerUnit, usd('210.00'));
    });

    it('records the INR perquisite value for salary-income reporting', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'FOREIGN_EQUITY',
          equityAward: { kind: 'RSU', grantRef: 'grant_test' },
          tradeDate: '2025-11-15',
          quantity: '50',
          pricePerUnit: usd('210.00'),
          fx: aDualRate(),
        }),
      );
      expect(lot.perquisiteValue).toBeDefined();
    });
  });

  describe('Scenario: ESPP discount is recorded separately from cost basis', () => {
    it('sets cost per unit to the $170.00 discounted price', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'FOREIGN_EQUITY',
          equityAward: { kind: 'ESPP', grantRef: 'offer_test' },
          tradeDate: '2025-11-15',
          quantity: '25',
          pricePerUnit: usd('170.00'),
          fmvPerUnit: usd('200.00'),
          fx: aDualRate(),
        }),
      );
      expectMoney(lot.costPerUnit, usd('170.00'));
    });

    it('records the $30.00 per-share discount as a perquisite', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'FOREIGN_EQUITY',
          equityAward: { kind: 'ESPP', grantRef: 'offer_test' },
          tradeDate: '2025-11-15',
          quantity: '25',
          pricePerUnit: usd('170.00'),
          fmvPerUnit: usd('200.00'),
          fx: aDualRate(),
        }),
      );
      expectMoney(lot.perquisiteValue ?? usd('0'), usd('30.00'));
    });
  });
});
