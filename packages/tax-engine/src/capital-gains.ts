/**
 * Capital gains classification and computation (US-5.7, US-5.8, PRD FR-5.2).
 *
 * Classification keys off holding period AND tax character — never the asset
 * class alone (ADR-016). A debt-oriented and an equity-oriented mutual fund share
 * an asset class and are taxed completely differently.
 *
 * Three rules that are individually easy to miss:
 *   • The ₹1.25 lakh LTCG exemption is ANNUAL, not per transaction.
 *   • Grandfathering substitutes the higher of cost and 31-Jan-2018 FMV, but caps
 *     the substitute at the sale price so it can never manufacture a loss.
 *   • Foreign gains are measured in INR at the Rule 115 rate, never the trade-date
 *     valuation rate (ADR-003) — using the latter taxes currency movement.
 */
import {
  Money,
  Ok,
  type Currency,
  type IsoDate,
  type Money as MoneyValue,
  type Result,
} from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import {
  days30360,
  taxCharacterOf,
  type AssetClass,
  type ExitTransaction,
  type TaxSubject,
} from '@vantagepoint/core-domain';
import { DualRateConverter, Rule115Resolver } from '@vantagepoint/fx-itbr';
import type {
  CapitalGainsOptions,
  CapitalGainsResult,
  ClassifiedGain,
  ExcludedDisposal,
  GainKind,
  TaxRuleSet,
  UnconvertibleGain,
} from './types.js';

const INR = 'INR' as const;
const money = (value: Decimal, currency: Currency = INR): MoneyValue =>
  Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');

/** Classes whose returns are slab-taxed however long they are held. */
const ALWAYS_SLAB: ReadonlySet<AssetClass> = new Set([
  'FIXED_DEPOSIT',
  'RECURRING_DEPOSIT',
  'HAND_LOAN',
  'CHIT_FUND',
  'BANK_BALANCE',
  'CASH_IN_HAND',
  'EPF',
  'VPF',
  'PPF',
  'NPS_TIER_I',
  'NPS_TIER_II',
  'GRATUITY',
]);

const EQUITY_STCG_CLASSES: ReadonlySet<AssetClass> = new Set(['DOMESTIC_EQUITY', 'DOMESTIC_ETF']);

const asSubject = (subject: AssetClass | TaxSubject): TaxSubject =>
  typeof subject === 'string' ? { assetClass: subject } : subject;

function acquisitionOf(exit: ExitTransaction): IsoDate {
  if (exit.acquisitionDate !== undefined) return exit.acquisitionDate;
  const dated = exit.allocations
    .map((allocation) => allocation.acquisitionDate)
    .filter((date): date is IsoDate => date !== undefined)
    .sort();
  // Oldest allocated lot governs, matching the FIFO order the exit consumed.
  return dated[0] ?? exit.exitDate;
}

export function classify(
  exit: ExitTransaction,
  subject: AssetClass | TaxSubject,
  rules: TaxRuleSet,
): ClassifiedGain {
  const target = asSubject(subject);
  const { assetClass } = target;
  const character = taxCharacterOf(target);
  const acquiredOn = acquisitionOf(exit);
  const days = days30360(acquiredOn, exit.exitDate);
  const months = days / 30;

  const base = {
    txnId: exit.txnId,
    assetClass,
    holdingPeriodDays: days,
    gain: money(new Decimal(exit.pricePerUnit.amount), exit.pricePerUnit.currency),
    ...(character === undefined ? {} : { taxCharacter: character }),
  };
  const emit = (kind: GainKind, ratePct: string): ClassifiedGain => ({ ...base, kind, ratePct });

  if (assetClass === 'CRYPTO') return emit('VDA_GAIN', rules.vdaRatePct);
  if (ALWAYS_SLAB.has(assetClass)) return emit('SLAB', 'SLAB');
  // Debt-oriented funds are slab-taxed however long they are held; an arbitrage
  // fund gets equity treatment despite behaving like cash (ADR-016).
  if (character === 'DEBT_ORIENTED') return emit('SLAB', 'SLAB');

  const threshold = rules.holdingPeriodMonths[assetClass] ?? 24;
  if (months <= threshold) {
    const equityLike = EQUITY_STCG_CLASSES.has(assetClass) || character === 'EQUITY_ORIENTED';
    return emit('STCG', equityLike ? rules.stcgListedEquityRatePct : 'SLAB');
  }
  return emit('LTCG', rules.ltcgRatePct);
}

/**
 * Cost of acquisition after grandfathering: the higher of actual cost and the
 * 31-Jan-2018 FMV, capped at the sale price so the substitution cannot create a
 * loss that never economically occurred.
 */
export function grandfatheredCost(
  actualCost: MoneyValue,
  fmv31Jan2018: MoneyValue | undefined,
  salePrice: MoneyValue,
): MoneyValue {
  if (fmv31Jan2018 === undefined) return actualCost;
  const higher = Money.compare(fmv31Jan2018, actualCost) > 0 ? fmv31Jan2018 : actualCost;
  return Money.compare(higher, salePrice) > 0 ? salePrice : higher;
}

/** Realised gain in the holding's own currency, before any INR conversion. */
function realisedGain(exit: ExitTransaction): MoneyValue {
  if (exit.allocations.length === 0) {
    // No lot detail: the exit amount IS the realised gain. This is the normal
    // shape for broker Tax P&L imports, which report net gain rather than lots.
    return exit.pricePerUnit;
  }
  const total = exit.allocations.reduce((sum, allocation) => {
    const cost = grandfatheredCost(
      allocation.costPerUnit,
      allocation.grandfatheredFmv,
      exit.pricePerUnit,
    );
    const perUnit = new Decimal(exit.pricePerUnit.amount).minus(cost.amount);
    return sum.plus(perUnit.times(allocation.quantity));
  }, new Decimal(0));
  return money(total, exit.pricePerUnit.currency);
}

/**
 * One leg converted to INR at the Rule 115 rate for ITS OWN date.
 *
 * `DualRateConverter.ratesFor` derives the tax rate from the last day of the
 * month preceding the date it is handed — so passing a vest date yields the
 * basis for the vest month, and passing a sale date yields the basis for the
 * sale month. That is the whole mechanism of the two-date conversion.
 */
function legToInr(amount: MoneyValue, onDate: IsoDate): Result<MoneyValue> {
  if (amount.currency === INR) return Ok(amount);
  const rates = DualRateConverter.ratesFor(amount.currency, onDate);
  if (!rates.ok) return rates;
  return Ok(DualRateConverter.convert(amount, rates.value).taxableInr);
}

/**
 * Both legs of a disposal in rupees, and the gain between them.
 *
 * This is the one implementation of the Rule 115 two-date conversion. The import
 * path stores what it returns and the engine reads it back, so there is no second
 * copy of the arithmetic to drift.
 */
export interface Rule115Legs {
  /** `sp$ × quantity`, at the rate for the month-end before the SALE. */
  readonly proceedsInr: MoneyValue;
  /** `Σ vp$ × quantity`, each at the rate for the month-end before ITS vest. */
  readonly costBasisInr: MoneyValue;
  /** `proceedsInr − costBasisInr`. The figure tax is charged on. */
  readonly gainInr: MoneyValue;
  /**
   * False when the source stated a net gain with no lot detail. The gain is
   * still right; `proceedsInr` then carries it against a zero cost, and the two
   * legs are not independently meaningful.
   */
  readonly legsSeparable: boolean;
}

/**
 * The taxable gain in INR, converting EACH LEG at its own Rule 115 basis date.
 *
 * Cost is converted at the last day of the month preceding acquisition; proceeds
 * at the last day of the month preceding transfer. The difference is the gain.
 *
 * This replaces converting a foreign-currency gain once, at the sale's rate. The
 * two are not the same, and the difference is real money: a lot vested when the
 * dollar bought ₹74 and sold when it bought ₹95 carries rupee appreciation that
 * a single conversion erases entirely. For an RSU the two-date figure is also
 * the one that reconciles with the salary already taxed — the perquisite was
 * assessed in rupees at vest, so measuring the gain from any other rupee cost
 * taxes the same money twice.
 *
 * Granular per ALLOCATION, not per exit: one sale order routinely consumes lots
 * from several vests, each with its own basis month. Converting the whole cost
 * at the oldest lot's rate would misprice every other lot in the order.
 */
export function rule115Legs(exit: ExitTransaction): Result<Rule115Legs> {
  if (exit.allocations.length === 0) {
    /*
     * Net-gain shape: the source reported a realised gain with no lot detail, so
     * there are no two legs to convert separately. The gain is still converted at
     * the sale month's basis, and `legsSeparable` says the split is not real —
     * rather than reporting a zero cost basis as though it had been measured.
     */
    const gain = legToInr(realisedGain(exit), exit.exitDate);
    if (!gain.ok) return gain;
    return Ok({
      proceedsInr: gain.value,
      costBasisInr: money(new Decimal(0)),
      gainInr: gain.value,
      legsSeparable: false,
    });
  }

  const proceedsCurrency = exit.pricePerUnit.currency;
  let proceeds = new Decimal(0);
  let costInr = new Decimal(0);

  for (const allocation of exit.allocations) {
    proceeds = proceeds.plus(new Decimal(exit.pricePerUnit.amount).times(allocation.quantity));

    const perUnit = grandfatheredCost(
      allocation.costPerUnit,
      allocation.grandfatheredFmv,
      exit.pricePerUnit,
    );
    const cost = money(new Decimal(perUnit.amount).times(allocation.quantity), perUnit.currency);

    /*
     * Falls back to the exit's own acquisition date, then to the exit date. A lot
     * with no acquisition date cannot state its own basis month, and converting
     * it at the SALE's rate is the conservative reading — it reproduces the old
     * single-rate behaviour for that leg rather than inventing a date.
     */
    const acquiredOn = allocation.acquisitionDate ?? exit.acquisitionDate ?? exit.exitDate;
    const converted = legToInr(cost, acquiredOn);
    if (!converted.ok) return converted;
    costInr = costInr.plus(converted.value.amount);
  }

  const proceedsInr = legToInr(money(proceeds, proceedsCurrency), exit.exitDate);
  if (!proceedsInr.ok) return proceedsInr;

  return Ok({
    proceedsInr: proceedsInr.value,
    costBasisInr: money(costInr),
    gainInr: money(new Decimal(proceedsInr.value.amount).minus(costInr)),
    legsSeparable: true,
  });
}

function taxableGainInr(exit: ExitTransaction): Result<MoneyValue> {
  /*
   * A stored figure wins. The import path writes it from THIS function, so the
   * stored and recomputed values agree by construction; what the short-circuit
   * protects is a correction applied upstream, which must not be silently
   * recomputed away.
   */
  if (exit.taxableGainInr !== undefined) return Ok(exit.taxableGainInr);

  const legs = rule115Legs(exit);
  return legs.ok ? Ok(legs.value.gainInr) : legs;
}

/**
 * Whether a sell-to-cover's two legs take Rule 115 rates from DIFFERENT months.
 *
 * The case that makes excluding them material. Sold same-day in the same month,
 * both legs convert at one rate and the gain really is a rounding error. Vested
 * on a month's last day and sold on the next month's first, the two basis months
 * differ — and the taxable amount is then the whole proceeds times the rate
 * movement, not the few dollars of price movement.
 */
function straddlesBasisMonths(exit: ExitTransaction): boolean {
  const acquired = exit.allocations[0]?.acquisitionDate ?? exit.acquisitionDate;
  if (acquired === undefined) return false;
  return Rule115Resolver.basisDateFor(acquired) !== Rule115Resolver.basisDateFor(exit.exitDate);
}

export function compute(
  exits: readonly ExitTransaction[],
  subjects: Readonly<Record<string, AssetClass | TaxSubject>>,
  rules: TaxRuleSet,
  options: CapitalGainsOptions = {},
): CapitalGainsResult {
  const gains: ClassifiedGain[] = [];
  const unconvertible: UnconvertibleGain[] = [];
  const excludedSellToCover: ExcludedDisposal[] = [];

  for (const exit of exits) {
    // Keyed by transaction first: one asset can hold lots of differing character.
    const subject = subjects[exit.txnId] ?? subjects[exit.assetId];
    if (subject === undefined) continue;

    /*
     * Sell-to-cover, left out because the taxpayer has taken that position.
     *
     * Recorded in `excludedSellToCover` rather than skipped silently, and the
     * ones whose legs straddle a month boundary are marked: those are the ones
     * where "the gain is immaterial" stops being true, and the reader needs to
     * see them to know whether the position still holds.
     */
    if (exit.disposalKind === 'SELL_TO_COVER' && options.includeSellToCover !== true) {
      /*
       * The gain is computed even though it is not charged, because the size of
       * what is being left out is the whole question. Under FIFO a sell-to-cover
       * is matched to the OLDEST lot, not to the vest it nominally funds, so the
       * "same-day sale, negligible gain" reasoning routinely does not apply.
       */
      const excluded = taxableGainInr(exit);
      excludedSellToCover.push({
        txnId: exit.txnId,
        exitDate: exit.exitDate,
        ...(excluded.ok ? { gainInr: excluded.value } : {}),
        straddlesBasisMonths: straddlesBasisMonths(exit),
      });
      continue;
    }

    const classified = classify(exit, subject, rules);
    const gain = taxableGainInr(exit);

    /*
     * EXCLUDED from the totals and reported, never passed through.
     *
     * This path previously returned the foreign-currency figure unchanged, which
     * the sums below then added as though it were rupees — a USD 1,000 gain
     * became ₹1,000 and understated the tax by about 99%. A missing rate must
     * make the total visibly incomplete, not quietly wrong.
     */
    if (!gain.ok) {
      unconvertible.push({
        txnId: exit.txnId,
        currency: exit.pricePerUnit.currency,
        exitDate: exit.exitDate,
        reason: gain.error.message,
      });
      continue;
    }

    gains.push({ ...classified, gain: gain.value });
  }

  const sumOf = (kind: GainKind): Decimal =>
    gains
      .filter((gain) => gain.kind === kind)
      .reduce((total, gain) => total.plus(gain.gain.amount), new Decimal(0));

  const ltcgBefore = sumOf('LTCG');
  const exemptionApplied = Decimal.min(
    Decimal.max(0, ltcgBefore),
    new Decimal(rules.ltcgExemptionLimit.amount),
  );
  const taxableLtcg = Decimal.max(0, ltcgBefore.minus(exemptionApplied));
  const taxableStcg = sumOf('STCG');
  const vda = sumOf('VDA_GAIN');

  const tax = taxableLtcg
    .times(rules.ltcgRatePct)
    .dividedBy(100)
    .plus(taxableStcg.times(rules.stcgListedEquityRatePct).dividedBy(100))
    .plus(vda.times(rules.vdaRatePct).dividedBy(100));

  return {
    gains,
    ltcgBeforeExemption: money(ltcgBefore),
    ltcgExemptionApplied: money(exemptionApplied),
    taxableLtcg: money(taxableLtcg),
    taxableStcg: money(taxableStcg),
    tax: money(tax),
    unconvertible,
    excludedSellToCover,
  };
}
