/**
 * Slab tax and regime comparison (US-5.4, PRD FR-5.1).
 *
 * Both regimes are always computed. The new regime forgoes chapter VI-A
 * deductions and carries its own standard deduction, so which one wins depends
 * entirely on the taxpayer's deductions — there is no universally cheaper answer,
 * and presenting only one would silently cost the user money.
 */
import { Money, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { IncomeProfile, RegimeComparison, TaxComputation, TaxRegime, TaxRuleSet, TraceLine } from './types.js';

const INR = 'INR' as const;

/** Deductions the new regime gives up, surfaced so the choice is explainable. */
const FORGONE_UNDER_NEW_REGIME: readonly string[] = [
  'Chapter VI-A deductions (80C, 80D, 80CCD(1B), …)',
  'House rent allowance exemption',
  'Leave travel allowance exemption',
];

export function taxableIncome(
  income: IncomeProfile,
  regime: TaxRegime,
  rules: TaxRuleSet,
): MoneyValue {
  const gross = Money.sum(
    [income.grossSalary, income.housePropertyIncome, income.otherSourcesIncome],
    INR,
  );
  const afterExempt = Money.subtract(gross, income.exemptAllowances);
  const afterStandard = Money.subtract(afterExempt, rules.standardDeduction[regime]);
  // The new regime forgoes chapter VI-A entirely — passing deductions in must
  // not change its answer, which is exactly what the acceptance criteria check.
  const chapterVia = regime === 'OLD_REGIME' ? income.chapterViaDeductions : Money.zero(INR);
  const taxable = Money.subtract(afterStandard, chapterVia);
  return Money.compare(taxable, Money.zero(INR)) < 0 ? Money.zero(INR) : taxable;
}

/** Progressive slab tax on an amount, with a trace line per band consumed. */
export function slabTax(
  amount: MoneyValue,
  regime: TaxRegime,
  rules: TaxRuleSet,
): { tax: MoneyValue; trace: TraceLine[] } {
  const bands = rules.slabs[regime];
  const total = new Decimal(amount.amount);
  let consumed = new Decimal(0);
  let tax = new Decimal(0);
  const trace: TraceLine[] = [];

  for (const [index, band] of bands.entries()) {
    const ceiling = band.upTo === null ? total : Decimal.min(total, new Decimal(band.upTo));
    const slice = ceiling.minus(consumed);
    if (slice.lessThanOrEqualTo(0)) continue;

    const bandTax = slice.times(new Decimal(band.ratePct)).dividedBy(100);
    tax = tax.plus(bandTax);
    consumed = ceiling;

    trace.push({
      label: `Slab ${String(index + 1)} @ ${band.ratePct}%`,
      ruleRef: `FY${rules.financialYear}.slabs.${regime}[${String(index)}]`,
      inputs: { slice: slice.toFixed(2), ratePct: band.ratePct },
      amount: Money.round(Money.of(bandTax.toFixed(), INR), 2, 'HALF_UP'),
    });

    if (consumed.greaterThanOrEqualTo(total)) break;
  }

  return { tax: Money.round(Money.of(tax.toFixed(), INR), 2, 'HALF_UP'), trace };
}

/** Marginal rate of the highest band reached — used to derive tax at a threshold. */
export function topMarginalRatePct(regime: TaxRegime, rules: TaxRuleSet): string {
  const bands = rules.slabs[regime];
  return bands[bands.length - 1]?.ratePct ?? '0';
}

export function compute(
  income: IncomeProfile,
  regime: TaxRegime,
  rules: TaxRuleSet,
): TaxComputation {
  const taxable = taxableIncome(income, regime, rules);
  const { tax, trace } = slabTax(taxable, regime, rules);

  const cess = Money.round(
    Money.multiply(tax, new Decimal(rules.cessPct).dividedBy(100).toFixed()),
    2,
    'HALF_UP',
  );
  const totalLiability = Money.add(tax, cess);

  return {
    regime,
    totalIncome: taxable,
    baseTax: tax,
    capitalGainsTax: Money.zero(INR),
    surcharge: Money.zero(INR),
    marginalRelief: Money.zero(INR),
    cess,
    totalLiability,
    trace: [
      ...trace,
      {
        label: 'Health & education cess',
        ruleRef: `FY${rules.financialYear}.cessPct`,
        inputs: { base: tax.amount, ratePct: rules.cessPct },
        amount: cess,
      },
    ],
  };
}

export function compare(income: IncomeProfile, rules: TaxRuleSet): RegimeComparison {
  const oldRegime = compute(income, 'OLD_REGIME', rules);
  const newRegime = compute(income, 'NEW_REGIME', rules);
  const recommended: TaxRegime =
    Money.compare(oldRegime.totalLiability, newRegime.totalLiability) <= 0
      ? 'OLD_REGIME'
      : 'NEW_REGIME';

  return {
    old: oldRegime,
    new: newRegime,
    recommended,
    deductionsForgone: FORGONE_UNDER_NEW_REGIME,
  };
}
