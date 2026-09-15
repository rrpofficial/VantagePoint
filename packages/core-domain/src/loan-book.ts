/**
 * The hand-loan register (US-1.11, hand-loan tracking requirements).
 *
 * Replaces a spreadsheet whose columns were: borrower, notes, loan date, closed
 * date, amount, status, rate, total interest months, interest balance months,
 * interest per month, total interest, interest balance, and four fixed pairs of
 * interest payment + date. Every one of those is derived here except the facts
 * the lender records — and the four payment columns become an unbounded list,
 * because a loan running four years at quarterly interest needs sixteen.
 *
 * Three distinctions carry the whole module, and each is a way real money goes
 * missing in a spreadsheet:
 *
 *  1. **Interest payments are not principal repayments.** Paying interest does
 *     not reduce what is owed. Conflating them writes off principal silently.
 *  2. **A loan whose principal is fully repaid can still owe interest.** Status
 *     therefore tracks the PRINCIPAL, and pending interest is reported for
 *     settled loans separately from live ones — they are collected differently
 *     and one is far easier to forget.
 *  3. **Interest accrues on the declining balance.** From the date of a partial
 *     repayment, only the remaining principal earns. Charging the original sum
 *     throughout overstates what is owed and is the error a borrower notices.
 */
import { Money, type IsoDate, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { compareIsoDates, monthsBetween } from './daycount.js';
import { handLoanAccruedInterest, handLoanOutstandingPrincipal } from './accruals.js';
import type { HandLoan, LoanPayment } from './types.js';

/** Tracks the PRINCIPAL. Interest may still be outstanding on a REPAID loan. */
export type LoanStatus = 'ACTIVE' | 'PARTIALLY_REPAID' | 'REPAID';

export interface LoanView {
  readonly loanId: string;
  readonly borrowerRef: string;
  readonly borrowerName: string;
  readonly notes: string;
  readonly loanDate: IsoDate;
  readonly closedDate?: IsoDate;
  readonly principal: MoneyValue;
  readonly interestRatePct: string;
  readonly status: LoanStatus;

  readonly principalRepaid: MoneyValue;
  readonly outstandingPrincipal: MoneyValue;

  readonly totalInterestAccrued: MoneyValue;
  readonly interestPaid: MoneyValue;
  /** Accrued minus paid. Negative is clamped to zero — see `interestBalance`. */
  readonly interestBalance: MoneyValue;
  /** Interest the CURRENT outstanding principal earns in a month. */
  readonly interestPerMonth: MoneyValue;
  /** Whole months from the loan date to the valuation date. */
  readonly totalInterestMonths: number;
  /** How many months of interest are unpaid, at the current monthly rate. */
  readonly interestBalanceMonths: string;

  readonly repayments: readonly {
    readonly date: IsoDate;
    readonly amount: MoneyValue;
    readonly mode: string;
    readonly notes: string;
  }[];
  readonly interestPayments: readonly {
    readonly paymentId: string;
    readonly date: IsoDate;
    readonly amount: MoneyValue;
    readonly mode: string;
    readonly notes: string;
  }[];
  readonly lastPaymentDate?: IsoDate;
}

export interface LoanTotals {
  readonly loanCount: number;
  readonly totalPrincipal: MoneyValue;
  readonly totalOutstanding: MoneyValue;
  readonly totalInterestAccrued: MoneyValue;
  readonly totalInterestPaid: MoneyValue;
  /**
   * Split deliberately. Interest still owed on a loan whose principal came back
   * has no further repayment to arrive alongside it, so it is the balance most
   * often forgotten — and a single combined figure hides it inside the larger
   * number for live loans.
   */
  readonly pendingInterestActive: MoneyValue;
  readonly pendingInterestRepaid: MoneyValue;
  readonly pendingInterestTotal: MoneyValue;
}

const INR = 'INR' as const;
const dec = (value: string) => new Decimal(value);
const round2 = (value: Decimal, currency: MoneyValue['currency']) =>
  Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');

function statusOf(loan: HandLoan, outstanding: MoneyValue): LoanStatus {
  if (Money.isZero(outstanding)) return 'REPAID';
  return loan.repayments.length > 0 ? 'PARTIALLY_REPAID' : 'ACTIVE';
}

function sum(payments: readonly LoanPayment[], currency: MoneyValue['currency']): MoneyValue {
  return Money.sum(
    payments.map((payment) => payment.amount),
    currency,
  );
}

/**
 * A single loan, with every derived figure the register displays.
 *
 * `asOf` is explicit rather than read from a clock, so the same loan renders
 * identically in a test, an export and a snapshot taken months later.
 */
export function viewOf(loan: HandLoan, asOf: IsoDate): LoanView {
  const currency = loan.principal.currency;

  /*
   * Accrual stops at the closing date when one is set. Without this a loan the
   * lender has written off keeps earning interest forever, and the register
   * shows a growing balance nobody intends to collect.
   */
  const accrualDate =
    loan.closedDate !== undefined && compareIsoDates(loan.closedDate, asOf) < 0
      ? loan.closedDate
      : asOf;

  const outstanding = handLoanOutstandingPrincipal(loan, accrualDate);
  const accrued = handLoanAccruedInterest(loan, accrualDate);
  const interestPayments = loan.interestPayments ?? [];
  const paid = sum(interestPayments, currency);

  const principalRepaid = Money.subtract(loan.principal, outstanding);
  const balance = Decimal.max(0, dec(accrued.amount).minus(paid.amount));

  // On the CURRENT balance: a repaid loan earns nothing more, so its monthly
  // figure is zero even though interest may still be owed on it.
  const perMonth = dec(outstanding.amount).times(dec(loan.interestRatePct)).dividedBy(100).dividedBy(12);

  const balanceMonths = perMonth.isZero() ? new Decimal(0) : balance.dividedBy(perMonth);

  const paymentDates = [
    ...loan.repayments.map((repayment) => repayment.date),
    ...interestPayments.map((payment) => payment.date),
  ].sort(compareIsoDates);
  const lastPaymentDate = paymentDates.at(-1);

  return {
    loanId: loan.assetId,
    borrowerRef: loan.borrowerRef,
    borrowerName: loan.borrowerName ?? loan.borrowerRef,
    notes: loan.notes ?? '',
    loanDate: loan.startDate,
    ...(loan.closedDate === undefined ? {} : { closedDate: loan.closedDate }),
    principal: loan.principal,
    interestRatePct: loan.interestRatePct,
    status: statusOf(loan, outstanding),

    principalRepaid,
    outstandingPrincipal: outstanding,

    totalInterestAccrued: accrued,
    interestPaid: paid,
    interestBalance: round2(balance, currency),
    interestPerMonth: round2(perMonth, currency),
    totalInterestMonths: Math.max(0, monthsBetween(loan.startDate, accrualDate)),
    interestBalanceMonths: balanceMonths.toDecimalPlaces(1).toFixed(1),

    repayments: loan.repayments.map((repayment) => ({
      date: repayment.date,
      amount: repayment.principal,
      mode: repayment.mode ?? 'OTHER',
      notes: repayment.notes ?? '',
    })),
    interestPayments: interestPayments.map((payment) => ({
      paymentId: payment.paymentId,
      date: payment.date,
      amount: payment.amount,
      mode: payment.mode,
      notes: payment.notes ?? '',
    })),
    ...(lastPaymentDate === undefined ? {} : { lastPaymentDate }),
  };
}

export interface LoanFilter {
  /** Empty or absent means every status — "no filter" is all, not none. */
  readonly statuses?: readonly LoanStatus[];
  /** Matched against the borrower NAME, case-insensitively, as a substring. */
  readonly borrowers?: readonly string[];
}

export type LoanSortKey = 'borrowerName' | 'status' | 'loanDate' | 'principal';
export type SortDirection = 'ASC' | 'DESC';

/** Ordered by how far along repayment is, not alphabetically. */
const STATUS_ORDER: Readonly<Record<LoanStatus, number>> = {
  ACTIVE: 0,
  PARTIALLY_REPAID: 1,
  REPAID: 2,
};

export function matches(view: LoanView, filter: LoanFilter): boolean {
  const statuses = filter.statuses ?? [];
  if (statuses.length > 0 && !statuses.includes(view.status)) return false;

  const borrowers = filter.borrowers ?? [];
  if (borrowers.length > 0) {
    const name = view.borrowerName.toLowerCase();
    // Substring, so "raj" finds "Rajesh" — a register is searched by half-remembered
    // names far more often than by exact ones.
    if (!borrowers.some((borrower) => name.includes(borrower.trim().toLowerCase()))) return false;
  }
  return true;
}

export function sortViews(
  views: readonly LoanView[],
  key: LoanSortKey,
  direction: SortDirection,
): readonly LoanView[] {
  const factor = direction === 'ASC' ? 1 : -1;

  const compare = (a: LoanView, b: LoanView): number => {
    switch (key) {
      case 'borrowerName':
        return a.borrowerName.localeCompare(b.borrowerName);
      case 'status':
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      case 'loanDate':
        return compareIsoDates(a.loanDate, b.loanDate);
      case 'principal':
        return dec(a.principal.amount).comparedTo(dec(b.principal.amount));
    }
  };

  return [...views].sort(
    // Loan id breaks ties so the order is stable: two loans made to the same
    // person on the same day must not swap places between renders.
    (a, b) => compare(a, b) * factor || a.loanId.localeCompare(b.loanId),
  );
}

export function totalsOf(views: readonly LoanView[]): LoanTotals {
  const currency = views[0]?.principal.currency ?? INR;
  const pick = (predicate: (view: LoanView) => boolean, field: keyof LoanView) =>
    Money.sum(
      views.filter(predicate).map((view) => view[field] as MoneyValue),
      currency,
    );

  const pendingActive = pick((view) => view.status !== 'REPAID', 'interestBalance');
  const pendingRepaid = pick((view) => view.status === 'REPAID', 'interestBalance');

  return {
    loanCount: views.length,
    totalPrincipal: pick(() => true, 'principal'),
    totalOutstanding: pick(() => true, 'outstandingPrincipal'),
    totalInterestAccrued: pick(() => true, 'totalInterestAccrued'),
    totalInterestPaid: pick(() => true, 'interestPaid'),
    pendingInterestActive: pendingActive,
    pendingInterestRepaid: pendingRepaid,
    pendingInterestTotal: Money.add(pendingActive, pendingRepaid),
  };
}

export interface LoanRegister {
  readonly loans: readonly LoanView[];
  readonly totals: LoanTotals;
  /** Every borrower on record, for the filter list — not just the visible ones. */
  readonly borrowers: readonly string[];
}

/**
 * The register as the UI shows it: filtered, sorted, and totalled OVER THE
 * FILTERED SET so the tiles always describe what is on screen.
 */
export function register(input: {
  readonly loans: readonly HandLoan[];
  readonly asOf: IsoDate;
  readonly filter?: LoanFilter;
  readonly sortBy?: LoanSortKey;
  readonly direction?: SortDirection;
}): LoanRegister {
  const all = input.loans.map((loan) => viewOf(loan, input.asOf));
  const visible = all.filter((view) => matches(view, input.filter ?? {}));

  return {
    loans: sortViews(visible, input.sortBy ?? 'loanDate', input.direction ?? 'DESC'),
    totals: totalsOf(visible),
    borrowers: [...new Set(all.map((view) => view.borrowerName))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}
