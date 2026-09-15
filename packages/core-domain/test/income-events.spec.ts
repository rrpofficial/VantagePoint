/**
 * US-1.5 — Dividend and interest ingestion with withholding tax (PRD FR-1.2)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IncomeLedger, LotBook } from '@vantagepoint/core-domain';
import { DualRateConverter, Rule115Resolver } from '@vantagepoint/fx-itbr';
import { expectMoney, expectOk, inr, usd , seedStandardRates } from '@vantagepoint/test-kit';

beforeEach(() => {
  seedStandardRates();
});

describe('US-1.5 income events', () => {
  describe('Scenario: Foreign dividend with W-8BEN treaty withholding', () => {
    it('records gross $500.00, withheld $125.00 and net $375.00 at a 25% treaty rate', () => {
      const event = expectOk(
        IncomeLedger.recordDividend({
          assetId: 'ast_foreign_equity_0001',
          date: '2025-08-14',
          grossAmount: usd('500.00'),
          withholdingRatePct: '25',
        }),
      );
      expectMoney(event.grossAmount, usd('500.00'));
      expectMoney(event.taxWithheld, usd('125.00'));
      expectMoney(event.netAmount, usd('375.00'));
    });

    it('uses the Rule 115 rate for 2025-07-31 on a 2025-08-14 dividend', () => {
      expect(Rule115Resolver.basisDateFor('2025-08-14')).toBe('2025-07-31');
    });

    it('converts the gross dividend to INR at the Rule 115 rate, not the receipt-date rate', () => {
      const rates = expectOk(DualRateConverter.ratesFor('USD', '2025-08-14'));
      const { taxableInr, valuationInr } = DualRateConverter.convert(usd('500.00'), rates);
      expect(Number(taxableInr.amount)).not.toBe(Number(valuationInr.amount));
    });

    it('tags the withheld amount as eligible for foreign tax credit', () => {
      const event = expectOk(
        IncomeLedger.recordDividend({
          assetId: 'ast_foreign_equity_0001',
          date: '2025-08-14',
          grossAmount: usd('500.00'),
          withholdingRatePct: '25',
        }),
      );
      expect(event.eligibleForForeignTaxCredit).toBe(true);
    });
  });

  describe('Scenario: Domestic dividend with TDS under section 194', () => {
    const domestic = () =>
      expectOk(
        IncomeLedger.recordDividend({
          assetId: 'ast_domestic_equity_0001',
          date: '2025-08-14',
          grossAmount: inr('100000'),
          taxWithheld: inr('10000'),
        }),
      );

    it('adds ₹100,000 gross dividend to other-sources income', () => {
      expectMoney(domestic().grossAmount, inr('100000.00'));
      expect(domestic().kind).toBe('DIVIDEND_DOMESTIC');
    });

    it('adds ₹10,000 TDS to the credit pool used by advance tax', () => {
      expectMoney(domestic().taxWithheld, inr('10000.00'));
    });

    it('does not mark domestic TDS as eligible for foreign tax credit', () => {
      expect(domestic().eligibleForForeignTaxCredit).toBe(false);
    });
  });

  describe('Scenario: Auto-reinvested interest creates a new lot', () => {
    it('creates a 20-unit lot at NAV ₹250 dated 2025-09-30 for a ₹5,000 reinvestment', () => {
      const lot = expectOk(
        LotBook.recordAcquisition({
          assetClass: 'DOMESTIC_MUTUAL_FUND',
          tradeDate: '2025-09-30',
          quantity: '20',
          pricePerUnit: inr('250'),
        }),
      );
      expect(lot.quantity).toBe('20');
      expect(lot.acquisitionDate).toBe('2025-09-30');
      expectMoney(LotBook.totalCostBasis(lot), inr('5000'));
    });
  });
});
