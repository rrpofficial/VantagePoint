/**
 * FY 2024-25 tax rule set (ADR-005).
 *
 * ⚠ PROVISIONAL — the STRUCTURE is correct; the NUMBERS are unverified
 * placeholders. `TaxRuleTable.assertFilingReady` refuses any rule set carrying
 * this status, so no filing artifact can be produced from these rates. Replace
 * with values sourced from the Finance Act and set status to 'VERIFIED'.
 *
 * Defined as a typed module rather than loaded from JSON at runtime: the tax
 * engine is a pure domain package and performs no I/O, and declaring the data
 * here means a malformed slab band is a compile error rather than a runtime one.
 */
import type { TaxRuleSet } from '../src/types.js';

export const FY_2024_25: TaxRuleSet = {
  "status": "PROVISIONAL",
  "provisionalNote": "NOT VERIFIED AGAINST THE FINANCE ACT. Structure is correct; the numbers are placeholders so the engine and its tests can be built. The tax engine refuses to emit any filing artifact while a rule set carries this status. Replace with sourced values and cite the Act section before use.",
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
    "FOREIGN_ETF": 24,    "UNLISTED_SHARES": 24,
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
