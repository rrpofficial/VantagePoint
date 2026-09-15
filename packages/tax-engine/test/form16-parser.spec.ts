/**
 * US-5.3 — Form 16 (Part A & B) parser and manual income entry (PRD FR-5.1)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Form16Parser, SlabCalculator, TaxRuleTable, type IncomeProfile } from '@vantagepoint/tax-engine';
import { expectMoney, expectNoPii, expectOk, inr } from '@vantagepoint/test-kit';

const FIXTURES = resolve(import.meta.dirname, '../../../tests/fixtures/form16');
const load = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const partB = () => expectOk(Form16Parser.parse(load('form16-partb.txt')));

describe('US-5.3 Scenario: Form 16 Part B yields gross salary, deductions and TDS', () => {
  it('extracts gross salary', () => {
    expectMoney(partB().partB.grossSalary, inr('12000000'));
  });

  it('extracts exempt allowances', () => {
    expectMoney(partB().partB.exemptAllowances, inr('240000'));
  });

  it('extracts total chapter VI-A deductions', () => {
    expectMoney(partB().partB.chapterViaDeductions, inr('175000'));
  });

  it('extracts total TDS deducted', () => {
    expectMoney(partB().partB.totalTds, inr('1850000'));
  });

  it('stores PAN and TAN as opaque references, never in the clear', () => {
    const form = partB();
    expect(form.partA.panRef).toMatch(/^pan_[0-9a-f]{12}$/);
    expect(form.partA.tanRef).toMatch(/^tan_[0-9a-f]{12}$/);
    expectNoPii(JSON.stringify(form));
  });

  it('rejects a document that is not a Form 16', () => {
    const result = Form16Parser.parse(new TextEncoder().encode('a grocery receipt'));
    expect(result.ok).toBe(false);
  });
});

describe('US-5.3 Scenario: Part A TDS totals reconcile against Part B', () => {
  it('reconciles a consistent certificate', () => {
    const partA = expectOk(Form16Parser.parse(load('form16-parta.txt')));
    expectOk(Form16Parser.reconcile(partA));
  });

  it('sums the four quarters to the stated total', () => {
    const partA = expectOk(Form16Parser.parse(load('form16-parta.txt')));
    expect(partA.partA.quarterlyTds).toHaveLength(4);
    expectMoney(partA.partA.totalTds, inr('1850000'));
  });

  it('fails when Part A and Part B disagree on total TDS', () => {
    const mismatch = expectOk(Form16Parser.parse(load('form16-mismatch.txt')));
    const result = Form16Parser.reconcile(mismatch);
    expect(result.ok).toBe(false);
  });

  it('names both figures so the discrepancy is actionable', () => {
    const mismatch = expectOk(Form16Parser.parse(load('form16-mismatch.txt')));
    const result = Form16Parser.reconcile(mismatch);
    // Part A totals ₹1,850,000; Part B states ₹1,840,000. Both figures are named
    // because only the taxpayer can find out which is right, and the advance tax
    // instalment depends on the answer.
    if (!result.ok) {
      expect(result.error.message).toContain('1850000');
      expect(result.error.message).toContain('1840000');
    }
  });

  it('leaks no PII in the reconciliation failure', () => {
    const mismatch = expectOk(Form16Parser.parse(load('form16-mismatch.txt')));
    const result = Form16Parser.reconcile(mismatch);
    if (!result.ok) expectNoPii(result.error.message);
  });
});

describe('US-5.3 Scenario: Manual income entry is accepted when no Form 16 exists', () => {
  const RULES = () => expectOk(TaxRuleTable.rulesFor('2025-26'));

  it('produces an income profile equivalent to a manual one', () => {
    const fromForm16 = Form16Parser.toIncomeProfile(partB(), '2025-26');
    const manual: IncomeProfile = {
      financialYear: '2025-26',
      assessmentYear: '2026-27',
      grossSalary: inr('12000000'),
      exemptAllowances: inr('240000'),
      chapterViaDeductions: inr('175000'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr('0'),
      tdsRemitted: inr('1850000'),
      tcsCollected: inr('0'),
    };
    expectMoney(
      SlabCalculator.compute(fromForm16, 'OLD_REGIME', RULES()).totalLiability,
      SlabCalculator.compute(manual, 'OLD_REGIME', RULES()).totalLiability,
    );
  });

  it('derives the assessment year from the financial year', () => {
    expect(Form16Parser.toIncomeProfile(partB(), '2025-26').assessmentYear).toBe('2026-27');
  });
});
