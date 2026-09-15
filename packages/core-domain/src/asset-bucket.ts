/**
 * How a holding is grouped for the user (US-8.5).
 *
 * A presentation grouping, not a tax one — but it is derived from the tax
 * character where that exists, because the alternative produces a screen that
 * disagrees with the engine sitting behind it.
 *
 * The case that forces this: `DOMESTIC_MUTUAL_FUND` is a single asset class
 * covering funds taxed completely differently (ADR-016). Bucketing by asset class
 * alone would file a debt fund under Equity, where the app's own capital-gains
 * engine treats it as slab-taxed. So `taxCharacterOf` decides for funds, and the
 * asset class decides for everything else.
 *
 * Loans and chits are their own buckets rather than "non-equity", because each
 * already has a screen shaped around it: a receivable tracked by who owes it, and
 * a monthly commitment tracked by instalments paid. Neither fits a holdings table.
 */
import { taxCharacterOf } from './mf-tax-character.js';
import type { AssetClass, MfTaxCharacter, TaxSubject } from './types.js';

export type AssetBucket = 'EQUITY' | 'NON_EQUITY' | 'IMMOVABLE' | 'LOAN' | 'CHIT';

/** Classes that are equity however they are held. */
const ALWAYS_EQUITY: ReadonlySet<AssetClass> = new Set([
  'DOMESTIC_EQUITY',
  'FOREIGN_EQUITY',
  'FOREIGN_ETF',
  'RSU',
  'ESPP',
  'UNLISTED_SHARES',
]);

/**
 * Classes whose equity-ness depends on what they hold rather than what they are.
 * Resolved through `taxCharacterOf`; see the note on the default below.
 */
const CHARACTER_DEPENDENT: ReadonlySet<AssetClass> = new Set([
  'DOMESTIC_MUTUAL_FUND',
  'DOMESTIC_ETF',
]);

/**
 * Takes a `TaxSubject` rather than a full `Asset` so the grouping can be asked
 * for from anywhere — a stored holding, a form in progress, a row being imported.
 */
export function bucketOf(subject: TaxSubject): AssetBucket {
  const { assetClass } = subject;

  if (assetClass === 'HAND_LOAN') return 'LOAN';
  if (assetClass === 'CHIT_FUND') return 'CHIT';
  if (assetClass === 'REAL_ESTATE') return 'IMMOVABLE';
  if (ALWAYS_EQUITY.has(assetClass)) return 'EQUITY';

  if (CHARACTER_DEPENDENT.has(assetClass)) {
    const character: MfTaxCharacter | undefined = taxCharacterOf(subject);
    /*
     * An UNCLASSIFIED fund shows as equity.
     *
     * `taxCharacterOf` returns undefined when the scheme category was never
     * recorded — which is the state of every fund imported before the category
     * was captured. Defaulting to equity keeps such a holding beside the listed
     * shares a user expects it near, and the tax engine is unaffected either way:
     * it reads the character itself and does not consult this function.
     *
     * An ETF has no scheme category at all, so it always lands here. Indian ETFs
     * are overwhelmingly equity-tracking, and a debt ETF is recorded as a debt
     * fund in practice.
     */
    return character === 'DEBT_ORIENTED' ? 'NON_EQUITY' : 'EQUITY';
  }

  // Deposits, retirement schemes, bullion, crypto, cash and bank balances.
  return 'NON_EQUITY';
}

/** Buckets that render as a holdings table, in the order the nav presents them. */
export const HOLDING_BUCKETS: readonly AssetBucket[] = ['EQUITY', 'NON_EQUITY', 'IMMOVABLE'];
