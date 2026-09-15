/**
 * FY 2026-27 tax rule set (ADR-005).
 *
 * **The first year governed by the Income-tax Act, 2025 (Act 30 of 2025)**,
 * which replaced the Income-tax Act, 1961 from 1 April 2026. Every section
 * reference below is to the 2025 Act; the 1961-Act numbering used throughout the
 * rest of this codebase does not apply to this year.
 *
 * VERIFIED — re-sourced on 2026-09-15 from ENACTED text, replacing the Bill
 * citations this file was first written from.
 *
 * ## Sources
 *
 *  [FA2026]  THE FINANCE ACT, 2026 (NO. 4 OF 2026), assented 30 March 2026,
 *            Gazette of India Extraordinary Part II Section 1,
 *            CG-DL-E-31032026-271439. Section 3(1) charges income-tax "for the
 *            tax year commencing on the 1st day of April, 2026 ... under the
 *            provisions of the Income-tax Act, 2025 ... at the rates specified in
 *            Part I-B of the First Schedule".
 *  [ITA2025] The Income-tax Act, 2025 (Act 30 of 2025), in force from
 *            1 April 2026. Read as the Bill (No. 24 of 2025) — see the gap below.
 *
 * ## What was checked against [FA2026], clause by clause
 *
 *   slabs.OLD_REGIME       First Schedule Part I-B, Paragraph A(I). Nil to
 *                          ₹250000; 5% to ₹500000; 20% to ₹1000000; 30%
 *                          above. ✓
 *   surchargeBands         s.3(4)(b), Table, Sl. No. 10 — the row for income
 *                          chargeable under s.202. 10% / 15% / 25%. ✓
 *   surchargeCapOn…        s.3(4)(b), Sl. No. 10, clause (v): surcharge on the
 *                          dividend and s.196/197/198 part "shall not exceed
 *                          15%". ✓
 *   cessPct                s.3(15) and s.3(16): "Health and Education Cess on
 *                          income-tax, calculated at the rate of 4%". ✓
 *   NEW_REGIME first band  s.3(2) Table Sl. No. 4 and s.3(14) Table Sl. No. 4:
 *                          maximum amount not chargeable for a s.202 assessee
 *                          is ₹400000. ✓
 *
 * The Bill's clause numbering survived into the Act for section 3, so the
 * citations above are unchanged from the Bill reading. The amendment sections
 * DID renumber: what was clause 47 is s.56 of the Act.
 *
 * ## Why there is no 37% band
 *
 * Part I-B Paragraph F carries one above ₹5 crore, but s.3(4)(a)(ii) excludes
 * from Paragraph F "an individual ... whose income is chargeable to tax under
 * section 202 of the said Act" — the default regime. Their bands are the three
 * in the Sl. No. 10 table. This file was briefly written with four bands by
 * reading Paragraph F without its exclusion; that would have overstated tax
 * above ₹5 crore by twelve points.
 *
 * The opt-out regime DOES reach 37% under Paragraph F, and one `surchargeBands`
 * array cannot hold both. This models the default regime, because it is the
 * default. See §7 of `portrack_evolution_plan.md`.
 *
 * ## The one gap that remains
 *
 * A Finance Act restates charging rates and surcharge; it does not restate the
 * Act it leaves alone. `slabs.NEW_REGIME` above ₹400000, `standardDeduction`,
 * `ltcgRatePct`, `ltcgExemptionLimit` and `stcgListedEquityRatePct` come from
 * [ITA2025] sections 202, 196, 197 and 198 — and were read from the BILL, not
 * from the enacted Act, which went through a Select Committee.
 *
 * Two things narrow that risk to the slab table specifically:
 *   - [FA2026] s.56 amends s.202 ONLY by omitting sub-section (2)(a)(iii). It
 *     does not touch the s.202(1) rate table, so no Finance Act change applies.
 *   - [FA2026] s.3(2) Table Sl. No. 4 independently fixes the nil band at
 *     ₹400000, which is where the table below starts.
 *
 * To close it completely, read s.202(1), s.196(1)(i), s.198(2)(a) and s.19 of
 * the enacted Act 30 of 2025 and confirm the figures below.
 *
 * ## Known missing: the s.156(2) rebate
 *
 * `TaxRuleSet` models no rebate at all. Section 156(2)(a) allows a deduction of
 * the whole tax, or ₹60,000, whichever is less, where total income does not
 * exceed ₹1200000 — so a default-regime taxpayer under ₹12 lakh owes nothing and
 * this engine will still compute slab tax for them. That OVERSTATES the figure,
 * which is the safe direction for advance tax but is wrong. Tracked in the
 * evolution plan; it needs a type change and careful handling of the fact that
 * the rebate is not available against income taxed at the special rates.
 */
import type { TaxRuleSet } from '../src/types.js';

export const FY_2026_27: TaxRuleSet = {
  status: 'VERIFIED',
  financialYear: '2026-27',

  slabs: {
    /*
     * The opt-out regime. [FA2026] First Schedule, Part I-B, Paragraph A(I) —
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
     * [ITA2025] section 202(1), Table — read from the Bill; see the gap note in
     * the file header.
     *
     * [FA2026] does not disturb it: s.56 amends s.202 only by omitting
     * sub-section (2)(a)(iii), restating no rate, and s.3(2) Table Sl. No. 4
     * independently fixes the nil band at ₹400000.
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
   * [FA2026] s.3(4)(b), Table, Sl. No. 10 — surcharge on income charged
   * under section 202, the DEFAULT regime.
   *
   *   > ₹50,00,000    10%
   *   > ₹1,00,00,000  15%
   *   > ₹2,00,00,000  25%
   *
   * THREE bands. There is no 37% under the default regime, and this was briefly
   * written with four: Part I-B Paragraph F does carry a 37% band above ₹5 crore,
   * but s.3(4)(a)(ii) excludes from Paragraph F exactly the individuals
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
   * shall not exceed fifteen per cent." — [FA2026] Part I-B, Paragraph F,
   * Table 1, Sl. No. 1, clause (vi), for dividend income and capital gains under
   * sections 196, 197 and 198.
   */
  surchargeCapOnCapitalGainsPct: '15',

  /*
   * "Health and Education Cess on income-tax, calculated at the rate of 4% of
   * such income-tax and surcharge" — [FA2026] s.3(15) and s.3(16).
   */
  cessPct: '4',

  /*
   * [ITA2025] section 198(2)(a): income-tax on long-term capital gains
   * "exceeding one lakh twenty five thousand rupees ... at the rate of 12.5%",
   * for a listed equity share or unit of an equity-oriented fund on which
   * securities transaction tax has been paid.
   */
  ltcgExemptionLimit: { amount: '125000', currency: 'INR' },
  ltcgRatePct: '12.5',

  /*
   * [ITA2025] section 196(1)(i): short-term capital gains on an STT-paid equity
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
