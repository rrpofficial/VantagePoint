/**
 * Reducing-balance amortisation for borrowed money (Phase 3, D-2).
 *
 * The mirror image of `accruals.ts`, which handles money LENT. Both compute
 * interest on a declining balance; they differ in which side of net worth the
 * result lands on, and in that a borrowing has a contractual schedule where a
 * hand loan has whatever the borrower actually paid.
 *
 * ## Why a schedule rather than a running balance
 *
 * "What do I still owe?" and "how much of this year's EMI was interest?" are
 * different questions, and only the second answers objective 10. A running
 * balance can produce the first; the interest/principal split needs the
 * instalment-by-instalment walk, because each instalment's split depends on the
 * balance every earlier instalment left behind.
 *
 * ## Monthly rate
 *
 * `annualRate / 12`, which is how every Indian lender quotes and computes a home
 * loan EMI — not the effective monthly equivalent `(1+r)^(1/12) − 1`. Using the
 * mathematically tidier one produces an EMI a few rupees from the lender's, and
 * the difference compounds across 240 instalments into a visible mismatch with
 * the borrower's own statement.
 *
 * Pure: no I/O, no clock. Every function takes the date it should answer as of.
 */
import {
  Money,
  type IsoDate,
  type Money as MoneyValue,
  type Percentage,
} from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { compareIsoDates } from './daycount.js';

export interface AmortisationTerms {
  readonly principal: MoneyValue;
  readonly annualRatePct: Percentage;
  readonly tenureMonths: number;
  readonly startDate: IsoDate;
  /**
   * The lender's own EMI, where the borrower knows it.
   *
   * Preferred over the computed one when present. A lender rounds to the rupee
   * and may carry a processing adjustment, and a schedule that disagrees with
   * the borrower's statement by ₹3 an instalment is one they cannot reconcile.
   */
  readonly statedEmi?: MoneyValue;
}

/** One instalment of the contractual schedule. */
export interface ScheduledInstalment {
  readonly number: number;
  readonly dueDate: IsoDate;
  readonly openingBalance: MoneyValue;
  readonly payment: MoneyValue;
  readonly interest: MoneyValue;
  readonly principal: MoneyValue;
  readonly closingBalance: MoneyValue;
}

/** A payment the borrower actually made. */
export interface LoanInstalmentPaid {
  readonly paymentId?: string;
  readonly date: IsoDate;
  readonly amount: MoneyValue;
  /**
   * A lump sum against principal, outside the EMI schedule.
   *
   * Kept distinct because it behaves differently: an EMI is split between
   * interest and principal, a prepayment is principal in full. Treating one as
   * the other either overstates interest paid or understates the balance.
   */
  readonly isPrepayment?: boolean;
  readonly notes?: string;
}

const MONTHS = 12;

const monthlyRate = (annualRatePct: Percentage): Decimal =>
  new Decimal(annualRatePct).dividedBy(100).dividedBy(MONTHS);

/** The same date in `count` months' time, clamped to the month's last day. */
export function addMonths(date: IsoDate, count: number): IsoDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  // A 31st becomes the 30th in a 30-day month rather than rolling into the next
  // one, which is what a lender's due date does.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The standard EMI formula: `P·r·(1+r)^n / ((1+r)^n − 1)`.
 *
 * A zero rate is a real case — an employer or family loan repaid in equal
 * instalments — and the formula divides by zero there, so it is handled first.
 */
export function emiFor(terms: AmortisationTerms): MoneyValue {
  if (terms.statedEmi !== undefined) return terms.statedEmi;

  const currency = terms.principal.currency;
  if (terms.tenureMonths <= 0) return Money.zero(currency);

  const principal = new Decimal(terms.principal.amount);
  const rate = monthlyRate(terms.annualRatePct);

  if (rate.isZero()) {
    return Money.round(
      Money.of(principal.dividedBy(terms.tenureMonths).toFixed(), currency),
      2,
      'HALF_UP',
    );
  }

  const growth = rate.plus(1).pow(terms.tenureMonths);
  const emi = principal.times(rate).times(growth).dividedBy(growth.minus(1));
  return Money.round(Money.of(emi.toFixed(), currency), 2, 'HALF_UP');
}

/**
 * The contractual schedule, ignoring what was actually paid.
 *
 * This is the lender's plan. `progressOf` compares it against reality.
 *
 * The LAST instalment absorbs the rounding. Every earlier one is rounded to the
 * rupee, so a 240-month schedule accumulates a few rupees of drift; letting the
 * final payment settle the exact balance is what a lender does, and leaves the
 * closing balance at precisely zero instead of at ₹2.37.
 */
export function scheduleFor(terms: AmortisationTerms): readonly ScheduledInstalment[] {
  const currency = terms.principal.currency;
  if (terms.tenureMonths <= 0) return [];

  const rate = monthlyRate(terms.annualRatePct);
  const emi = new Decimal(emiFor(terms).amount);

  const instalments: ScheduledInstalment[] = [];
  let balance = new Decimal(terms.principal.amount);

  for (let number = 1; number <= terms.tenureMonths; number++) {
    const interest = balance.times(rate);
    const isLast = number === terms.tenureMonths;

    // The final payment is whatever clears the balance, interest included.
    const payment = isLast ? balance.plus(interest) : emi;
    const principal = payment.minus(interest);
    const closing = isLast ? new Decimal(0) : balance.minus(principal);

    const money = (value: Decimal) =>
      Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');

    instalments.push({
      number,
      dueDate: addMonths(terms.startDate, number),
      openingBalance: money(balance),
      payment: money(payment),
      interest: money(interest),
      principal: money(principal),
      closingBalance: money(closing),
    });

    balance = closing;
  }

  return instalments;
}

export interface LoanProgress {
  readonly emi: MoneyValue;
  readonly totalPayable: MoneyValue;
  readonly totalInterest: MoneyValue;
  readonly paidToDate: MoneyValue;
  readonly principalRepaid: MoneyValue;
  readonly interestPaid: MoneyValue;
  readonly prepaid: MoneyValue;
  readonly outstanding: MoneyValue;
  readonly instalmentsPaid: number;
  readonly instalmentsRemaining: number;
  /** Principal repaid as a percentage of the original — never of the payments. */
  readonly percentRepaid: string;
  readonly nextDueDate?: IsoDate;
  readonly isClosed: boolean;
}

/**
 * What is actually owed, from the payments actually made.
 *
 * Walks the payments in date order rather than assuming the schedule was
 * followed. A borrower who misses an instalment owes MORE than the schedule
 * says, and one who prepays owes less; a progress figure read off the
 * contractual schedule would be wrong in both directions and would look right.
 *
 * Interest accrues month by month on the balance at the start of each month,
 * and each payment is applied to accrued interest first, then to principal —
 * the order every lender applies, and the order that decides how much of a year's
 * EMIs was interest.
 */
export function progressOf(
  terms: AmortisationTerms,
  payments: readonly LoanInstalmentPaid[],
  asOf: IsoDate,
): LoanProgress {
  const currency = terms.principal.currency;
  const zero = Money.zero(currency);
  const rate = monthlyRate(terms.annualRatePct);
  const schedule = scheduleFor(terms);

  const emi = emiFor(terms);
  const totalPayable = Money.sum(
    schedule.map((instalment) => instalment.payment),
    currency,
  );

  const due = [...payments]
    .filter((payment) => compareIsoDates(payment.date, asOf) <= 0)
    .sort((a, b) => compareIsoDates(a.date, b.date));

  let balance = new Decimal(terms.principal.amount);
  let interestPaid = new Decimal(0);
  let principalRepaid = new Decimal(0);
  let prepaid = new Decimal(0);
  let accrued = new Decimal(0);
  let cursor = terms.startDate;
  let instalmentsPaid = 0;

  /** Accrues whole months between two dates, leaving part-months to the next step. */
  const accrueTo = (target: IsoDate): void => {
    while (compareIsoDates(addMonths(cursor, 1), target) <= 0) {
      cursor = addMonths(cursor, 1);
      if (balance.lessThanOrEqualTo(0)) break;
      accrued = accrued.plus(balance.times(rate));
    }
  };

  for (const payment of due) {
    accrueTo(payment.date);

    const amount = new Decimal(payment.amount.amount);

    if (payment.isPrepayment === true) {
      // Principal in full. A prepayment does not service accrued interest.
      const applied = Decimal.min(amount, balance);
      balance = balance.minus(applied);
      principalRepaid = principalRepaid.plus(applied);
      prepaid = prepaid.plus(applied);
      continue;
    }

    // Interest first, then principal — the order a lender applies.
    const toInterest = Decimal.min(amount, accrued);
    const toPrincipal = Decimal.min(amount.minus(toInterest), balance);

    accrued = accrued.minus(toInterest);
    interestPaid = interestPaid.plus(toInterest);
    balance = balance.minus(toPrincipal);
    principalRepaid = principalRepaid.plus(toPrincipal);
    instalmentsPaid += 1;
  }

  accrueTo(asOf);

  const money = (value: Decimal) =>
    Money.round(Money.of(Decimal.max(0, value).toFixed(), currency), 2, 'HALF_UP');

  const isClosed = balance.lessThanOrEqualTo(new Decimal('0.01'));
  const remaining = Math.max(0, terms.tenureMonths - instalmentsPaid);

  const percentRepaid = new Decimal(terms.principal.amount).isZero()
    ? '100'
    : Decimal.min(100, principalRepaid.dividedBy(terms.principal.amount).times(100)).toFixed(2);

  const next = schedule.find((instalment) => instalment.number === instalmentsPaid + 1);

  return {
    emi,
    totalPayable,
    totalInterest: Money.subtract(totalPayable, terms.principal),
    paidToDate: Money.sum(
      due.map((payment) => payment.amount),
      currency,
    ),
    principalRepaid: money(principalRepaid),
    interestPaid: money(interestPaid),
    prepaid: money(prepaid),
    outstanding: isClosed ? zero : money(balance),
    instalmentsPaid,
    instalmentsRemaining: isClosed ? 0 : remaining,
    percentRepaid,
    ...(next === undefined || isClosed ? {} : { nextDueDate: next.dueDate }),
    isClosed,
  };
}

/**
 * Principal still owed on a date — the figure net worth is reduced BY.
 *
 * A thin wrapper, exported because `valuation.ts` wants only this and reading a
 * whole progress object to take one field invites the rest being used where it
 * has not been checked.
 */
export function outstandingAsOf(
  terms: AmortisationTerms,
  payments: readonly LoanInstalmentPaid[],
  asOf: IsoDate,
): MoneyValue {
  return progressOf(terms, payments, asOf).outstanding;
}
