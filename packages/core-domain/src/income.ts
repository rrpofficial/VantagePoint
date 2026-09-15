/**
 * Dividend and interest events (US-1.5, PRD FR-1.2).
 *
 * Withholding is expressed two ways depending on origin: foreign dividends quote a
 * treaty rate (W-8BEN), domestic ones an absolute TDS figure. Only foreign
 * withholding is eligible for a foreign tax credit — domestic TDS is a prepayment
 * of the same liability, and treating it as a credit would double-count it.
 */
import { Err, InvalidAmountError, Money, Ok, type Result } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { IncomeEvent, RecordDividendInput, RecordInterestInput } from './types.js';

let eventCounter = 0;
const nextId = () => `inc_${String(++eventCounter).padStart(6, '0')}`;

function resolveWithholding(
  gross: IncomeEvent['grossAmount'],
  ratePct: string | undefined,
  absolute: IncomeEvent['taxWithheld'] | undefined,
): Result<IncomeEvent['taxWithheld']> {
  if (absolute !== undefined) {
    if (absolute.currency !== gross.currency) {
      return Err(new InvalidAmountError('withheld tax must be in the same currency as the gross'));
    }
    return Ok(absolute);
  }
  if (ratePct !== undefined) {
    const rate = new Decimal(ratePct).dividedBy(100);
    return Ok(
      Money.round(Money.multiply(gross, rate.toFixed()), 2, 'HALF_UP'),
    );
  }
  return Ok(Money.zero(gross.currency));
}

export function recordDividend(input: RecordDividendInput): Result<IncomeEvent> {
  const isForeign = input.withholdingRatePct !== undefined;
  const withheld = resolveWithholding(input.grossAmount, input.withholdingRatePct, input.taxWithheld);
  if (!withheld.ok) return withheld;

  return Ok({
    eventId: nextId(),
    assetId: input.assetId,
    kind: isForeign ? 'DIVIDEND_FOREIGN' : 'DIVIDEND_DOMESTIC',
    date: input.date,
    grossAmount: input.grossAmount,
    taxWithheld: withheld.value,
    netAmount: Money.subtract(input.grossAmount, withheld.value),
    ...(input.withholdingRatePct === undefined
      ? {}
      : { withholdingRatePct: input.withholdingRatePct }),
    eligibleForForeignTaxCredit: isForeign,
  });
}

export function recordInterest(input: RecordInterestInput): Result<IncomeEvent> {
  const withheld = resolveWithholding(input.grossAmount, undefined, input.taxWithheld);
  if (!withheld.ok) return withheld;

  return Ok({
    eventId: nextId(),
    assetId: input.assetId,
    kind: 'INTEREST',
    date: input.date,
    grossAmount: input.grossAmount,
    taxWithheld: withheld.value,
    netAmount: Money.subtract(input.grossAmount, withheld.value),
    eligibleForForeignTaxCredit: false,
  });
}
