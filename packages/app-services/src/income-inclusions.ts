/**
 * Which ledger-derived receipts count as taxable income.
 *
 * Hand-loan interest and chit-fund returns are **excluded by default**, and that
 * default is deliberate rather than conservative housekeeping.
 *
 * Both are genuinely contested positions, not settled ones:
 *
 *  - Hand-loan interest accrues in this product whether or not it has been
 *    received (`core-domain/accruals.handLoanAccruedInterest`). A taxpayer on the
 *    cash basis owes nothing until it arrives; one on the accrual basis owes it
 *    in the year it accrued. The product cannot know which applies.
 *  - A chit fund's surplus is not uniformly treated as income at all. The
 *    dividend on a subscribed chit is frequently taken as a capital receipt
 *    reducing cost, and the discount suffered by a prized subscriber as a
 *    business expense or as nothing. Positions differ by facts.
 *
 * Silently defaulting either to "included" would overstate someone's liability
 * on a question the software is not entitled to decide for them. Defaulting to
 * "excluded" understates nothing they were relying on the product to find,
 * because the product has never included them — and the Tax screen says so in
 * words wherever a figure is shown.
 *
 * Turning one on is a deliberate, edit-mode-gated act, for the same reason
 * replacing an income profile is: it moves every advance-tax figure at once.
 */
import type { Result } from '@vantagepoint/shared-kernel';
import { SettingsRepository } from '@vantagepoint/persistence';
import { currentPorts } from './context.js';
import { requireEditMode } from './edit-mode.js';

const INCOME_INCLUSIONS_KEY = 'tax.incomeInclusions';

export interface IncomeInclusions {
  /** Interest accrued on hand loans given out. */
  readonly handLoanInterest: boolean;
  /** Dividend or surplus arising on chit funds. */
  readonly chitFundReturns: boolean;
  /**
   * Whether shares sold on vest day to fund withholding are charged to capital
   * gains. Default **false** — excluded.
   *
   * A sell-to-cover is a transfer, so strictly it is chargeable. In practice the
   * sale is same-day at roughly the vest price, so the gain is a rounding error
   * and the position is immaterial.
   *
   * That holds only while both legs fall in the SAME month. A vest on the 31st
   * sold on the 1st takes Rule 115 basis rates a month apart, and the taxable
   * difference is then the whole proceeds times the rate movement — on $20,000
   * of sell-to-cover and a ₹0.50 move, ₹10,000 that is not a rounding error.
   * Those disposals are reported rather than silently dropped.
   */
  readonly sellToCoverGains: boolean;
}

/**
 * Everything off. See the module note — these are tax positions the user takes,
 * not defaults the product is entitled to assume on their behalf.
 */
export const DEFAULT_INCOME_INCLUSIONS: IncomeInclusions = Object.freeze({
  handLoanInterest: false,
  chitFundReturns: false,
  sellToCoverGains: false,
});

/*
 * Cached in memory and written through, exactly as the income profile is: it is
 * read on every tax computation, and a vault round-trip per read would put I/O
 * inside code that is otherwise pure.
 */
let inclusions: IncomeInclusions = DEFAULT_INCOME_INCLUSIONS;

/** What is currently in force. Never undefined — absent means the default. */
export function incomeInclusionsOf(): IncomeInclusions {
  return inclusions;
}

/**
 * Anything the user has switched ON, in words.
 *
 * Exists so a screen can state what a tax figure includes without reimplementing
 * the labels, and so an empty list reads as "nothing extra" rather than as a
 * missing feature.
 */
export function enabledInclusionLabels(
  state: IncomeInclusions = inclusions,
): readonly string[] {
  const labels: string[] = [];
  if (state.handLoanInterest) labels.push('hand-loan interest');
  if (state.chitFundReturns) labels.push('chit-fund returns');
  if (state.sellToCoverGains) labels.push('sell-to-cover gains');
  return labels;
}

/**
 * Persists as well as sets.
 *
 * Gated unconditionally, unlike the income profile's first write. There is no
 * "first time" here: a default is always in force, so every change REPLACES a
 * position that tax figures have already been computed from.
 */
export async function saveIncomeInclusions(
  next: IncomeInclusions,
): Promise<Result<void>> {
  const permitted = requireEditMode('changing which receipts count as taxable income');
  if (!permitted.ok) return permitted;

  inclusions = {
    handLoanInterest: next.handLoanInterest,
    chitFundReturns: next.chitFundReturns,
    sellToCoverGains: next.sellToCoverGains,
  };
  return SettingsRepository.set(
    INCOME_INCLUSIONS_KEY,
    JSON.stringify(inclusions),
    currentPorts().clock.now(),
  );
}

/** Rehydrates from the vault. Called once the vault is unlocked. */
export async function loadIncomeInclusions(): Promise<void> {
  const stored = await SettingsRepository.get(INCOME_INCLUSIONS_KEY);
  if (stored === undefined) {
    inclusions = DEFAULT_INCOME_INCLUSIONS;
    return;
  }

  /*
   * Parsed defensively and field by field. A malformed or partial value must
   * fall back to OFF rather than throw: this is read during unlock, and a
   * corrupt settings row that made the vault unopenable would be a far worse
   * failure than a toggle reverting to its default.
   */
  try {
    const raw = JSON.parse(stored) as Partial<Record<keyof IncomeInclusions, unknown>>;
    inclusions = {
      handLoanInterest: raw.handLoanInterest === true,
      chitFundReturns: raw.chitFundReturns === true,
      sellToCoverGains: raw.sellToCoverGains === true,
    };
  } catch {
    inclusions = DEFAULT_INCOME_INCLUSIONS;
  }
}

/** Test seam, and the reset applied when the vault locks. */
export function resetIncomeInclusions(): void {
  inclusions = DEFAULT_INCOME_INCLUSIONS;
}

export const IncomeInclusionsUC = {
  current: (): IncomeInclusions => incomeInclusionsOf(),
  save: saveIncomeInclusions,
};
