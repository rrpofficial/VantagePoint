/**
 * Peak value over a period (US-6.1, PRD FR-6.1).
 *
 * Schedule FA asks for the HIGHEST value a foreign holding reached during the
 * calendar year, not its closing value. The two differ sharply for anything
 * volatile, and reporting the closing figure understates the disclosure — which
 * is the failure the Black Money Act penalises.
 *
 * The peak is computed per day from the quantity actually held on that day, so a
 * mid-year sale cannot leave the earlier, larger holding valued at the later
 * quantity.
 */
import { Money, type IsoDate, type Money as MoneyValue, type Rate } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { PeakValue } from './types.js';

export interface PeakValueInput {
  readonly assetId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly dailyQuantities: ReadonlyMap<IsoDate, string>;
  readonly dailyPrices: ReadonlyMap<IsoDate, MoneyValue>;
  readonly dailyRates: ReadonlyMap<IsoDate, Rate>;
}

export function compute(input: PeakValueInput): PeakValue {
  let peakNative = new Decimal(0);
  let peakInr = new Decimal(0);
  let peakDate: IsoDate = input.from;
  let currency: MoneyValue['currency'] = 'INR';

  for (const [date, quantity] of input.dailyQuantities) {
    if (date < input.from || date > input.to) continue;

    const price = input.dailyPrices.get(date);
    const rate = input.dailyRates.get(date);
    if (price === undefined || rate === undefined) continue;

    const native = new Decimal(quantity).times(price.amount);
    if (native.lessThanOrEqualTo(peakNative)) continue;

    peakNative = native;
    peakInr = native.times(rate);
    peakDate = date;
    currency = price.currency;
  }

  return {
    peakNative: Money.round(Money.of(peakNative.toFixed(), currency), 2, 'HALF_UP'),
    peakInr: Money.round(Money.of(peakInr.toFixed(), 'INR'), 2, 'HALF_UP'),
    peakDate,
  };
}

/** Convenience for a holding acquired partway through the year. */
export function computeFromAcquisition(
  input: PeakValueInput & { acquisitionDate: IsoDate },
): PeakValue {
  const from = input.acquisitionDate > input.from ? input.acquisitionDate : input.from;
  return compute({ ...input, from });
}
