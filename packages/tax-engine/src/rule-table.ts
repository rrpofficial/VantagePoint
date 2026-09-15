/**
 * Versioned tax rule table (US-5.2, ADR-005).
 *
 * No rate literal appears anywhere in engine code. Slabs, surcharge bands, cess,
 * capital gains rates and every threshold are data keyed by financial year,
 * because they move with each Finance Act and a hardcoded 12.5% becomes a defect
 * the day the Act passes.
 *
 * A missing year is an ERROR, never a fallback to the nearest available set:
 * computing FY 2030-31 with FY 2025-26 rates would produce a confident wrong
 * number, which is worse than refusing.
 *
 * PROVISIONAL RULE SETS: a rule set may declare `status: "PROVISIONAL"`, meaning
 * its structure is right but its numbers are unverified placeholders. Such a set
 * is usable for computation and testing, but {@link assertFilingReady} refuses it,
 * so no filing artifact can be produced from unverified rates.
 */
import { Err, Ok, TaxRulesUnavailableError, type FinancialYear, type Result } from '@vantagepoint/shared-kernel';
import { FY_2024_25 } from '../rules/fy-2024-25.js';
import { FY_2025_26 } from '../rules/fy-2025-26.js';
import { FY_2026_27 } from '../rules/fy-2026-27.js';
import type { TaxRuleSet } from './types.js';

/**
 * Bundled rule sets, imported as modules rather than read from disk: this is a
 * pure domain package and performs no I/O, and static imports mean the data is
 * typechecked at build time.
 */
const REGISTRY: Readonly<Record<FinancialYear, TaxRuleSet>> = {
  '2024-25': FY_2024_25,
  '2025-26': FY_2025_26,
  /*
   * The first year under the Income-tax Act, 2025. Its section references are to
   * that Act, not the 1961 Act every other year here cites — see the file.
   */
  '2026-27': FY_2026_27,
};

export const AVAILABLE_YEARS: readonly FinancialYear[] = Object.keys(REGISTRY).sort();

export function rulesFor(fy: FinancialYear): Result<TaxRuleSet> {
  const rules = REGISTRY[fy];
  if (rules === undefined) {
    return Err(
      new TaxRulesUnavailableError(
        `no tax rule set for FY ${fy}; available: ${AVAILABLE_YEARS.join(', ')}. ` +
          'Rules are never inferred from an adjacent year.',
      ),
    );
  }
  return Ok(rules);
}

export function isProvisional(rules: TaxRuleSet): boolean {
  return rules.status === 'PROVISIONAL';
}

/**
 * Gate for anything that leaves the machine as a tax document — Schedule FA/AL
 * exports, advance tax challans, ITR payloads. Computation is allowed on
 * provisional rates so the product can be built and demonstrated; filing is not.
 */
export function assertFilingReady(rules: TaxRuleSet): Result<void> {
  if (isProvisional(rules)) {
    return Err(
      new TaxRulesUnavailableError(
        `FY ${rules.financialYear} rule set is PROVISIONAL and has not been verified against the ` +
          'Finance Act. Filing artifacts cannot be produced from unverified rates.',
      ),
    );
  }
  return Ok(undefined);
}


