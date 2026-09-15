/**
 * Corporate actions (US-1.6, PRD FR-1.2).
 *
 * The invariant that matters for tax: a split or bonus must never restart the
 * holding period. Splitting a lot acquired in 2023 produces lots still dated 2023,
 * so a sale after the action is still long-term. A bonus issue is the exception —
 * those shares are genuinely acquired on the record date at zero cost.
 */
import { Money } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { AcquisitionLot, CorporateAction } from './types.js';

export function applyCorporateAction(
  lots: readonly AcquisitionLot[],
  action: CorporateAction,
): readonly AcquisitionLot[] {
  const from = new Decimal(action.ratio.from);
  const to = new Decimal(action.ratio.to);

  switch (action.kind) {
    case 'SPLIT':
    case 'DEMERGER': {
      const factor = to.dividedBy(from);
      return lots.map((lot) => {
        const quantity = new Decimal(lot.quantity).times(factor);
        const remaining = new Decimal(lot.remainingQuantity).times(factor);
        return {
          ...lot,
          quantity: quantity.toFixed(),
          remainingQuantity: remaining.toFixed(),
          // Total cost basis is preserved: per-unit cost falls by the same factor.
          costPerUnit: Money.divide(lot.costPerUnit, factor.toFixed()),
        };
      });
    }

    case 'BONUS': {
      const factor = to.dividedBy(from);
      const bonusLots = lots
        .filter((lot) => new Decimal(lot.remainingQuantity).greaterThan(0))
        .map((lot) => {
          const quantity = new Decimal(lot.remainingQuantity).times(factor).toFixed();
          return {
            ...lot,
            lotId: `${lot.lotId}_bonus_${action.actionId}`,
            acquisitionDate: action.recordDate,
            settlementDate: action.recordDate,
            quantity,
            remainingQuantity: quantity,
            costPerUnit: Money.zero(lot.costPerUnit.currency),
            fees: Money.zero(lot.costPerUnit.currency),
            stt: Money.zero(lot.costPerUnit.currency),
            otherCharges: Money.zero(lot.costPerUnit.currency),
            isBonus: true,
          } satisfies AcquisitionLot;
        });
      return [...lots, ...bonusLots];
    }

    case 'MERGER': {
      // Shares of the transferor are exchanged at the ratio; cost basis and the
      // original acquisition date carry over to the transferee holding.
      const factor = to.dividedBy(from);
      return lots.map((lot) => {
        const quantity = new Decimal(lot.quantity).times(factor);
        const remaining = new Decimal(lot.remainingQuantity).times(factor);
        return {
          ...lot,
          quantity: quantity.toFixed(),
          remainingQuantity: remaining.toFixed(),
          costPerUnit: Money.divide(lot.costPerUnit, factor.toFixed()),
        };
      });
    }
  }
}
