/**
 * Variance analysis between two points in time (US-3.5, US-3.6, US-3.7).
 *
 * Positions are matched by `assetId` via a hash join, not a nested scan — the
 * NFR-2 budget is 2 seconds over 1,000 positions, and O(n²) matching would blow
 * that on a portfolio a serious investor actually has.
 *
 * Where native values and rates are available, a foreign position's movement is
 * split into price effect and currency effect. Reporting only the INR delta would
 * tell a user their US holdings "gained ₹4 lakh" in a year the stock fell and the
 * rupee weakened — technically true, and useless.
 */
import { Money, type Money as MoneyValue, type Percentage } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { PortfolioValuation } from '@vantagepoint/core-domain';
import type {
  AllocationRow,
  MovementBucket,
  PositionDelta,
  Snapshot,
  SnapshotPosition,
  VarianceReport,
} from './types.js';

type Side = Snapshot | PortfolioValuation;

const isSnapshot = (side: Side): side is Snapshot => 'snapshotId' in side;

const netWorthOf = (side: Side): MoneyValue =>
  isSnapshot(side) ? side.totals.netWorth : side.netWorth;

const positionsOf = (side: Side): readonly SnapshotPosition[] =>
  (isSnapshot(side) ? side.positions : side.positions);

const ZERO = Money.zero('INR');

function pctChange(before: MoneyValue, after: MoneyValue): Percentage {
  const start = new Decimal(before.amount);
  if (start.isZero()) return after.amount === '0' ? '0' : '100';
  return new Decimal(after.amount).minus(start).dividedBy(start.abs()).times(100).toFixed(6);
}

function bucketFor(before: SnapshotPosition | undefined, after: SnapshotPosition | undefined): MovementBucket {
  if (before === undefined) return 'NEW';
  if (after === undefined) return 'LIQUIDATED';
  const comparison = new Decimal(after.marketValue.amount).comparedTo(before.marketValue.amount);
  return comparison > 0 ? 'INCREASED' : comparison < 0 ? 'DECREASED' : 'UNCHANGED';
}

/**
 * Splits an INR movement into the part caused by the asset's own price and the
 * part caused by the exchange rate. Requires native values and rates on both
 * sides; domestic positions need no attribution.
 */
function attribute(
  before: SnapshotPosition | undefined,
  after: SnapshotPosition | undefined,
): { priceEffect?: MoneyValue; currencyEffect?: MoneyValue } {
  if (!before?.nativeValue || !after?.nativeValue || !before.fxRate || !after.fxRate) return {};

  const nativeBefore = new Decimal(before.nativeValue.amount);
  const nativeAfter = new Decimal(after.nativeValue.amount);
  const rateBefore = new Decimal(before.fxRate);
  const rateAfter = new Decimal(after.fxRate);

  // Price effect valued at the opening rate; currency effect on the closing
  // quantity. The two sum exactly to the INR delta.
  const priceEffect = nativeAfter.minus(nativeBefore).times(rateBefore);
  const currencyEffect = nativeAfter.times(rateAfter.minus(rateBefore));

  return {
    priceEffect: Money.round(Money.of(priceEffect.toFixed(), 'INR'), 2, 'HALF_UP'),
    currencyEffect: Money.round(Money.of(currencyEffect.toFixed(), 'INR'), 2, 'HALF_UP'),
  };
}

export function compare(before: Side, after: Side): VarianceReport {
  const beforeById = new Map(positionsOf(before).map((p) => [p.assetId, p]));
  const afterById = new Map(positionsOf(after).map((p) => [p.assetId, p]));

  const deltas: PositionDelta[] = [];
  for (const assetId of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const from = beforeById.get(assetId);
    const to = afterById.get(assetId);
    const valueBefore = from?.marketValue ?? ZERO;
    const valueAfter = to?.marketValue ?? ZERO;

    deltas.push({
      assetId,
      /*
       * Carried onto the delta so a comparison can be READ by asset class
       * (Phase 4). Both snapshots hold it, and without it the only way to scope
       * "how did the equity sleeve move" was to join every row back against the
       * live ledger — which answers a different question, because an asset sold
       * since the snapshot is no longer there to classify.
       *
       * The AFTER side wins where both have it; a liquidated position keeps the
       * class it had when it existed.
       */
      assetClass: to?.assetClass ?? from?.assetClass ?? 'OTHER',
      bucket: bucketFor(from, to),
      quantityBefore: from?.quantity ?? '0',
      quantityAfter: to?.quantity ?? '0',
      valueBefore,
      valueAfter,
      valueDelta: Money.subtract(valueAfter, valueBefore),
      valueDeltaPct: pctChange(valueBefore, valueAfter),
      ...attribute(from, to),
    });
  }

  const netWorthBefore = netWorthOf(before);
  const netWorthAfter = netWorthOf(after);

  const byDeltaDesc = [...deltas].sort(
    (a, b) => new Decimal(b.valueDelta.amount).comparedTo(a.valueDelta.amount),
  );

  return {
    netWorthBefore,
    netWorthAfter,
    netWorthDelta: Money.subtract(netWorthAfter, netWorthBefore),
    netWorthDeltaPct: pctChange(netWorthBefore, netWorthAfter),
    positions: deltas,
    topGainers: byDeltaDesc.filter((d) => new Decimal(d.valueDelta.amount).greaterThan(0)),
    newAdditions: deltas.filter((d) => d.bucket === 'NEW'),
    liquidations: deltas.filter((d) => d.bucket === 'LIQUIDATED'),
    allocation: allocationShift(before, after),
  };
}

/** Asset-class allocation on each side, as percentages of gross holdings. */
export function allocationShift(before: Side, after: Side): readonly AllocationRow[] {
  const share = (side: Side): Map<string, Decimal> => {
    const totals = new Map<string, Decimal>();
    let gross = new Decimal(0);
    for (const position of positionsOf(side)) {
      const value = new Decimal(position.marketValue.amount);
      totals.set(position.assetClass, (totals.get(position.assetClass) ?? new Decimal(0)).plus(value));
      gross = gross.plus(value);
    }
    const shares = new Map<string, Decimal>();
    for (const [assetClass, value] of totals) {
      shares.set(assetClass, gross.isZero() ? new Decimal(0) : value.dividedBy(gross).times(100));
    }
    return shares;
  };

  const beforeShares = share(before);
  const afterShares = share(after);

  const rows: AllocationRow[] = [];
  for (const assetClass of new Set([...beforeShares.keys(), ...afterShares.keys()])) {
    const pctBefore = beforeShares.get(assetClass) ?? new Decimal(0);
    const pctAfter = afterShares.get(assetClass) ?? new Decimal(0);
    rows.push({
      assetClass: assetClass as AllocationRow['assetClass'],
      pctBefore: pctBefore.toFixed(6),
      pctAfter: pctAfter.toFixed(6),
      shiftPct: pctAfter.minus(pctBefore).toFixed(6),
    });
  }
  return rows.sort((a, b) => a.assetClass.localeCompare(b.assetClass));
}
