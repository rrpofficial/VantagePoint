/**
 * Quarterly advance tax (US-5.10, PRD FR-5.3).
 *
 * Each instalment is CUMULATIVE — 15%, 45%, 75%, 100% of the estimated annual
 * liability — against which TDS and everything already paid are credited. Treating
 * them as four independent quarters underpays every instalment after the first.
 *
 * A realised gain counts only if it occurred on or before the quarter's cutoff.
 * Including a December gain in the 15-December instalment would demand tax on
 * income the taxpayer had not yet earned at the due date.
 */
import { FyCalendar, Money, Ok, type Money as MoneyValue, type Result } from '@porttrack/shared-kernel';
import { Decimal } from 'decimal.js';
import type { ExitTransaction } from '@porttrack/core-domain';
import { compute as computeCapitalGains } from './capital-gains.js';
import { compute as computeSlabTax } from './slabs.js';
import { apply as applySurcharge } from './surcharge.js';
import { topMarginalRatePct } from './slabs.js';
import type { AdvanceTaxInput, AdvanceTaxInstallment, TraceLine } from './types.js';

const INR = 'INR' as const;

export function installment(input: AdvanceTaxInput): Result<AdvanceTaxInstallment> {
  const { financialYear, quarter, income, rules } = input;
  const dueDate = FyCalendar.advanceTaxDueDate(financialYear, quarter);
  const cumulativePercentage = FyCalendar.cumulativePercentage(quarter);

  // Only gains realised by the due date are in scope for this instalment.
  const realisedByCutoff = input.exits.filter((exit: ExitTransaction) => exit.exitDate <= dueDate);
  const capitalGains = computeCapitalGains(
    realisedByCutoff,
    input.assetClasses,
    rules,
    input.includeSellToCover === undefined
      ? {}
      : { includeSellToCover: input.includeSellToCover },
  );

  const regime = input.regime ?? 'NEW_REGIME';
  const slab = computeSlabTax(income, regime, rules);

  const totalIncome = Money.add(slab.totalIncome, capitalGains.taxableStcg);
  const surcharge = applySurcharge({
    baseTax: slab.baseTax,
    capitalGainsTax: capitalGains.tax,
    totalIncome,
    rules,
    topMarginalRatePct: topMarginalRatePct(regime, rules),
  });

  const totalLiability = surcharge.total;
  const cumulativeRequired = Money.round(
    Money.multiply(totalLiability, new Decimal(cumulativePercentage).dividedBy(100).toFixed()),
    2,
    'HALF_UP',
  );

  const tdsCredit = Money.add(income.tdsRemitted, income.tcsCollected);
  const outstanding = new Decimal(cumulativeRequired.amount)
    .minus(tdsCredit.amount)
    .minus(input.alreadyPaid.amount);

  // Section 288B: tax payable rounds to the nearest ₹10. Never negative — an
  // over-credit is a refund at assessment, not a negative instalment.
  const netPayable = Money.roundToNearestTen(
    Money.of(Decimal.max(0, outstanding).toFixed(), INR),
  );

  const trace: readonly TraceLine[] = [
    ...slab.trace,
    ...surcharge.trace,
    {
      label: `Cumulative requirement at ${quarter}`,
      ruleRef: `advanceTax.${quarter}.cumulativePercentage`,
      inputs: { percentage: cumulativePercentage, totalLiability: totalLiability.amount },
      amount: cumulativeRequired,
    },
    {
      label: 'Less: TDS / TCS credited',
      ruleRef: 'advanceTax.tdsCredit',
      inputs: {},
      amount: Money.negate(tdsCredit),
    },
    {
      label: 'Less: advance tax already paid',
      ruleRef: 'advanceTax.alreadyPaid',
      inputs: {},
      amount: Money.negate(input.alreadyPaid),
    },
  ];

  return Ok({
    quarter,
    dueDate,
    cumulativePercentage,
    totalLiability,
    cumulativeRequired,
    tdsCredit,
    alreadyPaid: input.alreadyPaid,
    netPayable,
    capitalGains,
    trace,
  });
}

/** Convenience: every quarter of a year, so the schedule can be shown at once. */
export function schedule(
  input: Omit<AdvanceTaxInput, 'quarter'>,
): Result<readonly AdvanceTaxInstallment[]> {
  const installments: AdvanceTaxInstallment[] = [];
  let paid: MoneyValue = input.alreadyPaid;

  for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4'] as const) {
    const result = installment({ ...input, quarter, alreadyPaid: paid });
    if (!result.ok) return result;
    installments.push(result.value);
    paid = Money.add(paid, result.value.netPayable);
  }
  return Ok(installments);
}
