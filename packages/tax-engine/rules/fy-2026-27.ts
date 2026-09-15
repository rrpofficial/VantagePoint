/**
 * FY 2026-27 tax rule set (ADR-005).
 *
 * **The first year governed by the Income-tax Act, 2025 (Act 30 of 2025)**,
 * which replaced the Income-tax Act, 1961 from 1 April 2026. Every section
 * reference below is to the 2025 Act; the 1961-Act numbering used throughout the
 * rest of this codebase does not apply to this year.
 *
 * ⚠ PROVISIONAL — and for a different reason than FY 2025-26.
 *
 * These numbers are NOT placeholders. Every one is transcribed from a primary
 * document and cited below. What they are not is ENACTED text: both sources are
 * Bills as introduced, and a rate can change between a Bill and the Act that
 * follows it. `assertFilingReady` therefore still refuses this rule set, which is
 * the right outcome — a figure sourced from a Bill is good enough to compute
 * with and not good enough to file on.
 *
 * ## Sources
 *
 *  [FB2026]  The Finance Bill, 2026 (Bill No. 3 of 2026), as introduced in Lok
 *            Sabha on 1 February 2026. Clause 3 charges income-tax for the tax
 *            year under Act 30 of 2025 at the rates in Part I-B of the First
 *            Schedule.
 *  [ITB2025] The Income-tax Bill, 2025 (Bill No. 24 of 2025), as introduced in
 *            Lok Sabha — the Bill that became Act 30 of 2025.
 *
 * ## To promote this to VERIFIED
 *
 * One document settles it: `INCOME-TAX ACT, 2025 [30 OF 2025] [AS AMENDED BY
 * FINANCE ACT, 2026]`, published by the Income Tax Department. Check sections
 * 196, 197, 198 and 202 and the Finance Act 2026 First Schedule Part I-B against
 * the values here, then set `status: 'VERIFIED'` and drop the note.
 */
import type { TaxRuleSet } from '../src/types.js';

export const FY_2026_27: TaxRuleSet = {
  status: 'PROVISIONAL',
  provisionalNote:
    'Sourced from the Finance Bill 2026 (Bill No. 3 of 2026) and the Income-tax Bill 2025 (Bill No. 24 of 2025), both AS INTRODUCED — not from enacted text. Rates can change between a Bill and the Act. Standard deduction is NOT sourced and is carried over from FY 2025-26; verify it before relying on any salary figure. Verify against "Income-tax Act 2025 [30 of 2025] as amended by Finance Act 2026" before filing.',
  financialYear: '2026-27',

  slabs: {
    /*
     * The opt-out regime. [FB2026] First Schedule, Part I-B, Paragraph A(I) —
     * individual other than a resident aged 60 or more.
     *
     * Resident 60-79 has a ₹3,00,000 threshold and 80+ a ₹5,00,000 threshold
     * (Paragraph A(II) and A(III)). This engine does not model age bands, so the
     * under-60 table is used; an older taxpayer is therefore OVERSTATED here,
     * which is the safe direction but is a real limitation.
     */
    OLD_REGIME: [
      { upTo: '250000', ratePct: '0' },
      { upTo: '500000', ratePct: '5' },
      { upTo: '1000000', ratePct: '20' },
      { upTo: null, ratePct: '30' },
    ],
    /*
     * The DEFAULT regime, applying unless the taxpayer opts out.
     * [ITB2025] section 202(1), Table.
     *
     * Not in the Finance Bill: clause 47 touches section 202 only to omit a
     * cross-reference to section 144, and restates no rate.
     */
    NEW_REGIME: [
      { upTo: '400000', ratePct: '0' },
      { upTo: '800000', ratePct: '5' },
      { upTo: '1200000', ratePct: '10' },
      { upTo: '1600000', ratePct: '15' },
      { upTo: '2000000', ratePct: '20' },
      { upTo: '2400000', ratePct: '25' },
      { upTo: null, ratePct: '30' },
    ],
  },

  /*
   * NOT SOURCED. Carried forward from FY 2025-26 so the engine has a value.
   * The 2025 Act sets this and it was not read; treat any salary figure computed
   * from this year as unverified until it is.
   */
  standardDeduction: {
    OLD_REGIME: { amount: '50000', currency: 'INR' },
    NEW_REGIME: { amount: '75000', currency: 'INR' },
  },

  /*
   * [FB2026] clause 3(4)(b), Table, Sl. No. 10 — surcharge on income charged
   * under section 202, the DEFAULT regime.
   *
   *   > ₹50,00,000    10%
   *   > ₹1,00,00,000  15%
   *   > ₹2,00,00,000  25%
   *
   * THREE bands. There is no 37% under the default regime, and this was briefly
   * written with four: Part I-B Paragraph F does carry a 37% band above ₹5 crore,
   * but clause 3(4)(a)(ii) excludes from Paragraph F exactly the individuals
   * whose income is charged under section 202. Reading the general schedule
   * without its exclusion added a band that does not apply and would have
   * overstated tax above ₹5 crore by twelve points.
   *
   * ## A modelling limitation this exposes
   *
   * `surchargeBands` is ONE array, and the two regimes genuinely differ: the
   * opt-out regime under Paragraph F does reach 37%. A taxpayer above ₹5 crore
   * who opts out is therefore understated here. The default regime is what this
   * models, because it is the default; making the bands regime-aware is a change
   * to `TaxRuleSet` and is noted in the evolution plan rather than smuggled in.
   */
  surchargeBands: [
    { above: '5000000', ratePct: '10' },
    { above: '10000000', ratePct: '15' },
    { above: '20000000', ratePct: '25' },
  ],
  /*
   * "the rate of surcharge on the income-tax calculated on that part of income
   * shall not exceed fifteen per cent." — [FB2026] Part I-B, Paragraph F,
   * Table 1, Sl. No. 1, clause (vi), for dividend income and capital gains under
   * sections 196, 197 and 198.
   */
  surchargeCapOnCapitalGainsPct: '15',

  /*
   * "Health and Education Cess on income-tax, calculated at the rate of 4% of
   * such income-tax and surcharge" — [FB2026] clause 3, sub-sections (15) and (16).
   */
  cessPct: '4',

  /*
   * [ITB2025] section 198(2)(a): income-tax on long-term capital gains
   * "exceeding one lakh twenty five thousand rupees ... at the rate of 12.5%",
   * for a listed equity share or unit of an equity-oriented fund on which
   * securities transaction tax has been paid.
   */
  ltcgExemptionLimit: { amount: '125000', currency: 'INR' },
  ltcgRatePct: '12.5',

  /*
   * [ITB2025] section 196(1)(i): short-term capital gains on an STT-paid equity
   * share, unit of an equity-oriented fund or unit of a business trust, "at the
   * rate of 20%".
   */
  stcgListedEquityRatePct: '20',

  /* NOT SOURCED for this year. Carried forward from FY 2025-26. */
  vdaRatePct: '30',

  /* NOT SOURCED for this year. Carried forward from FY 2025-26. */
  holdingPeriodMonths: {
    DOMESTIC_EQUITY: 12,
    DOMESTIC_ETF: 12,
    DOMESTIC_MUTUAL_FUND: 12,
    FOREIGN_EQUITY: 24,
    FOREIGN_ETF: 24,
    UNLISTED_SHARES: 24,
    REAL_ESTATE: 24,
    GOLD_PHYSICAL: 24,
    GOLD_DIGITAL: 24,
    SGB: 12,
  },
  mutualFundEquityBands: { equityOrientedMinPct: 65, debtOrientedMaxPct: 35 },

  /* NOT SOURCED for this year. Carried forward from FY 2025-26. */
  hniIncomeThreshold: { amount: '5000000', currency: 'INR' },
  hniNetWorthThreshold: { amount: '100000000', currency: 'INR' },
  scheduleAlIncomeThreshold: { amount: '5000000', currency: 'INR' },
} satisfies TaxRuleSet;
