/**
 * Recording immovable property by hand.
 *
 * Routed through `LedgerProjector`, exactly as `TradeUC.record` is and for the
 * same reason: a hand-typed sale must deplete its lot and produce the same
 * disposal the capital-gains engine reads. Writing a lot straight to the
 * repository would be a second set of rules to keep in step, and tax is where
 * the divergence would surface.
 *
 * The caller supplies the DEED's figures — area, rate, consideration, each duty
 * separately. `propertyChargesOf` turns those into the canonical lot fields, so
 * the mapping from "stamp duty" to a cost-basis column exists in one place
 * rather than being re-decided here.
 */
import {
  Err,
  Money,
  Ok,
  VaultStateError,
  type Currency,
  type IsoDate,
  type Money as MoneyValue,
  type Result,
} from '@vantagepoint/shared-kernel';
import {
  considerationMismatch,
  propertyChargesOf,
  stampDutyShortfall,
  type Area,
  type ImmovableProperty,
  type PropertyKind,
  type PropertyTransaction,
  type ValuationBasis,
} from '@vantagepoint/core-domain';
import { createHash } from 'node:crypto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PropertyValueInput {
  readonly amount: string;
  readonly asOf: IsoDate;
  readonly basis: ValuationBasis;
  readonly notes?: string;
}

export interface RecordPropertyInput {
  readonly side: 'BUY' | 'SELL';
  readonly transactionDate: IsoDate;
  readonly propertyName: string;
  readonly kind: PropertyKind;
  readonly currency?: Currency;

  /** Total price for this transaction, before duties. Indian digits accepted. */
  readonly consideration: string;
  /** Area transacted; both parts required together or omitted together. */
  readonly areaValue?: string;
  readonly areaUnit?: Area['unit'];
  readonly pricePerAreaUnit?: string;

  readonly stampDuty?: string;
  readonly registrationFee?: string;
  readonly gst?: string;
  readonly otherTaxes?: string;
  readonly brokerage?: string;
  /** The sub-registrar's assessed value, where it differs from the price paid. */
  readonly stampDutyValue?: string;

  readonly address?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly country?: string;
  readonly registrationNumber?: string;
  readonly surveyNumber?: string;
  readonly documentRef?: string;
  readonly notes?: string;

  /** Optional, and never carried as the asset's value. */
  readonly currentValue?: PropertyValueInput;

  /** The user has seen the matching entry and says this is a separate one. */
  readonly confirmDuplicate?: boolean;
}

/** Facts worth telling the user about, none of which block the write. */
export interface PropertyAdvisory {
  readonly code: 'CONSIDERATION_MISMATCH' | 'STAMP_DUTY_SHORTFALL';
  readonly message: string;
}

export interface RecordPropertyResult {
  readonly assetId: string;
  readonly advisories: readonly PropertyAdvisory[];
}

/**
 * An address identifies a household, so it follows the borrower-name rule
 * (ADR-013): the plain value stays in the vault and this deterministic digest is
 * what any export or AI payload carries. Deterministic so the same address
 * resolves to the same reference across entries rather than fragmenting one
 * property into several.
 */
export function addressRefOf(address: string): string {
  return `addr_${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Parsed, never trusted: `1,00,00,000` is exactly how a deed figure is typed. */
function parseMoney(value: string | undefined, currency: Currency): Result<MoneyValue> {
  if (value === undefined || value.trim().length === 0) return Ok(Money.zero(currency));
  return Money.parse(value, currency);
}

/**
 * Validates the input and assembles the two domain records.
 *
 * Separated from the use case so it can be tested without a vault, and so the
 * API layer and any future importer share one definition of what a valid
 * property entry is.
 */
export function buildPropertyEntry(input: RecordPropertyInput): Result<{
  property: ImmovableProperty;
  transaction: PropertyTransaction;
  charges: ReturnType<typeof propertyChargesOf>;
  advisories: readonly PropertyAdvisory[];
}> {
  const currency = input.currency ?? 'INR';

  if (!ISO_DATE.test(input.transactionDate)) {
    return Err(new VaultStateError('a property transaction needs a date, as YYYY-MM-DD'));
  }
  if (input.propertyName.trim().length === 0) {
    return Err(new VaultStateError('a property needs a name'));
  }

  const consideration = Money.parse(input.consideration, currency);
  if (!consideration.ok) return consideration;
  if (Money.compare(consideration.value, Money.zero(currency)) <= 0) {
    return Err(new VaultStateError('the consideration must be greater than zero'));
  }

  // Both halves of an area or neither: a bare number with no unit cannot be
  // compared with anything, and a unit with no number states nothing.
  const hasAreaValue = input.areaValue !== undefined && input.areaValue.trim().length > 0;
  if (hasAreaValue !== (input.areaUnit !== undefined)) {
    return Err(
      new VaultStateError('an area needs both a measurement and a unit, or neither'),
    );
  }

  let area: Area | undefined;
  if (input.areaValue !== undefined && input.areaUnit !== undefined && hasAreaValue) {
    // Money.parse is reused purely as a decimal parser; the currency is discarded.
    const parsed = Money.parse(input.areaValue, currency);
    if (!parsed.ok) return Err(new VaultStateError('an area must be a number'));
    if (Money.compare(parsed.value, Money.zero(currency)) <= 0) {
      return Err(new VaultStateError('an area must be greater than zero'));
    }
    area = { value: parsed.value.amount, unit: input.areaUnit };
  }

  const duties = {
    stampDuty: parseMoney(input.stampDuty, currency),
    registrationFee: parseMoney(input.registrationFee, currency),
    gst: parseMoney(input.gst, currency),
    otherTaxes: parseMoney(input.otherTaxes, currency),
  };
  for (const parsed of Object.values(duties)) {
    if (!parsed.ok) return parsed;
  }

  const optional = (value: string | undefined): Result<MoneyValue | undefined> => {
    if (value === undefined || value.trim().length === 0) return Ok(undefined);
    const parsed = Money.parse(value, currency);
    return parsed.ok ? Ok(parsed.value) : parsed;
  };

  const brokerage = optional(input.brokerage);
  if (!brokerage.ok) return brokerage;
  const rate = optional(input.pricePerAreaUnit);
  if (!rate.ok) return rate;
  const stampDutyValue = optional(input.stampDutyValue);
  if (!stampDutyValue.ok) return stampDutyValue;

  const transaction: PropertyTransaction = {
    ...(area === undefined ? {} : { area }),
    ...(rate.value === undefined ? {} : { pricePerAreaUnit: rate.value }),
    consideration: consideration.value,
    stampDuty: duties.stampDuty.ok ? duties.stampDuty.value : Money.zero(currency),
    registrationFee: duties.registrationFee.ok
      ? duties.registrationFee.value
      : Money.zero(currency),
    gst: duties.gst.ok ? duties.gst.value : Money.zero(currency),
    otherTaxes: duties.otherTaxes.ok ? duties.otherTaxes.value : Money.zero(currency),
    ...(brokerage.value === undefined ? {} : { brokerage: brokerage.value }),
    ...(stampDutyValue.value === undefined ? {} : { stampDutyValue: stampDutyValue.value }),
    ...(input.documentRef === undefined || input.documentRef.trim().length === 0
      ? {}
      : { documentRef: input.documentRef.trim() }),
  };

  let currentValue: ImmovableProperty['currentValue'];
  if (input.currentValue !== undefined) {
    const amount = Money.parse(input.currentValue.amount, currency);
    if (!amount.ok) return amount;
    if (!ISO_DATE.test(input.currentValue.asOf)) {
      return Err(
        new VaultStateError('a current value needs the date it was assessed, as YYYY-MM-DD'),
      );
    }
    currentValue = {
      amount: amount.value,
      asOf: input.currentValue.asOf,
      basis: input.currentValue.basis,
      ...(input.currentValue.notes === undefined ? {} : { notes: input.currentValue.notes }),
    };
  }

  const address = input.address?.trim();
  const hasLocation =
    (address !== undefined && address.length > 0) ||
    input.city !== undefined ||
    input.state !== undefined ||
    input.pincode !== undefined;

  const property: ImmovableProperty = {
    // Filled in by the projector, which owns asset identity.
    assetId: '',
    propertyName: input.propertyName.trim(),
    kind: input.kind,
    ...(hasLocation
      ? {
          location: {
            addressRef: address === undefined || address.length === 0 ? '' : addressRefOf(address),
            ...(address === undefined || address.length === 0 ? {} : { address }),
            ...(input.city === undefined ? {} : { city: input.city }),
            ...(input.state === undefined ? {} : { state: input.state }),
            ...(input.pincode === undefined ? {} : { pincode: input.pincode }),
            ...(input.country === undefined ? {} : { country: input.country }),
          },
        }
      : {}),
    ...(area === undefined ? {} : { area }),
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(input.registrationNumber === undefined
      ? {}
      : { registrationNumber: input.registrationNumber }),
    ...(input.surveyNumber === undefined ? {} : { surveyNumber: input.surveyNumber }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };

  /*
   * Reported, never corrected. Which of area, rate and price is the wrong one is
   * not knowable here, and silently recomputing the consideration would change a
   * cost basis on a guess.
   */
  const advisories: PropertyAdvisory[] = [];
  const mismatch = considerationMismatch(transaction);
  if (mismatch !== undefined) {
    advisories.push({
      code: 'CONSIDERATION_MISMATCH',
      message:
        `area × rate comes to ${mismatch.computed.amount} but the consideration is stated as ` +
        `${mismatch.stated.amount}. The stated figure has been used; check which is right.`,
    });
  }
  const shortfall = stampDutyShortfall(transaction);
  if (shortfall !== undefined) {
    advisories.push({
      code: 'STAMP_DUTY_SHORTFALL',
      message:
        `the stamp duty value exceeds the price paid by ${shortfall.amount}. On a sale s.50C ` +
        'substitutes the higher figure for the consideration; on a purchase s.56(2)(x) charges ' +
        'the difference as income from other sources. Neither is computed here.',
    });
  }

  return Ok({ property, transaction, charges: propertyChargesOf(transaction), advisories });
}
