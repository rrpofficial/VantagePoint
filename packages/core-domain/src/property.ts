/**
 * Immovable property — area, duties, and how they map onto a lot.
 *
 * Property was previously recorded through the instrument shape: `quantity` was
 * hard-coded to `'1'`, `costPerUnit` held the WHOLE price (so a per-square-foot
 * rate could not be expressed at all), the property's name went into `symbol` —
 * a ticker field — and the duties were split across `fees` and `otherCharges`
 * with nothing recording which was which.
 *
 * That last part was not merely untidy. The importer wrote stamp duty into
 * `otherCharges` and the registration fee into `fees`, while the screen read
 * `stt` as "Stamp duty" — a field nothing ever set for property, because STT is
 * a *securities* transaction tax and cannot arise on land. Every property showed
 * ₹0 stamp duty and its real stamp duty inside a column labelled
 * "Registration & other".
 *
 * ## The mapping
 *
 * The canonical money fields stay canonical — `totalCostBasis`, the capital
 * gains engine and Schedule AL all read them and none of them change. This
 * module is the single place that decides what goes where:
 *
 *   quantity      area.value, or '1' when no area is stated
 *   costPerUnit   pricePerAreaUnit, or the whole consideration when quantity is 1
 *   fees          registrationFee + brokerage
 *   stt           0, always
 *   otherCharges  stampDuty + gst + otherTaxes
 *
 * Deriving rather than storing the totals is deliberate: a `totalTax` column
 * that can disagree with its parts will eventually disagree with its parts.
 */
import { Money, type Money as MoneyValue } from '@porttrack/shared-kernel';
import { Decimal } from 'decimal.js';
import type { Area, AreaUnit, PropertyKind, PropertyTransaction } from './types.js';

/** Every property kind, for a picker. Ordered as a user would scan them. */
export const PROPERTY_KINDS: readonly PropertyKind[] = [
  'FLAT',
  'APARTMENT',
  'INDEPENDENT_HOUSE',
  'VILLA',
  'PLOT',
  'LAND',
  'AGRICULTURAL_LAND',
  'COMMERCIAL',
  'SHOP',
  'OFFICE',
  'WAREHOUSE',
  'INDUSTRIAL',
  'PARKING',
  'OTHER',
];

/**
 * Square feet per unit, for display only.
 *
 * EXACT for the metric and imperial units. The regional units are the
 * conventional values and are NOT exact everywhere — a bigha varies by state
 * (and sometimes by district), and katha, biswa and guntha follow it. They are
 * here so a screen can offer a comparable figure, and they must never be used to
 * convert a stored area: what the deed said is what is stored.
 */
const SQ_FT_PER_UNIT: Readonly<Record<AreaUnit, string>> = {
  SQ_FT: '1',
  SQ_M: '10.76391041671',
  SQ_YARD: '9',
  SQ_KM: '10763910.41671',
  ACRE: '43560',
  HECTARE: '107639.1041671',
  ARE: '1076.391041671',
  CENT: '435.6',
  GUNTHA: '1089',
  GROUND: '2400',
  AANKADAM: '72',
  BIGHA: '27000',
  BISWA: '1350',
  KATHA: '720',
  DECIMAL: '435.6',
  KANAL: '5445',
  MARLA: '272.25',
  ROOD: '10890',
  PERCH: '272.25',
};

/** Units whose square-foot equivalent is conventional rather than defined. */
const APPROXIMATE: ReadonlySet<AreaUnit> = new Set<AreaUnit>([
  'BIGHA',
  'BISWA',
  'KATHA',
  'GUNTHA',
  'GROUND',
  'AANKADAM',
  'CENT',
  'DECIMAL',
]);

export const AREA_UNITS = Object.keys(SQ_FT_PER_UNIT) as readonly AreaUnit[];

/** Whether a unit's conversion is conventional, so a screen can say so. */
export function isApproximateUnit(unit: AreaUnit): boolean {
  return APPROXIMATE.has(unit);
}

/**
 * Area in square feet, for comparison across deeds that used different units.
 *
 * Never write the result back onto a stored area. For an approximate unit the
 * answer carries the regional ambiguity described above, which is tolerable on
 * screen and not tolerable in a cost basis.
 */
export function toSquareFeet(area: Area): string {
  return new Decimal(area.value).times(SQ_FT_PER_UNIT[area.unit]).toFixed(2);
}

const UNIT_LABELS: Readonly<Record<AreaUnit, string>> = {
  SQ_FT: 'sq ft',
  SQ_M: 'sq m',
  SQ_YARD: 'sq yd',
  SQ_KM: 'sq km',
  ACRE: 'acre',
  HECTARE: 'hectare',
  ARE: 'are',
  CENT: 'cent',
  GUNTHA: 'guntha',
  GROUND: 'ground',
  AANKADAM: 'aankadam',
  BIGHA: 'bigha',
  BISWA: 'biswa',
  KATHA: 'katha',
  DECIMAL: 'decimal',
  KANAL: 'kanal',
  MARLA: 'marla',
  ROOD: 'rood',
  PERCH: 'perch',
};

export function areaUnitLabel(unit: AreaUnit): string {
  return UNIT_LABELS[unit];
}

export function formatArea(area: Area): string {
  return `${area.value} ${areaUnitLabel(area.unit)}`;
}

/**
 * Every tax and duty on the transaction.
 *
 * Derived, never stored. This is the "total tax" a deed summary quotes, and it
 * is the sum of its parts by construction rather than by a column that has to be
 * kept in step with them.
 */
export function totalTaxOf(txn: PropertyTransaction): MoneyValue {
  return Money.sum(
    [txn.stampDuty, txn.registrationFee, txn.gst, txn.otherTaxes],
    txn.consideration.currency,
  );
}

/** Consideration plus every duty, fee and commission — what actually left the bank. */
export function totalOutlayOf(txn: PropertyTransaction): MoneyValue {
  const currency = txn.consideration.currency;
  return Money.sum(
    [txn.consideration, totalTaxOf(txn), txn.brokerage ?? Money.zero(currency)],
    currency,
  );
}

/**
 * The canonical lot fields this transaction implies.
 *
 * One function so the mapping exists once. An importer, a manual entry form and
 * a migration all reach for it, and three copies of "stamp duty goes in
 * otherCharges" is how the original defect got in.
 */
export function propertyChargesOf(txn: PropertyTransaction): {
  quantity: string;
  costPerUnit: MoneyValue;
  fees: MoneyValue;
  stt: MoneyValue;
  otherCharges: MoneyValue;
} {
  const currency = txn.consideration.currency;
  const zero = Money.zero(currency);

  // Area drives quantity where it is known, so `quantity × costPerUnit` reads as
  // "2400 sq ft at ₹8,500" instead of "1 at ₹2,04,00,000". A zero area is
  // treated as no area: dividing the price by it would produce Infinity.
  const area =
    txn.area !== undefined && new Decimal(txn.area.value).greaterThan(0) ? txn.area : undefined;
  const quantity = area?.value ?? '1';

  const costPerUnit =
    txn.pricePerAreaUnit ??
    (area === undefined
      ? txn.consideration
      : Money.of(new Decimal(txn.consideration.amount).dividedBy(quantity).toFixed(), currency));

  return {
    quantity,
    costPerUnit,
    fees: Money.sum([txn.registrationFee, txn.brokerage ?? zero], currency),
    // Never stamp duty. See the module docstring.
    stt: zero,
    otherCharges: Money.sum([txn.stampDuty, txn.gst, txn.otherTaxes], currency),
  };
}

/**
 * Whether the stated consideration agrees with area × rate.
 *
 * A deed states all three and they can disagree — rounding, a negotiated figure,
 * or a typo in one of them. Reported rather than silently corrected: which of the
 * three is wrong is not something this can know, and overwriting the price with a
 * computed one would change the cost basis on a guess.
 */
export function considerationMismatch(
  txn: PropertyTransaction,
): { stated: MoneyValue; computed: MoneyValue } | undefined {
  if (txn.area === undefined || txn.pricePerAreaUnit === undefined) return undefined;

  const computed = Money.round(
    Money.multiply(txn.pricePerAreaUnit, txn.area.value),
    2,
    'HALF_UP',
  );
  // A rupee either way is rounding in the deed, not a discrepancy worth raising.
  const difference = new Decimal(computed.amount).minus(txn.consideration.amount).abs();
  if (difference.lessThanOrEqualTo(1)) return undefined;

  return { stated: txn.consideration, computed };
}

/**
 * The s.50C / s.56(2)(x) shortfall: stamp duty value above the price paid.
 *
 * Surfaced because it is taxable and invisible otherwise — s.50C substitutes the
 * stamp duty value for the seller's consideration, and s.56(2)(x) charges the
 * difference as the buyer's income from other sources. Neither engine consumes
 * this yet; it is reported so the user knows the exposure exists.
 */
export function stampDutyShortfall(txn: PropertyTransaction): MoneyValue | undefined {
  if (txn.stampDutyValue === undefined) return undefined;
  if (Money.compare(txn.stampDutyValue, txn.consideration) <= 0) return undefined;
  return Money.subtract(txn.stampDutyValue, txn.consideration);
}
