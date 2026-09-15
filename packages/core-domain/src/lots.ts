/**
 * Acquisition lots and lot identification (US-1.2, US-1.3, PRD FR-1.2).
 *
 * ## Two matching methods, and when each applies
 *
 * FIFO is the right default, but it is NOT a universal rule — an earlier version
 * of this comment claimed it was, which overstated the position.
 *
 * FIFO for shares comes from CBDT Circular No. 768 (1998), which addresses
 * securities held in DEMATERIALISED form with a depository. Its rationale is
 * fungibility: once shares sit in a demat account they have no individual
 * identity, so a convention is needed to decide which ones left. That reasoning
 * is sound, and FIFO is what this applies to domestic demat holdings.
 *
 * It does not obviously extend to shares in a foreign stock-plan account. Those
 * are not demat securities under the Depositories Act, and their identity is not
 * lost: the plan administrator tracks every share to its grant and release and
 * states, on the statement it issues, exactly which tranche a given sale came
 * out of. Where identity is preserved and evidenced, specific identification is
 * the more defensible reading — and matching such a sale FIFO produces a figure
 * the taxpayer cannot reconcile to their own broker statement.
 *
 * The concrete case: a sell-to-cover sold on vest day, matched FIFO, consumes
 * the OLDEST lot held rather than the vest it funded. In real data that turned a
 * few dollars of intraday movement into a five-figure rupee gain against a lot
 * bought five years earlier — an artefact of discarding the lot reference the
 * source supplied, not a tax outcome.
 *
 * So: `allocateSpecific` where the source names the lot, `allocateFifo`
 * otherwise. Which one was used is recorded on the disposal, because a filed
 * figure should say which convention produced it.
 *
 * **Specific identification for foreign stock-plan shares is a defensible
 * position, not settled authority.** It is recorded rather than assumed.
 *
 * An oversell mutates nothing under either method: a partially-applied exit
 * would silently corrupt every later gain calculation.
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
    ...(input.equityAward ? { equityAward: input.equityAward } : {}),
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

  /*
   * Read from the AWARD, not from the asset class.
   *
   * RSU and ESPP stopped being asset classes when they were folded into
   * FOREIGN_EQUITY — a share received as an RSU and one bought outright are the
   * same security and belong in one FIFO pool. What differs is the acquisition,
   * and that now travels on the lot.
   */
  const kind = input.equityAward?.kind;

  // Nothing was paid, so the whole fair market value at vest is the perquisite.
  if (kind === 'RSU' || kind === 'PSU' || kind === 'RSA') {
    return input.fmvPerUnit ?? input.pricePerUnit;
  }
  // Something WAS paid: only the discount to fair market value is a perquisite.
  if (kind === 'ESPP' || kind === 'ESOP') {
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
      /*
       * Carried from the lot, and load-bearing rather than informational.
       *
       * Rule 115 converts the cost leg at the month-end BEFORE the units were
       * acquired, and this is the only place that date survives into the
       * disposal. Without it `capital-gains.rule115Legs` falls back to the exit's
       * own date and converts cost at the SALE month's rate — which silently
       * collapses the two-date conversion into a one-date one and erases the
       * rupee movement between vest and sale. For a lot vested at ₹73 to the
       * dollar and sold at ₹94 that is most of the taxable gain.
       */
      acquisitionDate: lot.acquisitionDate,
      // Likewise: grandfathering is decided per lot, and the disposal cannot
      // look the lot up again once allocated.
      ...(lot.grandfatheredFmv === undefined ? {} : { grandfatheredFmv: lot.grandfatheredFmv }),
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
 * Allocates against the ONE lot the source named.
 *
 * For a disposal whose origin is documented — a stock-plan sale that states its
 * grant and vest date — this reproduces what the broker's own statement says,
 * rather than re-deriving a different answer from a convention meant for
 * fungible demat holdings.
 *
 * Refuses rather than part-fills. A named lot that cannot cover the sale means
 * the ledger's picture of that tranche disagrees with the source — typically
 * because some of its history has not been imported — and quietly taking the
 * rest from elsewhere would bury that. The caller falls back to FIFO explicitly
 * and records that it did.
 */
export function allocateSpecific(
  lots: readonly AcquisitionLot[],
  lotId: string,
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

  const lot = lots.find((candidate) => candidate.lotId === lotId);
  if (lot === undefined) {
    return Err(
      new InsufficientQuantityError(`lot ${lotId} is not held; cannot match this sale to it`),
    );
  }

  const remaining = dec(lot.remainingQuantity);
  if (remaining.lessThan(wanted)) {
    return Err(
      new InsufficientQuantityError(
        `lot ${lotId} holds ${remaining.toFixed()} units; the sale is for ${wanted.toFixed()}`,
      ),
    );
  }

  return Ok({
    allocations: [
      {
        lotId: lot.lotId,
        quantity: wanted.toFixed(),
        costPerUnit: lot.costPerUnit,
        // Carried for the same reason FIFO carries it: Rule 115 converts the
        // cost leg at the month-end before THIS lot was acquired.
        acquisitionDate: lot.acquisitionDate,
        ...(lot.grandfatheredFmv === undefined ? {} : { grandfatheredFmv: lot.grandfatheredFmv }),
      },
    ],
    updatedLots: lots.map((candidate) =>
      candidate.lotId === lotId
        ? { ...candidate, remainingQuantity: remaining.minus(wanted).toFixed() }
        : candidate,
    ),
  });
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
