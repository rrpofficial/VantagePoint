/**
 * FY 2024-25 tax rule set (ADR-005) — AY 2025-26.
 *
 * ⚠ PROVISIONAL, and deliberately still so while its neighbour was promoted.
 * This one is not merely unchecked: part of it is demonstrably the WRONG YEAR.
 *
 * ## The defect, shown without needing the Finance Act
 *
 * `slabs.NEW_REGIME` below is byte-for-byte the table in `fy-2025-26.ts` —
 * 4,00,000 / 8,00,000 / 12,00,000 / 16,00,000 / 20,00,000 / 24,00,000. The
 * Finance Bill 2026, clause 2(2), Table, Sl. No. 4 states that Rs. 4,00,000 is
 * the maximum amount not chargeable for a s.115BAC(1A) assessee **for AY
 * 2026-27, which is FY 2025-26**. A table that begins at the following year's
 * exemption is that year's table, carried back.
 *
 * FY 2024-25's own s.115BAC(1A) bands are narrower and there are six of them,
 * not seven, so an income of ₹12,00,000 is taxed here under bands that did not
 * exist in the year. For approximate advance tax that is not a rounding
 * difference; it is the wrong schedule.
 *
 * `standardDeduction.NEW_REGIME` is equally suspect: it is ₹50,000 here and
 * ₹75,000 in FY 2025-26, and the increase is widely understood to have taken
 * effect in AY 2025-26 — this year — which would make ₹50,000 wrong too.
 *
 * ## And a structural problem this type cannot express
 *
 * Capital gains rates CHANGED MID-YEAR. Transfers on or after 23 July 2024 are
 * taxed differently from transfers before it (s.111A, s.112A and the s.112A
 * exemption limit all moved). `ltcgRatePct`, `stcgListedEquityRatePct` and
 * `ltcgExemptionLimit` are single values, so whichever is stored is wrong for
 * one half of the year. Marking this rule set verified would assert an accuracy
 * the type is incapable of holding for FY 2024-25 specifically.
 *
 * ## To close this
 *
 * Supply the First Schedule to the **Finance (No. 2) Act, 2024** and the text of
 * s.115BAC(1A), s.16(ia), s.111A and s.112A as amended by it. Then correct the
 * slab table, settle the standard deduction, decide how the 23 July split is
 * represented, and set `status: 'VERIFIED'`.
 *
 * Until then `assertFilingReady` refuses this year, which is the correct outcome.
 *
 * Defined as a typed module rather than loaded from JSON at runtime: the tax
 * engine is a pure domain package and performs no I/O, and declaring the data
 * here means a malformed slab band is a compile error rather than a runtime one.
 */
import type { TaxRuleSet } from '../src/types.js';

export const FY_2024_25: TaxRuleSet = {
  "status": "PROVISIONAL",
  "provisionalNote": "The new-regime slab table below belongs to FY 2025-26, not to this year: it begins at the Rs. 4,00,000 exemption that the Finance Bill 2026 clause 2(2) assigns to AY 2026-27. The new-regime standard deduction is likely wrong for the same reason. Capital gains rates also changed on 23 July 2024 and a single rate field cannot hold both halves of the year. Correct these against the Finance (No. 2) Act 2024 before relying on any FY 2024-25 figure.",
  "financialYear": "2024-25",
  "slabs": {
    "OLD_REGIME": [
      { "upTo": "250000", "ratePct": "0" },
      { "upTo": "500000", "ratePct": "5" },
      { "upTo": "1000000", "ratePct": "20" },
      { "upTo": null, "ratePct": "30" }
    ],
    "NEW_REGIME": [
      { "upTo": "400000", "ratePct": "0" },
      { "upTo": "800000", "ratePct": "5" },
      { "upTo": "1200000", "ratePct": "10" },
      { "upTo": "1600000", "ratePct": "15" },
      { "upTo": "2000000", "ratePct": "20" },
      { "upTo": "2400000", "ratePct": "25" },
      { "upTo": null, "ratePct": "30" }
    ]
  },
  "standardDeduction": {
    "OLD_REGIME": { "amount": "50000", "currency": "INR" },
    "NEW_REGIME": { "amount": "50000", "currency": "INR" }
  },
  "surchargeBands": [
    { "above": "5000000", "ratePct": "10" },
    { "above": "10000000", "ratePct": "15" },
    { "above": "20000000", "ratePct": "25" }
  ],
  "surchargeCapOnCapitalGainsPct": "15",
  "cessPct": "4",
  "ltcgExemptionLimit": { "amount": "125000", "currency": "INR" },
  "ltcgRatePct": "12.5",
  "stcgListedEquityRatePct": "20",
  "vdaRatePct": "30",
  "holdingPeriodMonths": {
    "DOMESTIC_EQUITY": 12,
    "DOMESTIC_ETF": 12,
    "DOMESTIC_MUTUAL_FUND": 12,
    "FOREIGN_EQUITY": 24,
    "FOREIGN_ETF": 24,
    "UNLISTED_SHARES": 24,
    "REAL_ESTATE": 24,
    "GOLD_PHYSICAL": 24,
    "GOLD_DIGITAL": 24,
    "SGB": 12
  },
  "mutualFundEquityBands": { "equityOrientedMinPct": 65, "debtOrientedMaxPct": 35 },
  "hniIncomeThreshold": { "amount": "5000000", "currency": "INR" },
  "hniNetWorthThreshold": { "amount": "100000000", "currency": "INR" },
  "scheduleAlIncomeThreshold": { "amount": "5000000", "currency": "INR" }
} satisfies TaxRuleSet;
