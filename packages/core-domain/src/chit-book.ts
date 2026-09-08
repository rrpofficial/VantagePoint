/**
 * The chit-fund register (US-1.12).
 *
 * A chit is a commitment: an instalment every month for a fixed term, in return
 * for the right to take the pot once during it. Two consequences shape this
 * whole module, and both are ways a chit is normally mis-stated on a balance
 * sheet.
 *
 *  1. **A chit is worth what has been paid into it, not its face value.** A
 *     ₹5,00,000 chit two instalments old is a ₹40,000 asset. Carrying it at face
 *     overstates net worth by the entire undrawn amount, and it is the single
 *     easiest error to make because the face value is the number the chit is
 *     named after.
 *  2. **Withdrawing ends it as an asset, not as an obligation.** The pot taken
 *     is now cash in a bank account — counting the accumulated instalments as
 *     well would count the same rupees twice. But the instalments do NOT stop:
 *     a holder who draws in month 6 of 25 keeps paying to the end, and those
 *     payments stay on the record even though the chit is worth nil.
 *
 * The realisable value of a live chit actually depends on auction history this
 * module does not model, so `carryingValue` is contributions at cost. That is a
 * deliberate understatement rather than a guess: it is the one figure the holder
 * can verify from a passbook.
 */
import { Money, type IsoDate, type Money as MoneyValue } from '@porttrack/shared-kernel';
import { compareIsoDates, monthsBetween } from './daycount.js';
import type { PaymentMode } from './types.js';

export type ChitStatus = 'ACTIVE' | 'WITHDRAWN';

/**
 * Whether every instalment is the same. A chit with a rising instalment cannot
 * be valued as months × a single figure, which is why the register sums what was
 * actually paid rather than deriving it from the term.
 */
export type ChitEmiType = 'CONSTANT' | 'VARYING';

export interface ChitEmi {
  readonly emiId: string;
  readonly date: IsoDate;
  readonly amount: MoneyValue;
  readonly mode: PaymentMode;
  /** The branch, agent or collector the instalment was handed to. */
  readonly paidTo: string;
  readonly comments?: string;
}

export interface ChitFund {
  readonly assetId: string;
  /** The chit company. */
  readonly org: string;
  /** The holder's own name for this chit, e.g. "5L / 25 months". */
  readonly label: string;
  /** The chit's face value — what the pot is worth, NOT what it has cost. */
  readonly targetAmount: MoneyValue;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
  readonly durationMonths: number;
  readonly emiType: ChitEmiType;
  /** Names a withdrawal schedule. Meaningful only for a CONSTANT chit. */
  readonly scheduleLabel?: string;
  readonly status: ChitStatus;
  readonly withdrawnDate?: IsoDate;
  /** What the pot actually paid out, which the schedule only predicted. */
  readonly withdrawnAmount?: MoneyValue;
  readonly comments?: string;
  readonly emis: readonly ChitEmi[];
}

/**
 * What the chit company pays out for a withdrawal in a given month.
 *
 * One-time reference data, shared by every chit of the same shape, so it is
 * keyed by label rather than copied onto each chit — two chits of "5L / 25
 * months" must not be able to disagree about what month 12 is worth.
 */
export interface ChitWithdrawalSchedule {
  readonly label: string;
  readonly rows: readonly { readonly month: number; readonly amount: MoneyValue }[];
}

export interface ChitView extends ChitFund {
  readonly paidToDate: MoneyValue;
  readonly emiCount: number;
  readonly monthsElapsed: number;
  readonly monthsRemaining: number;
  readonly remainingCommitment: MoneyValue;
  /** What this contributes to net worth: contributions at cost, or nil. */
  readonly carryingValue: MoneyValue;
  /** From the agreed schedule, when the chit names one. Never interpolated. */
  readonly expectedWithdrawal?: MoneyValue;
  readonly lastPaymentDate?: IsoDate;
}

export interface ChitTotals {
  readonly chitCount: number;
  readonly activeCount: number;
  readonly withdrawnCount: number;
  readonly totalTarget: MoneyValue;
  readonly totalPaid: MoneyValue;
  /** The ONLY figure that reaches net worth. Withdrawn chits contribute nil. */
  readonly activeCarryingValue: MoneyValue;
  readonly totalWithdrawn: MoneyValue;
}

export type ChitSortKey = 'label' | 'org' | 'startDate' | 'targetAmount' | 'paidToDate' | 'status';
export type SortDirection = 'ASC' | 'DESC';

export interface ChitFilter {
  readonly statuses?: readonly ChitStatus[];
  readonly orgs?: readonly string[];
}

export interface ChitRegister {
  readonly chits: readonly ChitView[];
  readonly totals: ChitTotals;
  /** Every organisation present, for the filter control. */
  readonly orgs: readonly string[];
}

/** Never interpolates: a month the schedule does not state has no agreed figure. */
export function withdrawalAmountFor(
  schedule: ChitWithdrawalSchedule | undefined,
  month: number,
): MoneyValue | undefined {
  return schedule?.rows.find((row) => row.month === month)?.amount;
}

const zeroLike = (money: MoneyValue): MoneyValue => Money.zero(money.currency);

export function viewOf(
  chit: ChitFund,
  asOf: IsoDate,
  schedule?: ChitWithdrawalSchedule,
): ChitView {
  const currency = chit.targetAmount.currency;

  // Instalments dated after the valuation date are not money in the pot yet.
  // Counting them would make net worth depend on what is merely scheduled.
  const paid = chit.emis.filter((instalment) => compareIsoDates(instalment.date, asOf) <= 0);
  const paidToDate = Money.sum(
    paid.map((instalment) => instalment.amount),
    currency,
  );

  const elapsed = Math.min(monthsBetween(chit.startDate, asOf), chit.durationMonths);
  const remainingCommitment = Money.compare(paidToDate, chit.targetAmount) >= 0
    ? Money.zero(currency)
    : Money.subtract(chit.targetAmount, paidToDate);

  const lastPaymentDate = paid
    .map((instalment) => instalment.date)
    .sort((a, b) => compareIsoDates(a, b))
    .at(-1);

  /*
   * A withdrawn chit is worth nothing as an asset — the pot is cash elsewhere.
   * The instalments remain on the record because the obligation to pay them
   * continues after the draw.
   */
  const carryingValue = chit.status === 'WITHDRAWN' ? zeroLike(chit.targetAmount) : paidToDate;

  const expectedWithdrawal =
    chit.scheduleLabel === undefined || chit.emiType !== 'CONSTANT'
      ? undefined
      : withdrawalAmountFor(schedule, elapsed);

  return {
    ...chit,
    paidToDate,
    emiCount: paid.length,
    monthsElapsed: elapsed,
    monthsRemaining: Math.max(0, chit.durationMonths - elapsed),
    remainingCommitment,
    carryingValue,
    ...(expectedWithdrawal === undefined ? {} : { expectedWithdrawal }),
    ...(lastPaymentDate === undefined ? {} : { lastPaymentDate }),
  };
}

export function matches(chit: ChitView, filter: ChitFilter = {}): boolean {
  // An empty filter means "all", not "none" — the distinction that makes a
  // cleared filter show the register rather than an empty table.
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    if (!filter.statuses.includes(chit.status)) return false;
  }
  if (filter.orgs !== undefined && filter.orgs.length > 0) {
    if (!filter.orgs.includes(chit.org)) return false;
  }
  return true;
}

const SORTERS: Readonly<Record<ChitSortKey, (a: ChitView, b: ChitView) => number>> = {
  label: (a, b) => a.label.localeCompare(b.label),
  org: (a, b) => a.org.localeCompare(b.org),
  startDate: (a, b) => compareIsoDates(a.startDate, b.startDate),
  status: (a, b) => a.status.localeCompare(b.status),
  targetAmount: (a, b) => Money.compare(a.targetAmount, b.targetAmount),
  paidToDate: (a, b) => Money.compare(a.paidToDate, b.paidToDate),
};

export function sortViews(
  chits: readonly ChitView[],
  sortBy: ChitSortKey = 'startDate',
  direction: SortDirection = 'DESC',
): readonly ChitView[] {
  const sorted = [...chits].sort(SORTERS[sortBy]);
  return direction === 'ASC' ? sorted : sorted.reverse();
}

export function totalsOf(chits: readonly ChitView[], currency = 'INR'): ChitTotals {
  const zero = Money.zero(currency as MoneyValue['currency']);
  const sum = (values: readonly MoneyValue[]) =>
    values.length === 0 ? zero : Money.sum(values, currency as MoneyValue['currency']);

  const active = chits.filter((chit) => chit.status === 'ACTIVE');
  const withdrawn = chits.filter((chit) => chit.status === 'WITHDRAWN');

  return {
    chitCount: chits.length,
    activeCount: active.length,
    withdrawnCount: withdrawn.length,
    totalTarget: sum(chits.map((chit) => chit.targetAmount)),
    totalPaid: sum(chits.map((chit) => chit.paidToDate)),
    activeCarryingValue: sum(active.map((chit) => chit.carryingValue)),
    totalWithdrawn: sum(
      withdrawn
        .map((chit) => chit.withdrawnAmount)
        .filter((amount): amount is MoneyValue => amount !== undefined),
    ),
  };
}

/**
 * The register: filtered, sorted, and totalled over the FILTERED set — so the
 * totals on screen add up to the rows on screen.
 */
export function register(input: {
  readonly chits: readonly ChitFund[];
  readonly asOf: IsoDate;
  readonly schedules?: readonly ChitWithdrawalSchedule[];
  readonly filter?: ChitFilter;
  readonly sortBy?: ChitSortKey;
  readonly direction?: SortDirection;
}): ChitRegister {
  const scheduleFor = (chit: ChitFund) =>
    input.schedules?.find((schedule) => schedule.label === chit.scheduleLabel);

  const views = input.chits.map((chit) => viewOf(chit, input.asOf, scheduleFor(chit)));
  const filtered = views.filter((chit) => matches(chit, input.filter));

  return {
    chits: sortViews(filtered, input.sortBy, input.direction),
    totals: totalsOf(filtered),
    // Drawn from every chit, not the filtered set: a filter control that hides
    // the option you need to clear it is a trap.
    orgs: [...new Set(views.map((chit) => chit.org))].sort((a, b) => a.localeCompare(b)),
  };
}

export const ChitLedger = { viewOf, register, totalsOf, matches, sortViews };
