/**
 * Surcharge, marginal relief and cess (US-5.5, PRD FR-5.1).
 *
 * Two behaviours here are easy to get wrong and expensive when wrong:
 *
 *  1. **Marginal relief.** Surcharge is a cliff — cross ₹50 lakh by one rupee and
 *     10% applies to the whole tax. Relief caps the increase so additional income
 *     is never taxed at more than 100%. Omitting it overstates the liability for
 *     everyone in the band just above each threshold.
 *  2. **The capital gains surcharge cap.** Surcharge on the capital gains portion
 *     is capped at 15% even when other income pushes the taxpayer into the 25%
 *     band. Applying the headline rate to the whole tax overcharges anyone with
 *     both a high salary and realised gains.
 */
import { Money, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { SurchargeInput, SurchargeResult, TaxRuleSet, TraceLine } from './types.js';

const INR = 'INR' as const;
const money = (value: Decimal): MoneyValue =>
  Money.round(Money.of(value.toFixed(), INR), 2, 'HALF_UP');

/** Highest surcharge band whose threshold the income exceeds. */
function bandFor(totalIncome: Decimal, rules: TaxRuleSet): { ratePct: Decimal; above: Decimal } | undefined {
  let matched: { ratePct: Decimal; above: Decimal } | undefined;
  for (const band of rules.surchargeBands) {
    const above = new Decimal(band.above);
    if (totalIncome.greaterThan(above)) {
      if (matched === undefined || above.greaterThan(matched.above)) {
        matched = { ratePct: new Decimal(band.ratePct), above };
      }
    }
  }
  return matched;
}

export function apply(input: SurchargeInput): SurchargeResult {
  const { rules } = input;
  const baseTax = new Decimal(input.baseTax.amount);
  const cgTax = new Decimal(input.capitalGainsTax.amount);
  const totalIncome = new Decimal(input.totalIncome.amount);
  const taxBeforeSurcharge = baseTax.plus(cgTax);

  const trace: TraceLine[] = [
    {
      label: 'Tax on income',
      ruleRef: `FY${rules.financialYear}.slabs`,
      inputs: { totalIncome: totalIncome.toFixed(2) },
      amount: input.baseTax,
    },
  ];
  if (cgTax.greaterThan(0)) {
    trace.push({
      label: 'Tax on capital gains',
      ruleRef: `FY${rules.financialYear}.capitalGains`,
      inputs: {},
      amount: input.capitalGainsTax,
    });
  }

  const band = bandFor(totalIncome, rules);
  let surcharge = new Decimal(0);

  if (band !== undefined) {
    const cap = new Decimal(rules.surchargeCapOnCapitalGainsPct);
    const cgRate = Decimal.min(band.ratePct, cap);

    const surchargeOnOther = baseTax.times(band.ratePct).dividedBy(100);
    const surchargeOnCg = cgTax.times(cgRate).dividedBy(100);
    surcharge = surchargeOnOther.plus(surchargeOnCg);

    trace.push({
      label: `Surcharge @ ${band.ratePct.toFixed()}%`,
      ruleRef: `FY${rules.financialYear}.surchargeBands.above_${band.above.toFixed()}`,
      inputs: { base: baseTax.toFixed(2), ratePct: band.ratePct.toFixed() },
      amount: money(surchargeOnOther),
    });

    if (cgTax.greaterThan(0)) {
      trace.push({
        label: `Surcharge on capital gains @ ${cgRate.toFixed()}% (capped)`,
        ruleRef: `FY${rules.financialYear}.surchargeCapOnCapitalGainsPct`,
        inputs: { base: cgTax.toFixed(2), cappedAtPct: cap.toFixed() },
        amount: money(surchargeOnCg),
      });
    }
  }

  /*
   * Marginal relief. Needs the tax that WOULD be due at exactly the threshold.
   * A caller that computed the slab tax knows it and should pass it; otherwise it
   * is derived by unwinding the excess income at the top marginal rate, which is
   * exact whenever the threshold and the income sit in the same slab — true for
   * every surcharge threshold under both regimes.
   */
  let marginalRelief = new Decimal(0);
  if (band !== undefined) {
    const excess = totalIncome.minus(band.above);
    const taxAtThreshold =
      input.taxAtThreshold === undefined
        ? Decimal.max(
            0,
            baseTax.minus(excess.times(new Decimal(input.topMarginalRatePct ?? '30')).dividedBy(100)),
          )
        : new Decimal(input.taxAtThreshold.amount);

    const payableWithSurcharge = taxBeforeSurcharge.plus(surcharge);
    const ceiling = taxAtThreshold.plus(excess);
    if (payableWithSurcharge.greaterThan(ceiling)) {
      marginalRelief = Decimal.min(surcharge, payableWithSurcharge.minus(ceiling));
    }
  }

  if (marginalRelief.greaterThan(0)) {
    trace.push({
      label: 'Marginal relief',
      ruleRef: `FY${rules.financialYear}.marginalRelief`,
      inputs: { threshold: band?.above.toFixed() ?? '', surcharge: surcharge.toFixed(2) },
      amount: money(marginalRelief.negated()),
    });
  }

  const surchargeAfterRelief = surcharge.minus(marginalRelief);
  const cess = taxBeforeSurcharge
    .plus(surchargeAfterRelief)
    .times(new Decimal(rules.cessPct))
    .dividedBy(100);

  trace.push({
    label: 'Health & education cess',
    ruleRef: `FY${rules.financialYear}.cessPct`,
    inputs: { ratePct: rules.cessPct },
    amount: money(cess),
  });

  const total = taxBeforeSurcharge.plus(surchargeAfterRelief).plus(cess);

  return {
    surcharge: money(surchargeAfterRelief),
    marginalRelief: money(marginalRelief),
    cess: money(cess),
    total: money(total),
    trace,
  };
}
