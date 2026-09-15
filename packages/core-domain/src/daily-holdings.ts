/**
 * How much of a holding was held on each day of a window (Phase 6).
 *
 * Schedule FA Table A3 wants the PEAK value across the calendar year, and
 * `peak-value.ts` computes it per day from the quantity actually held that day —
 * so a mid-year sale cannot leave the earlier, larger holding valued at the
 * later quantity. This is what supplies that quantity.
 *
 * Reconstructed from acquisitions and disposals rather than read from a running
 * balance, because no running balance is stored: `remainingQuantity` is the
 * position TODAY, and using it across the year would report every day at the
 * closing quantity, which is exactly the understatement A3 must not make.
 */
import { Decimal } from 'decimal.js';
import type { IsoDate } from '@porttrack/shared-kernel';
import { compareIsoDates } from './daycount.js';
import type { Asset, ExitTransaction } from './types.js';

const DAY_MS = 86_400_000;

function eachDay(from: IsoDate, to: IsoDate): readonly IsoDate[] {
  const days: IsoDate[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = start; at <= end; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Quantity held on each day of `[from, to]`, inclusive.
 *
 * Days before the first acquisition are present and zero rather than absent:
 * `compute` skips a day with no price or rate, and a day with a genuine zero
 * holding must be distinguishable from a day the series does not cover.
 */
export function dailyQuantities(
  asset: Asset,
  exits: readonly ExitTransaction[],
  from: IsoDate,
  to: IsoDate,
): ReadonlyMap<IsoDate, string> {
  const acquisitions = asset.lots.map((lot) => ({
    date: lot.acquisitionDate,
    change: new Decimal(lot.quantity),
  }));
  const disposals = exits
    .filter((exit) => exit.assetId === asset.assetId)
    .map((exit) => ({ date: exit.exitDate, change: new Decimal(exit.quantity).negated() }));

  const moves = [...acquisitions, ...disposals].sort((a, b) => compareIsoDates(a.date, b.date));

  const series = new Map<IsoDate, string>();
  let running = new Decimal(0);
  let index = 0;

  for (const day of eachDay(from, to)) {
    while (index < moves.length) {
      const move = moves[index];
      if (move === undefined || compareIsoDates(move.date, day) > 0) break;
      running = running.plus(move.change);
      index++;
    }
    // Clamped: a disposal imported without its acquisition would otherwise drive
    // the series negative, and a negative quantity multiplied by a price is a
    // negative disclosure.
    series.set(day, Decimal.max(0, running).toFixed());
  }

  return series;
}

/** The earliest acquisition, or undefined for a holding with no lots. */
export function firstAcquisitionOf(asset: Asset): IsoDate | undefined {
  return asset.lots.reduce<IsoDate | undefined>(
    (earliest, lot) =>
      earliest === undefined || compareIsoDates(lot.acquisitionDate, earliest) < 0
        ? lot.acquisitionDate
        : earliest,
    undefined,
  );
}
