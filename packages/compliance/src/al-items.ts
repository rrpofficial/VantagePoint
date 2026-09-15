/**
 * Turning the asset ledger into Schedule AL line items (US-6.4, PRD FR-6.2).
 *
 * **Cost of acquisition, never market value.** The rest of the product reports
 * what a holding is worth; this schedule reports what was paid for it. Feeding
 * market value in here would overstate every appreciated holding on a statutory
 * return, and nothing downstream could tell the difference.
 *
 * Cost is apportioned by REMAINING quantity: a partially sold lot contributes
 * only the cost of what is still held at year end.
 */
import { Money, type Money as MoneyValue } from '@porttrack/shared-kernel';
import { Decimal } from 'decimal.js';
import type { Asset, AssetClass, Liability } from '@porttrack/core-domain';
import type { ScheduleAlHead, ScheduleAlItem } from './types.js';

/**
 * Where each asset class is disclosed. Bullion and SGBs sit under the jewellery
 * head with gold, which is where the schedule expects precious metals — grouping
 * them with financial assets would be tidier and wrong.
 */
const HEAD_BY_CLASS: Readonly<Record<AssetClass, ScheduleAlHead>> = {
  DOMESTIC_EQUITY: 'FINANCIAL_ASSETS',
  DOMESTIC_ETF: 'FINANCIAL_ASSETS',
  DOMESTIC_MUTUAL_FUND: 'FINANCIAL_ASSETS',
  FOREIGN_EQUITY: 'FINANCIAL_ASSETS',
  FOREIGN_ETF: 'FINANCIAL_ASSETS',
  EPF: 'FINANCIAL_ASSETS',
  VPF: 'FINANCIAL_ASSETS',
  NPS_TIER_I: 'FINANCIAL_ASSETS',
  NPS_TIER_II: 'FINANCIAL_ASSETS',
  PPF: 'FINANCIAL_ASSETS',
  GRATUITY: 'FINANCIAL_ASSETS',
  FIXED_DEPOSIT: 'FINANCIAL_ASSETS',
  RECURRING_DEPOSIT: 'FINANCIAL_ASSETS',
  UNLISTED_SHARES: 'FINANCIAL_ASSETS',
  CRYPTO: 'FINANCIAL_ASSETS',
  CHIT_FUND: 'FINANCIAL_ASSETS',
  BANK_BALANCE: 'FINANCIAL_ASSETS',
  REAL_ESTATE: 'IMMOVABLE_PROPERTY',
  CASH_IN_HAND: 'CASH_IN_HAND',
  HAND_LOAN: 'LOANS_AND_ADVANCES',
  GOLD_PHYSICAL: 'JEWELLERY',
  GOLD_DIGITAL: 'JEWELLERY',
  SGB: 'JEWELLERY',
};

const label = (assetClass: AssetClass) =>
  assetClass.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Cost of what is STILL HELD, charges apportioned to the surviving units. */
function retainedCost(asset: Asset): MoneyValue {
  const currency = asset.currency;
  let total = new Decimal(0);

  for (const lot of asset.lots) {
    const original = new Decimal(lot.quantity);
    const remaining = new Decimal(lot.remainingQuantity);
    if (remaining.lessThanOrEqualTo(0)) continue;

    const units = remaining.times(new Decimal(lot.costPerUnit.amount));
    const charges = new Decimal(lot.fees.amount)
      .plus(new Decimal(lot.stt.amount))
      .plus(new Decimal(lot.otherCharges.amount));
    // A zero-quantity lot cannot have its charges apportioned; carrying them in
    // full would attribute the whole brokerage of a closed position to nothing.
    const share = original.isZero() ? new Decimal(0) : remaining.dividedBy(original);

    total = total.plus(units).plus(charges.times(share));
  }

  return Money.round(Money.of(total.toFixed(), currency), 2, 'HALF_UP');
}

export interface AlItemsInput {
  readonly assets: readonly Asset[];
  readonly liabilities: readonly Liability[];
}

export function scheduleAlItems(input: AlItemsInput): readonly ScheduleAlItem[] {
  const items: ScheduleAlItem[] = [];

  for (const asset of input.assets) {
    if (asset.positionClosed === true) continue;

    const cost =
      asset.assetClass === 'HAND_LOAN' && asset.handLoan !== undefined
        ? // A loan given out is disclosed at its principal, not at a cost basis
          // it never had — there are no acquisition lots behind it.
          asset.handLoan.principal
        : retainedCost(asset);

    if (Money.isZero(cost)) continue;

    items.push({
      head: HEAD_BY_CLASS[asset.assetClass],
      description: asset.symbol ?? asset.isin ?? label(asset.assetClass),
      costOfAcquisition: cost,
    });
  }

  for (const liability of input.liabilities) {
    items.push({
      // Reported under their own head, never netted against assets (ADR-009).
      head: 'LIABILITIES',
      description: label(liability.kind as AssetClass),
      costOfAcquisition: liability.principalOutstanding,
    });
  }

  return items;
}
