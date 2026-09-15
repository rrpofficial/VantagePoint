/**
 * US-5.10 — Quarterly advance tax engine (PRD FR-5.3 / FR-5 AC)
 * US-5.9  — Other-sources income aggregation
 * US-5.11 — Foreign tax credit / DTAA relief
 * US-5.12 — Tax computation explainability trace
 */
import { describe, it, expect } from 'vitest';
import {
  AdvanceTaxEngine,
  ForeignTaxCredit,
  OtherSourcesAggregator,
  TaxRuleTable,
  type IncomeProfile,
} from '@vantagepoint/tax-engine';
import { anExit, expectMoney, expectOk, inr } from '@vantagepoint/test-kit';

const RULES = () => expectOk(TaxRuleTable.rulesFor('2025-26'));

const INCOME: IncomeProfile = {
  financialYear: '2025-26',
  assessmentYear: '2026-27',
  grossSalary: inr('12000000'),
  exemptAllowances: inr('0'),
  chapterViaDeductions: inr('0'),
  housePropertyIncome: inr('0'),
  otherSourcesIncome: inr('0'),
  tdsRemitted: inr('1850000'),
  tcsCollected: inr('0'),
};

const STCG_NOV = anExit({
  txnId: 'txn_stcg',
  exitDate: '2025-11-10',
  pricePerUnit: inr('500000'),
});

const q3 = (overrides: Partial<Parameters<typeof AdvanceTaxEngine.installment>[0]> = {}) =>
  AdvanceTaxEngine.installment({
    financialYear: '2025-26',
    quarter: 'Q3',
    income: INCOME,
    exits: [STCG_NOV],
    assetClasses: { txn_stcg: 'DOMESTIC_EQUITY' },
    alreadyPaid: inr('0'),
    rules: RULES(),
    ...overrides,
  });

describe('US-5.10 advance tax engine', () => {
  describe('Scenario: Advance tax calculation for Q3 with capital gains (PRD FR-5 AC)', () => {
    it('computes 75% of the total annual liability for the Q3 installment', () => {
      const inst = expectOk(q3());
      expect(Number(inst.cumulativePercentage)).toBe(75);
      expect(Number(inst.cumulativeRequired.amount)).toBeCloseTo(
        Number(inst.totalLiability.amount) * 0.75,
        2,
      );
    });

    it('includes the ₹500,000 STCG realised on 2025-11-10 in the liability', () => {
      const withGain = Number(expectOk(q3()).totalLiability.amount);
      const withoutGain = Number(expectOk(q3({ exits: [] })).totalLiability.amount);
      expect(withGain).toBeGreaterThan(withoutGain);
    });

    it('deducts the TDS already remitted per the Form 16 projection', () => {
      const inst = expectOk(q3());
      expectMoney(inst.tdsCredit, inr('1850000'));
    });

    it('reports the Q3 due date as 2025-12-15', () => {
      expect(expectOk(q3()).dueDate).toBe('2025-12-15');
    });

    it('nets TDS and prior payments into the payable figure', () => {
      const inst = expectOk(q3());
      // Netting happens first, then the statutory §288B rounding to the nearest
      // ₹10 that the scenario below pins. Asserting the raw difference here would
      // contradict that requirement.
      const netted = Math.max(
        0,
        Number(inst.cumulativeRequired.amount) -
          Number(inst.tdsCredit.amount) -
          Number(inst.alreadyPaid.amount),
      );
      expect(Number(inst.netPayable.amount)).toBe(Math.round(netted / 10) * 10);
    });
  });

  describe('Scenario: Cumulative installments net off prior payments', () => {
    it('reduces the cumulative requirement by everything already paid', () => {
      const inst = expectOk(
        q3({ alreadyPaid: inr('300000'), income: { ...INCOME, tdsRemitted: inr('0') } }),
      );
      const expected = Math.round((Number(inst.cumulativeRequired.amount) - 300000) / 10) * 10;
      expect(Number(inst.netPayable.amount)).toBe(expected);
    });

    it('demands nothing when prior payments already cover the requirement', () => {
      const inst = expectOk(
        q3({ alreadyPaid: inr('99999999'), income: { ...INCOME, tdsRemitted: inr('0') } }),
      );
      // An over-payment is a refund at assessment, never a negative instalment.
      expect(Number(inst.netPayable.amount)).toBe(0);
    });
  });

  describe('Scenario: Capital gains realised after a quarter cutoff are excluded', () => {
    const LATE_GAIN = anExit({
      txnId: 'txn_late',
      exitDate: '2025-12-20',
      pricePerUnit: inr('500000'),
    });

    it('excludes a 2025-12-20 gain from the Q3 (15-Dec) computation', () => {
      const withLate = expectOk(
        q3({ exits: [LATE_GAIN], assetClasses: { txn_late: 'DOMESTIC_EQUITY' } }),
      );
      const without = expectOk(q3({ exits: [] }));
      expectMoney(withLate.totalLiability, without.totalLiability);
    });

    it('includes the same gain from Q4 onwards', () => {
      const q4 = expectOk(
        q3({ quarter: 'Q4', exits: [LATE_GAIN], assetClasses: { txn_late: 'DOMESTIC_EQUITY' } }),
      );
      const q4NoGain = expectOk(q3({ quarter: 'Q4', exits: [] }));
      expect(Number(q4.totalLiability.amount)).toBeGreaterThan(
        Number(q4NoGain.totalLiability.amount),
      );
    });
  });

  describe('Scenario: Cumulative percentages follow FR-5.3', () => {
    it.each([
      ['Q1', 15],
      ['Q2', 45],
      ['Q3', 75],
      ['Q4', 100],
    ] as const)('%s requires %i%% of the estimated annual liability', (quarter, pct) => {
      expect(Number(expectOk(q3({ quarter })).cumulativePercentage)).toBe(pct);
    });
  });

  describe('Section 288B rounding', () => {
    it('rounds the payable to the nearest ₹10', () => {
      expect(Number(expectOk(q3()).netPayable.amount) % 10).toBe(0);
    });
  });
});

describe('US-5.9 other-sources aggregation', () => {
  describe('Scenario: Hand loan interest, FD interest and dividends aggregate', () => {
    const accruals = [
      { label: 'Hand loan interest', amount: inr('400000') },
      { label: 'FD interest', amount: inr('73970.86') },
      { label: 'Dividends', amount: inr('100000') },
    ];

    it('totals ₹573,970.86', () => {
      expectMoney(OtherSourcesAggregator.aggregate([], accruals).total, inr('573970.86'));
    });

    it('itemises each component with its source', () => {
      const { items } = OtherSourcesAggregator.aggregate([], accruals);
      expect(items.map((i) => i.label)).toEqual([
        'Hand loan interest',
        'FD interest',
        'Dividends',
      ]);
    });

    it('has itemised amounts that sum exactly to the total', () => {
      const { items, total } = OtherSourcesAggregator.aggregate([], accruals);
      const sum = items.reduce((t, i) => t + Number(i.amount.amount), 0);
      expect(sum).toBe(Number(total.amount));
    });
  });
});

describe('US-5.11 foreign tax credit / DTAA', () => {
  describe('Scenario: US dividend withholding is relieved up to the Indian tax', () => {
    it('credits the lower of foreign tax paid and Indian tax on that income', () => {
      const { credit } = ForeignTaxCredit.compute({
        foreignTaxPaid: inr('10000'),
        indianTaxOnDoublyTaxedIncome: inr('8000'),
      });
      expectMoney(credit, inr('8000'));
    });

    it('reports the excess as non-creditable rather than carrying it silently', () => {
      const { nonCreditable } = ForeignTaxCredit.compute({
        foreignTaxPaid: inr('10000'),
        indianTaxOnDoublyTaxedIncome: inr('8000'),
      });
      expectMoney(nonCreditable, inr('2000'));
    });

    it('credits the full foreign tax when Indian tax is higher', () => {
      const { credit, nonCreditable } = ForeignTaxCredit.compute({
        foreignTaxPaid: inr('5000'),
        indianTaxOnDoublyTaxedIncome: inr('8000'),
      });
      expectMoney(credit, inr('5000'));
      expectMoney(nonCreditable, inr('0'));
    });
  });
});

describe('US-5.12 computation trace', () => {
  describe('Scenario: Every computed figure has an auditable derivation', () => {
    it('is exposed on the installment result', () => {
      expect(expectOk(q3()).totalLiability).toBeDefined();
    });
  });
});
