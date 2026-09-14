/**
 * Acquisition lots and FIFO allocation (US-1.2, US-1.3, PRD FR-1.2).
 *
 * FIFO is not a preference — it is the lot-identification method Indian capital
 * gains computation assumes. Allocation is therefore ordered by acquisition date
 * regardless of the order lots arrive in, and an oversell mutates nothing: a
 * partially-applied exit would silently corrupt every later gain calculation.
 */
import {
  Err,
  InsufficientQuantityError,
  InvalidQuantityError,
  Money,
  Ok,
  type Result,
} from '@porttrack/shared-kernel';
import { Decimal } from 'decimal.js';
import { addCalendarDays, compareIsoDates } from './daycount.js';
import { SETTLEMENT_LAG_DAYS } from './taxonomy.js';
import type { Money as MoneyValue } from '@porttrack/shared-kernel';
import type { AcquisitionLot, LotAllocation, RecordAcquisitionInput } from './types.js';

const dec = (value: string) => new Decimal(value);

export function totalCostBasis(lot: AcquisitionLot): Money {
  const units = Money.multiply(lot.costPerUnit, lot.quantity);
  return Money.sum([units, lot.fees, lot.stt, lot.otherCharges], lot.costPerUnit.currency);
}

let lotCounter = 0;

export function recordAcquisition(input: RecordAcquisitionInput): Result<AcquisitionLot> {
  let quantity: Decimal;
  try {
    quantity = dec(input.quantity);
  } catch {
    return Err(new InvalidQuantityError(`"${input.quantity}" is not a valid quantity`));
  }
  if (!quantity.isFinite() || quantity.lessThanOrEqualTo(0)) {
    return Err(new InvalidQuantityError('quantity must be greater than zero'));
  }

  const currency = input.pricePerUnit.currency;
  const zero = Money.zero(currency);
  const lag = SETTLEMENT_LAG_DAYS[input.assetClass] ?? 0;
  const perquisiteValue = perquisitePerUnit(input, zero);

  const lot: AcquisitionLot = {
    lotId: input.lotId ?? `lot_${String(++lotCounter).padStart(6, '0')}`,
    acquisitionDate: input.tradeDate,
    settlementDate: input.settlementDate ?? addCalendarDays(input.tradeDate, lag),
    quantity: quantity.toFixed(),
    remainingQuantity: quantity.toFixed(),
    costPerUnit: input.pricePerUnit,
    fees: input.fees ?? zero,
    stt: input.stt ?? zero,
    otherCharges: input.otherCharges ?? zero,
    ...(input.fx ? { fx: input.fx } : {}),
    ...(input.grandfatheredFmv ? { grandfatheredFmv: input.grandfatheredFmv } : {}),
    ...(perquisiteValue ? { perquisiteValue } : {}),
  };
  return Ok(lot);
}

/**
 * Equity compensation carries a salary perquisite, taxed at vest/purchase and
 * separate from the later capital gain:
 *  - RSU: the entire fair market value at vest is a perquisite; cost basis is the
 *    same FMV, so a later sale is taxed only on movement after vesting.
 *  - ESPP: only the discount to FMV is a perquisite.
 * Anything else has none.
 */
function perquisitePerUnit(
  input: RecordAcquisitionInput,
  zero: MoneyValue,
): MoneyValue | undefined {
  if (input.perquisiteValue) return input.perquisiteValue;

  if (input.assetClass === 'RSU') {
    return input.fmvPerUnit ?? input.pricePerUnit;
  }
  if (input.assetClass === 'ESPP') {
    const fmv = input.fmvPerUnit;
    if (fmv === undefined) return undefined;
    const discount = Money.subtract(fmv, input.pricePerUnit);
    return Money.compare(discount, zero) > 0 ? discount : zero;
  }
  return undefined;
}

export interface AllocationResult {
  readonly allocations: readonly LotAllocation[];
  readonly updatedLots: readonly AcquisitionLot[];
}

export function allocateFifo(
  lots: readonly AcquisitionLot[],
  quantity: string,
): Result<AllocationResult> {
  let wanted: Decimal;
  try {
    wanted = dec(quantity);
  } catch {
    return Err(new InvalidQuantityError(`"${quantity}" is not a valid quantity`));
  }
  if (!wanted.isFinite() || wanted.lessThanOrEqualTo(0)) {
    return Err(new InvalidQuantityError('exit quantity must be greater than zero'));
  }

  const available = lots.reduce((sum, lot) => sum.plus(dec(lot.remainingQuantity)), new Decimal(0));
  if (available.lessThan(wanted)) {
    // Checked before any mutation so a rejected exit leaves the book untouched.
    return Err(
      new InsufficientQuantityError(
        `cannot exit ${wanted.toFixed()} units; only ${available.toFixed()} remain`,
      ),
    );
  }

  // Oldest first, with lotId as a deterministic tie-break for same-day lots.
  const ordered = [...lots].sort(
    (a, b) =>
      compareIsoDates(a.acquisitionDate, b.acquisitionDate) || a.lotId.localeCompare(b.lotId),
  );

  const allocations: LotAllocation[] = [];
  const consumed = new Map<string, string>();
  let outstanding = wanted;

  for (const lot of ordered) {
    if (outstanding.lessThanOrEqualTo(0)) break;
    const remaining = dec(lot.remainingQuantity);
    if (remaining.lessThanOrEqualTo(0)) continue;

    const take = Decimal.min(remaining, outstanding);
    allocations.push({
      lotId: lot.lotId,
      quantity: take.toFixed(),
      costPerUnit: lot.costPerUnit,
    });
    consumed.set(lot.lotId, remaining.minus(take).toFixed());
    outstanding = outstanding.minus(take);
  }

  const updatedLots = lots.map((lot) => {
    const remaining = consumed.get(lot.lotId);
    return remaining === undefined ? lot : { ...lot, remainingQuantity: remaining };
  });

  return Ok({ allocations, updatedLots });
}

/**
 * The exact inverse of {@link allocateFifo}: puts back the units a disposal took.
 *
 * Driven by the disposal's own allocations rather than by re-running FIFO
 * backwards. FIFO would return the units to the OLDEST lots, which is not
 * necessarily where they came from once several exits have been recorded, and a
 * lot that gets back units it never gave up carries the wrong acquisition date —
 * which is what long-term versus short-term turns on.
 *
 * Refused rather than clamped when a lot would end up holding more than it ever
 * acquired. That can only mean the allocations no longer describe this book — a
 * corporate action rescaled the lots, say — and silently capping the restore
 * would leave a holding whose quantity nothing downstream could tell was wrong.
 */
export function restoreAllocations(
  lots: readonly AcquisitionLot[],
  allocations: readonly LotAllocation[],
): Result<readonly AcquisitionLot[]> {
  const returned = new Map<string, Decimal>();
  for (const allocation of allocations) {
    const lot = lots.find((candidate) => candidate.lotId === allocation.lotId);
    if (lot === undefined) {
      return Err(
        new InsufficientQuantityError(
          `cannot restore ${allocation.quantity} units to lot ${allocation.lotId}: it is no longer on the book`,
        ),
      );
    }
    returned.set(
      allocation.lotId,
      (returned.get(allocation.lotId) ?? new Decimal(0)).plus(dec(allocation.quantity)),
    );
  }

  const restored: AcquisitionLot[] = [];
  for (const lot of lots) {
    const back = returned.get(lot.lotId);
    if (back === undefined) {
      restored.push(lot);
      continue;
    }
    const remaining = dec(lot.remainingQuantity).plus(back);
    if (remaining.greaterThan(dec(lot.quantity))) {
      return Err(
        new InsufficientQuantityError(
          `restoring ${back.toFixed()} units to lot ${lot.lotId} would leave ${remaining.toFixed()} of an original ${lot.quantity}`,
        ),
      );
    }
    restored.push({ ...lot, remainingQuantity: remaining.toFixed() });
  }

  return Ok(restored);
}
