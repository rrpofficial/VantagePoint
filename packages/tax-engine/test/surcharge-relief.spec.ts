/**
 * US-5.4 — Old vs New regime slab computation (PRD FR-5.1)
 * US-5.5 — Surcharge, marginal relief and cess (PRD FR-5.1)
 * US-5.6 — HNI classification (ADR-004)
 * US-5.12 — Tax computation explainability trace
 */
import { describe, it, expect } from 'vitest';
import {
  HniClassifier,
  SlabCalculator,
  SurchargeCalculator,
  TaxRuleTable,
  type IncomeProfile,
} from '@vantagepoint/tax-engine';
import { expectMoney, expectOk, inr } from '@vantagepoint/test-kit';

const RULES = () => expectOk(TaxRuleTable.rulesFor('2025-26'));

const income = (overrides: Partial<IncomeProfile> = {}): IncomeProfile => ({
  financialYear: '2025-26',
  assessmentYear: '2026-27',
  grossSalary: inr('12000000'),
  exemptAllowances: inr('0'),
  chapterViaDeductions: inr('150000'),
  housePropertyIncome: inr('0'),
  otherSourcesIncome: inr('0'),
  tdsRemitted: inr('0'),
  tcsCollected: inr('0'),
  ...overrides,
});

describe('US-5.4 regime comparison', () => {
  describe('Scenario: Both regimes are computed and the cheaper one is recommended', () => {
    it('reports a liability under both regimes', () => {
      const comparison = SlabCalculator.compare(
        income({ chapterViaDeductions: inr('200000') }),
        RULES(),
      );
      expect(Number(comparison.old.totalLiability.amount)).toBeGreaterThan(0);
      expect(Number(comparison.new.totalLiability.amount)).toBeGreaterThan(0);
    });

    it('flags the regime with the lower total liability as recommended', () => {
      const c = SlabCalculator.compare(income(), RULES());
      const cheaper =
        Number(c.old.totalLiability.amount) <= Number(c.new.totalLiability.amount)
          ? 'OLD_REGIME'
          : 'NEW_REGIME';
      expect(c.recommended).toBe(cheaper);
    });

    it('lists the deductions forgone under the new regime', () => {
      const c = SlabCalculator.compare(income(), RULES());
      expect(c.deductionsForgone.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario: Standard deduction differs by regime', () => {
    it('applies a different standard deduction under each regime', () => {
      const rules = RULES();
      expect(Number(rules.standardDeduction.OLD_REGIME.amount)).not.toBe(
        Number(rules.standardDeduction.NEW_REGIME.amount),
      );
    });

    it('does not apply chapter VI-A deductions under the new regime', () => {
      const withDeductions = SlabCalculator.compute(
        income({ chapterViaDeductions: inr('150000') }),
        'NEW_REGIME',
        RULES(),
      );
      const without = SlabCalculator.compute(
        income({ chapterViaDeductions: inr('0') }),
        'NEW_REGIME',
        RULES(),
      );
      expectMoney(withDeductions.totalLiability, without.totalLiability);
    });
  });
});

describe('US-5.5 surcharge, marginal relief and cess', () => {
  describe('Scenario: Surcharge bands apply at the mandated thresholds (FR-5.1)', () => {
    /**
     * Incomes chosen to sit clear of the marginal-relief zone. The original
     * ₹51,00,000 was wrong: relief genuinely applies just above a threshold
     * (the zone runs to roughly ₹51.96 lakh), so asserting an unrelieved
     * surcharge there contradicted the relief scenario below.
     */
    it.each([
      ['6000000', 10],
      ['12000000', 15],
      ['25000000', 25],
    ])('applies %s%% surcharge above the matching threshold', (totalIncome, expectedPct) => {
      const { surcharge, total } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr(totalIncome),
        rules: RULES(),
      });
      expect(Number(surcharge.amount)).toBeCloseTo(1000000 * (expectedPct / 100), 0);
      expect(Number(total.amount)).toBeGreaterThan(Number(surcharge.amount));
    });

    it('applies 4% health and education cess on tax plus surcharge', () => {
      const { surcharge, cess } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('6000000'),
        rules: RULES(),
      });
      expect(Number(cess.amount)).toBeCloseTo((1000000 + Number(surcharge.amount)) * 0.04, 2);
    });

    it('applies no surcharge below ₹50 lakh', () => {
      const { surcharge } = SurchargeCalculator.apply({
        baseTax: inr('500000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('4000000'),
        rules: RULES(),
      });
      expectMoney(surcharge, inr('0'));
    });
  });

  describe('Scenario: Marginal relief caps the surcharge cliff', () => {
    it('grants relief at ₹50,10,000, just over the ₹50 lakh threshold', () => {
      const { marginalRelief } = SurchargeCalculator.apply({
        baseTax: inr('1315000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('5010000'),
        rules: RULES(),
      });
      expect(Number(marginalRelief.amount)).toBeGreaterThan(0);
    });

    it('ensures incremental tax never exceeds incremental income at the threshold', () => {
      const below = SurchargeCalculator.apply({
        baseTax: inr('1312500'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('5000000'),
        rules: RULES(),
      });
      const above = SurchargeCalculator.apply({
        baseTax: inr('1315000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('5010000'),
        rules: RULES(),
      });
      const incrementalTax = Number(above.total.amount) - Number(below.total.amount);
      expect(incrementalTax).toBeLessThanOrEqual(10000);
    });

    it('itemises the relief amount in the computation trace (US-5.12)', () => {
      const { trace } = SurchargeCalculator.apply({
        baseTax: inr('1315000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('5010000'),
        rules: RULES(),
      });
      expect(trace.some((line) => line.label.toLowerCase().includes('marginal relief'))).toBe(true);
    });
  });

  describe('Scenario: Surcharge on capital gains is capped at 15%', () => {
    it('caps the capital gains component at 15% when income exceeds ₹2 crore', () => {
      const { trace } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('1000000'),
        totalIncome: inr('25000000'),
        rules: RULES(),
      });
      const cgLine = trace.find((l) => l.ruleRef.includes('surchargeCapOnCapitalGains'));
      expect(cgLine).toBeDefined();
      expect(Number(cgLine?.amount.amount)).toBeCloseTo(150000, 0);
    });

    it('applies the uncapped rate to the non-capital-gains income', () => {
      const { surcharge } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('1000000'),
        totalIncome: inr('25000000'),
        rules: RULES(),
      });
      expect(Number(surcharge.amount)).toBeGreaterThan(300000);
    });
  });

  describe('US-5.12: trace line items sum exactly to the reported total', () => {
    it('reconciles the trace against the total', () => {
      const { trace, total } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('6000000'),
        rules: RULES(),
      });
      const sum = trace.reduce((t, l) => t + Number(l.amount.amount), 0);
      expect(sum).toBe(Number(total.amount));
    });

    it('names a rule reference on every trace line', () => {
      const { trace } = SurchargeCalculator.apply({
        baseTax: inr('1000000'),
        capitalGainsTax: inr('0'),
        totalIncome: inr('6000000'),
        rules: RULES(),
      });
      expect(trace.every((l) => l.ruleRef.length > 0)).toBe(true);
    });
  });
});

describe('US-5.6 HNI classification (ADR-004)', () => {
  describe('Scenario: HNI flag is set on either the income or the net worth test', () => {
    it('flags HNI on income of ₹60 lakh with modest net worth', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('6000000'),
        netWorth: inr('40000000'),
        rules: RULES(),
      });
      expect(result.isHni).toBe(true);
      expect(result.reason).toBe('INCOME_ABOVE_50L');
    });

    it('flags HNI on net worth of ₹12 crore with modest income', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('3000000'),
        netWorth: inr('120000000'),
        rules: RULES(),
      });
      expect(result.isHni).toBe(true);
      expect(result.reason).toBe('NET_WORTH_ABOVE_10CR');
    });

    it('does not flag HNI below both thresholds', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('3000000'),
        netWorth: inr('40000000'),
        rules: RULES(),
      });
      expect(result.isHni).toBe(false);
      expect(result.reason).toBe('NOT_HNI');
    });

    it('does not use the ₹1 crore portfolio figure from the persona prose (ADR-004)', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('3000000'),
        netWorth: inr('15000000'),
        rules: RULES(),
      });
      expect(result.isHni).toBe(false);
    });
  });

  describe('Scenario: HNI status enables the Schedule AL requirement', () => {
    it('marks Schedule AL required when income exceeds ₹50 lakh', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('6000000'),
        netWorth: inr('40000000'),
        rules: RULES(),
      });
      expect(result.scheduleAlRequired).toBe(true);
    });

    it('does not require Schedule AL on the net-worth test alone', () => {
      const result = HniClassifier.classify({
        totalIncome: inr('3000000'),
        netWorth: inr('120000000'),
        rules: RULES(),
      });
      expect(result.scheduleAlRequired).toBe(false);
    });
  });
});
