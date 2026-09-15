/**
 * Rate resolution: the fallback chain (US-2.3), Rule 115 (US-2.4) and the dual-rate
 * service (US-2.5, ADR-003).
 *
 * ADR-003 in one place: a foreign transaction produces TWO INR amounts.
 *   valuationRate — the ITBR on the trade date, used for portfolio display.
 *   taxRate       — the Rule 115 rate (last day of the PRECEDING month), used for
 *                   every taxable-income computation.
 * They differ, and collapsing them satisfies one PRD clause while violating another.
 */
import {
  Err,
  Money,
  Ok,
  RateUnavailableError,
  type Currency,
  type IsoDate,
  type Money as MoneyValue,
  type Result,
} from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { DualRate, RateSource } from '@vantagepoint/core-domain';
import { rateStore } from './rate-store.js';
import type { ResolvedRate } from './types.js';

/** Priority order mandated by FR-2.1. */
export const FALLBACK_ORDER: readonly RateSource[] = [
  'SBI_ITBR',
  'RBI_REFERENCE',
  'ECB',
  'OANDA',
];

export const FALLBACK_FLAG = 'Rate Source: RBI Fallback (Pending SBI ITBR Finalization)';

/** How far back to walk for a published rate before giving up. */
const MAX_LOOKBACK_DAYS = 40;

function minusDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolves a rate for `date`.
 *
 * Sources are tried in priority order **for each date** before walking back a day.
 * The alternative — exhausting SBI across all history first — would prefer an SBI
 * rate from a fortnight earlier over an RBI rate for the requested day, which is
 * the opposite of what FR-2.1 asks for on a bank holiday.
 */
export function resolveWithFallback(currency: Currency, date: IsoDate): Result<ResolvedRate> {
  for (let offset = 0; offset <= MAX_LOOKBACK_DAYS; offset++) {
    const candidate = minusDays(date, offset);
    for (const [index, source] of FALLBACK_ORDER.entries()) {
      const record = rateStore.get(currency, candidate, source);
      if (record === undefined) continue;

      return Ok({
        rate: record.rate,
        source,
        appliedDate: record.date,
        isFallback: source !== 'SBI_ITBR' || offset > 0,
        // The priority prefix actually consulted, for audit.
        resolutionPath: FALLBACK_ORDER.slice(0, index + 1),
        ...(source === 'RBI_REFERENCE' ? { flag: FALLBACK_FLAG } : {}),
      });
    }
  }

  // Never substitute 1.0 or a rate from another currency.
  return Err(
    new RateUnavailableError(
      `no ${currency}/INR rate available for ${date} from any source ` +
        `(tried ${FALLBACK_ORDER.join(', ')} back ${String(MAX_LOOKBACK_DAYS)} days)`,
    ),
  );
}

/** Last day of the month preceding `transactionDate` (Rule 115). */
export function rule115BasisDate(transactionDate: IsoDate): IsoDate {
  const year = Number(transactionDate.slice(0, 4));
  const month = Number(transactionDate.slice(5, 7));
  // Day 0 of the current month is the last day of the previous one.
  const basis = new Date(Date.UTC(year, month - 1, 0));
  return basis.toISOString().slice(0, 10);
}

export function resolveRule115(currency: Currency, transactionDate: IsoDate): Result<ResolvedRate> {
  const basisDate = rule115BasisDate(transactionDate);
  const resolved = resolveWithFallback(currency, basisDate);
  if (!resolved.ok) return resolved;
  return Ok({ ...resolved.value, resolutionPath: [`rule115:${basisDate}`, ...resolved.value.resolutionPath] });
}

/** Resolves both rates for one transaction (ADR-003). */
export function ratesFor(currency: Currency, transactionDate: IsoDate): Result<DualRate> {
  const valuation = resolveWithFallback(currency, transactionDate);
  if (!valuation.ok) return valuation;

  const tax = resolveRule115(currency, transactionDate);
  if (!tax.ok) return tax;

  return Ok({
    valuationRate: valuation.value.rate,
    taxRate: tax.value.rate,
    valuationRateSource: valuation.value.source,
    taxRateSource: tax.value.source,
    isFallback: valuation.value.isFallback || tax.value.isFallback,
    ...(valuation.value.flag ? { fallbackNote: valuation.value.flag } : {}),
  });
}

export function convert(
  amount: MoneyValue,
  rates: DualRate,
): { readonly valuationInr: MoneyValue; readonly taxableInr: MoneyValue } {
  const at = (rate: string) =>
    Money.round(
      Money.of(new Decimal(amount.amount).times(rate).toFixed(), 'INR'),
      2,
      'HALF_UP',
    );
  return { valuationInr: at(rates.valuationRate), taxableInr: at(rates.taxRate) };
}
