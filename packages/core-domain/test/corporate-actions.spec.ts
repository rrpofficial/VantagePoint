/**
 * US-1.6 — Corporate actions: split, bonus, merger, demerger (PRD FR-1.2)
 */
import { describe, it, expect } from 'vitest';
import { CorporateActionEngine, type CorporateAction } from '@vantagepoint/core-domain';
import { aLot, expectMoney, inr } from '@vantagepoint/test-kit';

const LOT = aLot({
  lotId: 'L1',
  acquisitionDate: '2023-04-01',
  quantity: '100',
  remainingQuantity: '100',
  costPerUnit: inr('1000'),
});

const split15: CorporateAction = {
  actionId: 'ca_01',
  assetId: 'ast_1',
  kind: 'SPLIT',
  recordDate: '2025-07-01',
  ratio: { from: '1', to: '5' },
};

const bonus11: CorporateAction = {
  actionId: 'ca_02',
  assetId: 'ast_1',
  kind: 'BONUS',
  recordDate: '2025-07-01',
  ratio: { from: '1', to: '1' },
};

describe('US-1.6 corporate actions', () => {
  describe('Scenario: Stock split preserves total cost basis and original acquisition date', () => {
    it('turns 100 shares at ₹1,000 into 500 shares at ₹200', () => {
      const [lot] = CorporateActionEngine.apply([LOT], split15);
      expect(lot?.remainingQuantity).toBe('500');
      expectMoney(lot?.costPerUnit ?? inr('0'), inr('200'));
    });

    it('leaves total cost basis unchanged at ₹100,000', () => {
      const [lot] = CorporateActionEngine.apply([LOT], split15);
      const total = Number(lot?.remainingQuantity) * Number(lot?.costPerUnit.amount);
      expect(total).toBe(100000);
    });

    it('preserves the 2023-04-01 acquisition date for holding-period purposes', () => {
      const [lot] = CorporateActionEngine.apply([LOT], split15);
      expect(lot?.acquisitionDate).toBe('2023-04-01');
    });
  });

  describe('Scenario: Bonus issue creates a zero-cost lot dated at the bonus record date', () => {
    it('adds a 100-share lot at zero cost dated 2025-07-01', () => {
      const lots = CorporateActionEngine.apply([LOT], bonus11);
      const bonusLot = lots.find((l) => l.isBonus === true);
      expect(bonusLot?.quantity).toBe('100');
      expect(bonusLot?.acquisitionDate).toBe('2025-07-01');
      expectMoney(bonusLot?.costPerUnit ?? inr('1'), inr('0'));
    });

    it('leaves the original lot unchanged', () => {
      const lots = CorporateActionEngine.apply([LOT], bonus11);
      const original = lots.find((l) => l.lotId === 'L1');
      expect(original?.quantity).toBe('100');
      expectMoney(original?.costPerUnit ?? inr('0'), inr('1000'));
    });
  });
});
