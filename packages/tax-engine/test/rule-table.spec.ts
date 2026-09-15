/**
 * US-5.2 — Versioned tax rule table (ADR-005)
 *
 * Milestone M5. Split out of fy-calendar.spec.ts so the M1 calendar story can go
 * green independently of the FY rate data, which needs Finance Act verification.
 */
import { describe, it, expect } from 'vitest';
import { TaxRuleTable } from '@porttrack/tax-engine';
import { expectErr, expectOk } from '@porttrack/test-kit';

describe('US-5.2 versioned tax rule table (ADR-005)', () => {
  describe('Scenario: Rules are resolved by financial year', () => {
    it('returns the FY 2025-26 rule set for that year', () => {
      expect(expectOk(TaxRuleTable.rulesFor('2025-26')).financialYear).toBe('2025-26');
    });

    it('returns a different rule set for FY 2024-25', () => {
      expect(expectOk(TaxRuleTable.rulesFor('2024-25')).financialYear).toBe('2024-25');
    });
  });

  describe('Scenario: Missing rule set fails loudly', () => {
    it('fails with TAX_RULES_UNAVAILABLE for FY 2030-31', () => {
      expectErr(TaxRuleTable.rulesFor('2030-31'), 'TAX_RULES_UNAVAILABLE');
    });

    it('does not silently fall back to the most recent year', () => {
      const result = TaxRuleTable.rulesFor('2030-31');
      expect(result.ok).toBe(false);
    });
  });

  describe('ADR-005: rates live in data, not code', () => {
    it('exposes the ₹1.25 lakh LTCG exemption as rule data', () => {
      const rules = expectOk(TaxRuleTable.rulesFor('2025-26'));
      expect(Number(rules.ltcgExemptionLimit.amount)).toBe(125000);
    });

    it('exposes the HNI thresholds as rule data (ADR-004)', () => {
      const rules = expectOk(TaxRuleTable.rulesFor('2025-26'));
      expect(Number(rules.hniIncomeThreshold.amount)).toBe(5000000);
      expect(Number(rules.hniNetWorthThreshold.amount)).toBe(100000000);
    });

    it('exposes the 4% health and education cess as rule data', () => {
      expect(Number(expectOk(TaxRuleTable.rulesFor('2025-26')).cessPct)).toBe(4);
    });
  });
});

/*
 * Retargeted from FY 2025-26 to FY 2024-25 when 2025-26 was verified against the
 * Finance Bill 2026. The gate is what these pin, not the year — but the year has
 * to be one that is genuinely provisional, or they assert nothing. FY 2024-25 is
 * the honest example: its new-regime slab table is FY 2025-26's, carried back.
 */
describe('US-5.2 provisional rule sets (unverified rates)', () => {
  describe('Scenario: A provisional rule set computes but cannot be filed', () => {
    it('flags the bundled FY 2024-25 set as provisional', () => {
      expect(TaxRuleTable.isProvisional(expectOk(TaxRuleTable.rulesFor('2024-25')))).toBe(true);
    });

    it('still permits computation, so the product can be built and demonstrated', () => {
      expect(Number(expectOk(TaxRuleTable.rulesFor('2024-25')).cessPct)).toBe(4);
    });

    it('refuses to produce a filing artifact from unverified rates', () => {
      expectErr(
        TaxRuleTable.assertFilingReady(expectOk(TaxRuleTable.rulesFor('2024-25'))),
        'TAX_RULES_UNAVAILABLE',
      );
    });

    it('names the reason so the blocker is actionable', () => {
      const result = TaxRuleTable.assertFilingReady(expectOk(TaxRuleTable.rulesFor('2024-25')));
      if (!result.ok) {
        expect(result.error.message).toMatch(/PROVISIONAL/);
        expect(result.error.message).toMatch(/Finance Act/);
      }
    });

    it('carries a note naming the specific defect, not a generic warning', () => {
      const rules = expectOk(TaxRuleTable.rulesFor('2024-25'));
      // The note has to say WHAT is wrong: it is the banner text the user reads,
      // and "unverified" alone gives them nothing to act on.
      expect(rules.provisionalNote).toMatch(/FY 2025-26/);
      expect(rules.provisionalNote).toMatch(/Finance \(No\. 2\) Act 2024/);
    });

    it('allows filing once a rule set is marked verified', () => {
      const verified = { ...expectOk(TaxRuleTable.rulesFor('2024-25')), status: 'VERIFIED' as const };
      expectOk(TaxRuleTable.assertFilingReady(verified));
    });
  });

  describe('Scenario: A verified rule set is filing-ready', () => {
    /*
     * FY 2025-26, verified against the Finance Bill 2026 First Schedule Part I-A.
     * This is the other half of the gate: a status that never changes to VERIFIED
     * would make `assertFilingReady` a constant.
     */
    it('lets FY 2025-26 through the filing gate', () => {
      const rules = expectOk(TaxRuleTable.rulesFor('2025-26'));
      expect(TaxRuleTable.isProvisional(rules)).toBe(false);
      expectOk(TaxRuleTable.assertFilingReady(rules));
    });

    it('carries no provisional note, because there is nothing outstanding to flag', () => {
      expect(expectOk(TaxRuleTable.rulesFor('2025-26')).provisionalNote).toBeUndefined();
    });

    /*
     * The three figures read directly out of the Bill. If an edit ever moves one,
     * the citation in the rule file has become a lie and this is where it shows.
     */
    it('holds the surcharge bands the Bill gives the default regime', () => {
      const rules = expectOk(TaxRuleTable.rulesFor('2025-26'));

      // clause 2(4)(b), Table, Sl. No. 10 — s.115BAC(1A). Three bands; the 37%
      // in Paragraph F is excluded from this regime by clause 2(4)(a)(ii).
      expect(rules.surchargeBands.map((band) => band.ratePct)).toEqual(['10', '15', '25']);
      expect(rules.surchargeBands.map((band) => band.above)).toEqual([
        '5000000',
        '10000000',
        '20000000',
      ]);
      // clause 2(4)(b), Sl. No. 10, clause (v).
      expect(Number(rules.surchargeCapOnCapitalGainsPct)).toBe(15);
    });

    it('starts the default regime at the Bill’s ₹4,00,000 exemption', () => {
      // clause 2(2), Table, Sl. No. 4.
      const [first] = expectOk(TaxRuleTable.rulesFor('2025-26')).slabs.NEW_REGIME;
      expect(first?.upTo).toBe('400000');
      expect(Number(first?.ratePct)).toBe(0);
    });

    it('holds Part I-A Paragraph A(I) for the opt-out regime', () => {
      const old = expectOk(TaxRuleTable.rulesFor('2025-26')).slabs.OLD_REGIME;
      expect(old.map((band) => band.upTo)).toEqual(['250000', '500000', '1000000', null]);
      expect(old.map((band) => band.ratePct)).toEqual(['0', '5', '20', '30']);
    });
  });
});
