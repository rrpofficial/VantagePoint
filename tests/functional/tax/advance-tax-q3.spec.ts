/**
 * FUNCTIONAL — drives the system through `app-services`, not through internals (DoD D3).
 *
 * US-5.10 Advance tax Q3 with capital gains (PRD FR-5 AC)
 * US-5.4  Regime comparison
 * US-5.6  HNI classification
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputeAdvanceTaxUC, setIncomeProfile, VaultUC } from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectOk, inr } from '@vantagepoint/test-kit';

describe('FUNCTIONAL US-5.10 — advance tax Q3', () => {
  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vantagepoint-func-'));
    expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
    expectOk(await VaultUC.unlock('correct horse battery staple'));

    // "A user with estimated salary income in the 30% slab" (PRD FR-5 AC).
    // Advance tax without a recorded income is meaningless, so the scenario
    // must state it rather than assume a default.
    setIncomeProfile({
      financialYear: '2025-26',
      assessmentYear: '2026-27',
      grossSalary: inr('12000000'),
      exemptAllowances: inr('0'),
      chapterViaDeductions: inr('0'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr('0'),
      tdsRemitted: inr('1850000'),
      tcsCollected: inr('0'),
    });
  });

  describe('Scenario: Advance tax calculation for Q3 with capital gains (PRD FR-5 AC)', () => {
    it('returns a Q3 installment due 2025-12-15', async () => {
      const inst = expectOk(
        await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter: 'Q3' }),
      );
      expect(inst.quarter).toBe('Q3');
      expect(inst.dueDate).toBe('2025-12-15');
    });

    it('computes the cumulative requirement at 75% of the annual liability', async () => {
      const inst = expectOk(
        await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter: 'Q3' }),
      );
      expect(Number(inst.cumulativePercentage)).toBe(75);
    });

    it('deducts the employer TDS from the Form 16 projection', async () => {
      const inst = expectOk(
        await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter: 'Q3' }),
      );
      expect(Number(inst.tdsCredit.amount)).toBeGreaterThan(0);
    });

    it('displays an exact net payable, rounded to the nearest ₹10', async () => {
      const inst = expectOk(
        await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter: 'Q3' }),
      );
      expect(Number(inst.netPayable.amount) % 10).toBe(0);
    });

    it('never returns a negative payable', async () => {
      const inst = expectOk(
        await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter: 'Q3' }),
      );
      expect(Number(inst.netPayable.amount)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario: The four quarters are cumulative and monotonic', () => {
    it('produces non-decreasing cumulative requirements across Q1 to Q4', async () => {
      const amounts: number[] = [];
      for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4'] as const) {
        const inst = expectOk(
          await ComputeAdvanceTaxUC.execute({ financialYear: '2025-26', quarter }),
        );
        amounts.push(Number(inst.cumulativeRequired.amount));
      }
      expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    });
  });

  describe('US-5.4 / US-5.6 through the same use-case surface', () => {
    it('recommends a regime', async () => {
      const comparison = expectOk(await ComputeAdvanceTaxUC.compareRegimes('2025-26'));
      expect(['OLD_REGIME', 'NEW_REGIME']).toContain(comparison.recommended);
    });

    it('classifies HNI status for the year', async () => {
      const hni = expectOk(await ComputeAdvanceTaxUC.hniStatus('2025-26'));
      expect(typeof hni.isHni).toBe('boolean');
      expect(['INCOME_ABOVE_50L', 'NET_WORTH_ABOVE_10CR', 'NOT_HNI']).toContain(hni.reason);
    });
  });

  describe('TaxRulesUnavailable propagates rather than silently defaulting', () => {
    it('fails for a financial year with no rule set', async () => {
      const result = await ComputeAdvanceTaxUC.execute({ financialYear: '2030-31', quarter: 'Q1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('TAX_RULES_UNAVAILABLE');
    });
  });
});
