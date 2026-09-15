/**
 * FY 2025-26 tax rule set (ADR-005) — AY 2026-27.
 *
 * VERIFIED. The charging provisions below were read from a primary document and
 * are cited clause by clause. Marked verified at the user's direction on
 * 2026-09-15, for computing approximate quarterly advance tax and an approximate
 * annual liability.
 *
 * ## Source
 *
 * [FB2026] The Finance Bill, 2026 (Bill No. 3 of 2026), First Schedule Part I-A
 * and clause 2. Part I-A is this year's schedule, not next year's: clause 2(1)
 * charges tax "for the assessment year commencing on the 1st day of April, 2026
 * ... at the rates specified in Part I-A of the First Schedule", and AY 2026-27
 * is FY 2025-26.
 *
 * ## What was checked, and against what
 *
 *   slabs.OLD_REGIME      Part I-A, Paragraph A(I). Nil to 2,50,000; 5% to
 *                         5,00,000; 20% to 10,00,000; 30% above. ✓
 *   surchargeBands        clause 2(4)(b), Table, Sl. No. 10 — the entry for
 *                         s.115BAC(1A), the DEFAULT regime. 10% / 15% / 25%,
 *                         and no 37% band. ✓ See the note below.
 *   surchargeCapOn…       clause 2(4)(b), Sl. No. 10, clause (v): surcharge on
 *                         the dividend and s.111A/112/112A part "shall not
 *                         exceed fifteen per cent." ✓
 *   cessPct               clause 2(6): "Health and Education Cess on income-tax,
 *                         calculated at the rate of four per cent." ✓
 *   NEW_REGIME first band clause 2(2), Table, Sl. No. 4: maximum amount not
 *                         chargeable for a s.115BAC(1A) assessee is
 *                         Rs. 4,00,000. ✓
 *
 * ## Why there is no 37% band
 *
 * Part I-A Paragraph F does carry one, above ₹5 crore — but clause 2(4)(a)(ii)
 * excludes from Paragraph F exactly the individuals "whose income is chargeable
 * to tax under sub-section (1A) of section 115BAC", which is the default regime.
 * Their bands are the three in the Sl. No. 10 table. Reading Paragraph F without
 * its exclusion adds a band that does not apply; that mistake was made once on
 * FY 2026-27, where the 2025 Act repeats the same structure.
 *
 * The opt-out ("old") regime DOES reach 37% under Paragraph F, and one
 * `surchargeBands` array cannot hold both. This models the default regime,
 * because it is the default. See §7 of `portrack_evolution_plan.md`.
 *
 * ## NOT sourced from [FB2026] — carried, and still to be checked
 *
 * A Finance Bill restates the charging rates and the surcharge; it does not
 * restate provisions of the Act it leaves alone. These therefore come from the
 * Income-tax Act 1961 as amended by the Finance Act 2025, which is not among the
 * documents here:
 *
 *   slabs.NEW_REGIME above ₹4,00,000   s.115BAC(1A) band table
 *   standardDeduction                  s.16(ia)
 *   ltcgRatePct, ltcgExemptionLimit    s.112A
 *   stcgListedEquityRatePct            s.111A
 *   vdaRatePct                         s.115BBH
 *   holdingPeriodMonths                s.2(42A)
 *   the hni and scheduleAl limits      filing-requirement thresholds, not rates
 *
 * To close these, read "Income-tax Act 1961 as amended by the Finance Act 2025"
 * and check each section named above.
 *
 * Defined as a typed module rather than loaded from JSON at runtime: the tax
 * engine is a pure domain package and performs no I/O, and declaring the data
 * here means a malformed slab band is a compile error rather than a runtime one.
 */
import type { TaxRuleSet } from '../src/types.js';

export const FY_2025_26: TaxRuleSet = {
  "status": "VERIFIED",
  "financialYear": "2025-26",
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
    "NEW_REGIME": { "amount": "75000", "currency": "INR" }
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
