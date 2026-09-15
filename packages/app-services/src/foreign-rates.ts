/**
 * Stamps every foreign lot and disposal with the rates it must be read at
 * (ADR-003, Rule 115).
 *
 * The rate is resolved once, at import, and STORED on the record — rather than
 * being looked up afresh whenever a figure is displayed. Two reasons, and the
 * second is the one that matters:
 *
 *  1. It is the audit trail. A tax figure has to be defensible years later, and
 *     "₹83.55 to the dollar, SBI ITBR, basis date 31-Jan-2026" is defensible in a
 *     way that "whatever the rate table says today" is not.
 *  2. Rate tables change. The SBI archive gets corrected and extended; a
 *     provisional RBI fallback is later superseded by the real ITBR. Without a
 *     stored rate, a return already filed would quietly start reporting different
 *     numbers than the ones that were filed.
 *
 * ## Each leg is stamped with its OWN date
 *
 * A lot is stamped from its acquisition date and a disposal from its exit date,
 * so `DualRateConverter.ratesFor` derives each one's Rule 115 basis — the last
 * day of the month preceding THAT leg — independently. For an RSU sold years
 * after it vested the two basis months are years apart, and the rupee movement
 * between them is taxable income that a single-date conversion erases.
 *
 * ## What is written, and why four figures rather than one
 *
 * For a lot vested on d1 at vp$ and sold on d2 at sp$, quantity q:
 *
 *   valuationInr    = sp$ × q × rate(d2)                   display only
 *   proceedsTaxInr  = sp$ × q × rate(month-end before d2)
 *   costBasisTaxInr = vp$ × q × rate(month-end before d1)
 *   taxableGainInr  = proceedsTaxInr − costBasisTaxInr
 *
 * Only the last is charged to tax; the first uses a different rate entirely
 * (ADR-003) and must never reach a tax computation. The middle two are stored
 * because the gain alone cannot be checked — a reviewer asked to verify a figure
 * needs to see the legs it came from and the month-end each was taken at.
 *
 * The tax legs are computed by `CapitalGainsEngine.rule115Legs`, the same
 * function the engine falls back to when nothing is stored, so the written value
 * and the recomputed one cannot drift apart.
 *
 * ## A rate that cannot be resolved is reported, never invented
 *
 * No substitution, no 1.0, no nearest-currency guess. The record is left without
 * a rate and named in `unpriced`, exactly as the tax engine reports
 * `unconvertible` gains. A fabricated rate in a tax computation is the worst
 * failure this codebase can produce, because the number it yields looks ordinary.
 */
import { DualRateConverter } from '@porttrack/fx-itbr';
import { CapitalGainsEngine } from '@porttrack/tax-engine';
import { Money } from '@porttrack/shared-kernel';
import type { Asset, ExitTransaction } from '@porttrack/core-domain';
import type { IsoDate } from '@porttrack/shared-kernel';

const INR = 'INR' as const;

/** A leg whose INR value could not be established, and therefore was not written. */
export interface UnpricedLeg {
  readonly kind: 'LOT' | 'EXIT';
  /** Lot id or transaction id. */
  readonly id: string;
  readonly currency: string;
  readonly onDate: IsoDate;
  readonly reason: string;
}

export interface RateStampResult {
  readonly assets: readonly Asset[];
  readonly exits: readonly ExitTransaction[];
  /** Non-empty means some foreign figures have no INR value stored. */
  readonly unpriced: readonly UnpricedLeg[];
}

export function stampForeignRates(input: {
  readonly assets: readonly Asset[];
  readonly exits: readonly ExitTransaction[];
}): RateStampResult {
  const unpriced: UnpricedLeg[] = [];

  const assets = input.assets.map((asset) => {
    /*
     * An asset is only rewritten when one of its lots actually changed. Mapping
     * unconditionally would replace every object identity on every import, which
     * makes the repository write rows that are byte-identical to the ones already
     * there.
     */
    const lots = asset.lots.map((lot) => {
      if (lot.costPerUnit.currency === INR || lot.fx !== undefined) return lot;

      const rates = DualRateConverter.ratesFor(lot.costPerUnit.currency, lot.acquisitionDate);
      if (!rates.ok) {
        unpriced.push({
          kind: 'LOT',
          id: lot.lotId,
          currency: lot.costPerUnit.currency,
          onDate: lot.acquisitionDate,
          reason: rates.error.message,
        });
        return lot;
      }

      return { ...lot, fx: rates.value };
    });

    // Object identity is the test for "did anything change" — every unstamped
    // lot is returned as-is above, so a reference comparison is exact.
    const changed = lots.some((lot, index) => lot !== asset.lots[index]);
    return changed ? { ...asset, lots } : asset;
  });

  const exits = input.exits.map((exit) => {
    if (exit.pricePerUnit.currency === INR || exit.fx !== undefined) return exit;

    const rates = DualRateConverter.ratesFor(exit.pricePerUnit.currency, exit.exitDate);
    if (!rates.ok) {
      unpriced.push({
        kind: 'EXIT',
        id: exit.txnId,
        currency: exit.pricePerUnit.currency,
        onDate: exit.exitDate,
        reason: rates.error.message,
      });
      return exit;
    }

    /*
     * Gross proceeds at the SALE-DAY rate — price times quantity, before fees.
     * Display only; the tax figures below use the Rule 115 rates instead.
     */
    const proceeds = Money.multiply(exit.pricePerUnit, exit.quantity);
    const { valuationInr } = DualRateConverter.convert(proceeds, rates.value);

    /*
     * The tax legs come from the ENGINE, not from a second conversion written
     * here. `rule115Legs` is the same function `capital-gains` uses when no
     * stored figure is present, so the value written now and the value that
     * would be recomputed later cannot disagree.
     *
     * A leg whose own rate is missing leaves all three absent rather than
     * writing a partial set: a stored proceeds figure with no cost basis reads
     * as a gain equal to the whole sale.
     */
    const legs = CapitalGainsEngine.rule115Legs(exit);
    if (!legs.ok) {
      unpriced.push({
        kind: 'EXIT',
        id: exit.txnId,
        currency: exit.pricePerUnit.currency,
        onDate: exit.exitDate,
        reason: legs.error.message,
      });
      return { ...exit, fx: rates.value, valuationInr };
    }

    return {
      ...exit,
      fx: rates.value,
      valuationInr,
      proceedsTaxInr: legs.value.proceedsInr,
      // Omitted when the source stated a net gain: there was no cost leg to
      // measure, and a zero would read as one that had been.
      ...(legs.value.legsSeparable ? { costBasisTaxInr: legs.value.costBasisInr } : {}),
      taxableGainInr: legs.value.gainInr,
    };
  });

  return { assets, exits, unpriced };
}
