/**
 * The borrowings register (Phase 3, objectives 3 and 10).
 *
 * Built to the same shape as `loan-book.ts`, which already solves filtering,
 * sorting and totals for the mirror-image problem. The two are deliberately
 * separate modules rather than one generic register: they sit on opposite sides
 * of net worth and in different Schedule AL sections, and the cost of a sign
 * error between them is net worth moving by twice the loan.
 */
import { Money, type IsoDate, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { progressOf, scheduleFor, type AmortisationTerms, type LoanProgress, type ScheduledInstalment } from './amortisation.js';
import type { BorrowedLoan, BorrowedLoanStatus, Liability } from './types.js';
import type { SortDirection } from './loan-book.js';

export type BorrowedSortKey = 'lender' | 'startDate' | 'outstanding' | 'emi' | 'percentRepaid';

export interface BorrowedFilter {
  readonly statuses?: readonly BorrowedLoanStatus[];
  readonly kinds?: readonly BorrowedLoan['kind'][];
  readonly lenders?: readonly string[];
  readonly sortBy?: BorrowedSortKey;
  readonly direction?: SortDirection;
  readonly asOf?: IsoDate;
}

export interface BorrowedView extends BorrowedLoan, LoanProgress {
  readonly schedule: readonly ScheduledInstalment[];
}

export interface BorrowedTotals {
  readonly loanCount: number;
  readonly activeCount: number;
  readonly closedCount: number;
  readonly totalBorrowed: MoneyValue;
  readonly totalOutstanding: MoneyValue;
  readonly totalPrincipalRepaid: MoneyValue;
  readonly totalInterestPaid: MoneyValue;
  readonly monthlyCommitment: MoneyValue;
}

const INR = 'INR' as const;

/** The amortisation terms a loan implies. One place, so nothing re-derives them. */
export function termsOf(loan: BorrowedLoan): AmortisationTerms {
  return {
    principal: loan.principal,
    annualRatePct: loan.interestRatePct,
    tenureMonths: loan.tenureMonths,
    startDate: loan.startDate,
    ...(loan.statedEmi === undefined ? {} : { statedEmi: loan.statedEmi }),
  };
}

export function viewOf(loan: BorrowedLoan, asOf: IsoDate): BorrowedView {
  const terms = termsOf(loan);
  const progress = progressOf(terms, loan.payments, asOf);

  return {
    ...loan,
    ...progress,
    /*
     * A closed loan owes nothing, whatever the schedule says. The borrower's
     * declaration is authoritative: a final settlement, a foreclosure or a
     * write-off all end the obligation without the schedule running out, and
     * carrying a balance against a loan the user has closed would understate
     * net worth indefinitely.
     */
    ...(loan.status === 'CLOSED'
      ? { outstanding: Money.zero(loan.principal.currency), isClosed: true, instalmentsRemaining: 0 }
      : {}),
    schedule: scheduleFor(terms),
  };
}

/**
 * The `Liability` this borrowing is, on a given date.
 *
 * The seam that lets `valuation.ts` and `al-items.ts` stay untouched: they read
 * five fields, and this produces exactly those five with the balance reduced by
 * every payment made up to `asOf`. Before Phase 3 a liability carried a
 * principal figure that never moved, so six months of EMIs left net worth
 * unchanged.
 */
export function liabilityOf(loan: BorrowedLoan, asOf: IsoDate): Liability {
  /*
   * `progressOf` directly, NOT `viewOf`.
   *
   * `viewOf` builds the full contractual schedule and `progressOf` builds it
   * again internally, so going through it generated 480 instalment rows to read
   * one balance — on the net-worth path, for every borrowing, on every
   * valuation. Nothing here needs the schedule.
   */
  const outstanding =
    loan.status === 'CLOSED'
      ? Money.zero(loan.principal.currency)
      : progressOf(termsOf(loan), loan.payments, asOf).outstanding;

  return {
    liabilityId: loan.loanId,
    kind: loan.kind,
    principalOutstanding: outstanding,
    interestRatePct: loan.interestRatePct,
    asOf,
  };
}

const compareText = (a: string, b: string) => a.localeCompare(b);
const compareMoney = (a: MoneyValue, b: MoneyValue) =>
  new Decimal(a.amount).comparedTo(b.amount);

export function sortViews(
  views: readonly BorrowedView[],
  sortBy: BorrowedSortKey = 'startDate',
  direction: SortDirection = 'DESC',
): readonly BorrowedView[] {
  const sorted = [...views].sort((a, b) => {
    switch (sortBy) {
      case 'lender':
        return compareText(a.lenderName ?? a.lenderRef, b.lenderName ?? b.lenderRef);
      case 'outstanding':
        return compareMoney(a.outstanding, b.outstanding);
      case 'emi':
        return compareMoney(a.emi, b.emi);
      case 'percentRepaid':
        return new Decimal(a.percentRepaid).comparedTo(b.percentRepaid);
      default:
        return compareText(a.startDate, b.startDate);
    }
  });
  return direction === 'ASC' ? sorted : sorted.reverse();
}

export function totalsOf(views: readonly BorrowedView[]): BorrowedTotals {
  const active = views.filter((view) => view.status === 'ACTIVE');

  return {
    loanCount: views.length,
    activeCount: active.length,
    closedCount: views.length - active.length,
    totalBorrowed: Money.sum(views.map((view) => view.principal), INR),
    totalOutstanding: Money.sum(views.map((view) => view.outstanding), INR),
    totalPrincipalRepaid: Money.sum(views.map((view) => view.principalRepaid), INR),
    totalInterestPaid: Money.sum(views.map((view) => view.interestPaid), INR),
    /*
     * Only ACTIVE loans. A closed loan's EMI is not a commitment, and including
     * it would overstate what the borrower owes every month — the one figure on
     * this screen someone budgets against.
     */
    monthlyCommitment: Money.sum(active.map((view) => view.emi), INR),
  };
}

export interface BorrowedRegister {
  readonly loans: readonly BorrowedView[];
  readonly totals: BorrowedTotals;
  readonly lenders: readonly string[];
  readonly asOf: IsoDate;
}

export function register(
  loans: readonly BorrowedLoan[],
  filter: BorrowedFilter,
  today: IsoDate,
): BorrowedRegister {
  const asOf = filter.asOf ?? today;
  const views = loans.map((loan) => viewOf(loan, asOf));

  const matched = views.filter((view) => {
    if (filter.statuses !== undefined && !filter.statuses.includes(view.status)) return false;
    if (filter.kinds !== undefined && !filter.kinds.includes(view.kind)) return false;
    if (filter.lenders !== undefined) {
      const name = view.lenderName ?? view.lenderRef;
      if (!filter.lenders.includes(name)) return false;
    }
    return true;
  });

  return {
    loans: sortViews(matched, filter.sortBy, filter.direction),
    // Totals follow the FILTER, so the screen adds up to what it is showing.
    totals: totalsOf(matched),
    // Every lender, not just the filtered ones — the filter control must offer
    // the options that would widen the current view, not only the current ones.
    lenders: [...new Set(views.map((view) => view.lenderName ?? view.lenderRef))].sort(),
    asOf,
  };
}
