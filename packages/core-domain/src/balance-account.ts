/**
 * Balance-shaped holdings (Phase 5, objectives 1 and 4).
 *
 * A fixed deposit is a balance with a rate and a maturity, not a quantity at a
 * price. Forcing one through the trade shape is what produced the situation this
 * module closes: `accruals.ts` has implemented `depositAccruedValue`,
 * `recurringContributions`, `epfProjection` and `gratuity` since US-1.8, all
 * unit-tested, and **none had a non-test caller** — because nothing could enter
 * an asset for them to run on. A deposit, had one been enterable, would have sat
 * at cost forever.
 *
 * Everything here is composition over `accruals.ts`. No new interest arithmetic
 * is invented; what is added is which function applies, over what window, and
 * what the answer means when a rate was never supplied.
 *
 * ## Two rules the whole module turns on
 *
 *  1. **No rate, no growth.** A balance with no stated rate is carried flat and
 *     says so. Assuming "about 7%" would put a fabricated return into net worth
 *     and, through the other-sources derivation, into a tax figure.
 *  2. **A closed account is worth nil here.** The proceeds are a bank balance
 *     now. Carrying both would report the same rupees twice — the same trap the
 *     chit valuation documents.
 */
import { Money, type IsoDate, type Money as MoneyValue } from '@porttrack/shared-kernel';
import {
  depositAccruedValue,
  epfProjection,
  gratuity,
  recurringContributions,
} from './accruals.js';
import { addMonths } from './amortisation.js';
import { compareIsoDates, monthsBetween } from './daycount.js';
import type { BalanceAccount, BalanceView } from './types.js';

const DEFAULT_COMPOUNDING = 'QUARTERLY' as const;

const NO_RATE =
  'no interest rate was recorded, so this balance is carried flat rather than grown from an assumed one';

/** The earlier of two dates. Accrual never runs past maturity or past closure. */
const earlier = (a: IsoDate, b: IsoDate): IsoDate => (compareIsoDates(a, b) <= 0 ? a : b);

/**
 * The date accrual stops.
 *
 * A matured deposit stops earning on its maturity date; it does not keep
 * compounding for the years it sat un-renewed. A closed one stops when it closed.
 */
function accrualEndFor(account: BalanceAccount, asOf: IsoDate): IsoDate {
  let end = asOf;
  if (account.maturityDate !== undefined) end = earlier(end, account.maturityDate);
  if (account.closedOn !== undefined) end = earlier(end, account.closedOn);
  return end;
}

function termDeposit(account: BalanceAccount, asOf: IsoDate): Omit<BalanceView, 'account' | 'asOf' | 'matured' | 'closed'> {
  const contributed = account.openingBalance;
  const zero = Money.zero(contributed.currency);

  const matured =
    account.maturityDate !== undefined && compareIsoDates(asOf, account.maturityDate) >= 0;

  /*
   * The certificate wins once the deposit has matured. Before maturity it does
   * not: a maturity figure applied early would report the full term's interest
   * on day one.
   */
  if (matured && account.maturityValue !== undefined) {
    return {
      value: account.maturityValue,
      contributed,
      accruedInterest: Money.subtract(account.maturityValue, contributed),
    };
  }

  if (account.annualRatePct === undefined) {
    return { value: contributed, contributed, accruedInterest: zero, flatReason: NO_RATE };
  }

  const accrued = depositAccruedValue({
    principal: contributed,
    annualRatePct: account.annualRatePct,
    compounding: account.compounding ?? DEFAULT_COMPOUNDING,
    startDate: account.openedOn,
    asOf: accrualEndFor(account, asOf),
  });
  return { value: accrued.value, contributed, accruedInterest: accrued.accruedInterest };
}

/**
 * A recurring deposit, valued as what it is: a series of small deposits.
 *
 * `recurringContributions` supplies how many instalments have been paid and what
 * they add up to — the cost basis. The value is each of those instalments
 * compounded from the date it was paid, which is `depositAccruedValue` applied
 * once per instalment. A single compounding of the whole contributed sum from
 * the opening date would credit the last instalment with the first one's
 * interest.
 */
function recurringDeposit(
  account: BalanceAccount,
  asOf: IsoDate,
): Omit<BalanceView, 'account' | 'asOf' | 'matured' | 'closed'> {
  const currency = account.openingBalance.currency;
  const instalment = account.monthlyContribution ?? Money.zero(currency);
  const end = accrualEndFor(account, asOf);

  const paid = recurringContributions({
    instalment,
    startDate: account.openedOn,
    asOf: end,
  });
  const contributed = Money.add(account.openingBalance, paid.contributions);

  if (account.annualRatePct === undefined) {
    return {
      value: contributed,
      contributed,
      accruedInterest: Money.zero(currency),
      instalmentsPaid: paid.instalmentsPaid,
      flatReason: NO_RATE,
    };
  }

  const compounding = account.compounding ?? DEFAULT_COMPOUNDING;
  const grown: MoneyValue[] = [];
  for (let index = 0; index < paid.instalmentsPaid; index++) {
    grown.push(
      depositAccruedValue({
        principal: instalment,
        annualRatePct: account.annualRatePct,
        compounding,
        startDate: addMonths(account.openedOn, index),
        asOf: end,
      }).value,
    );
  }
  // Any opening lump sum compounds from the opening date alongside them.
  if (Money.compare(account.openingBalance, Money.zero(currency)) > 0) {
    grown.push(
      depositAccruedValue({
        principal: account.openingBalance,
        annualRatePct: account.annualRatePct,
        compounding,
        startDate: account.openedOn,
        asOf: end,
      }).value,
    );
  }

  const value = Money.sum(grown, currency);
  return {
    value,
    contributed,
    accruedInterest: Money.subtract(value, contributed),
    instalmentsPaid: paid.instalmentsPaid,
  };
}

function providentFund(
  account: BalanceAccount,
  asOf: IsoDate,
): Omit<BalanceView, 'account' | 'asOf' | 'matured' | 'closed'> {
  const currency = account.openingBalance.currency;
  const employee = account.monthlyContribution ?? Money.zero(currency);
  const employer = account.employerContribution ?? Money.zero(currency);
  const end = accrualEndFor(account, asOf);

  /*
   * Months that have ELAPSED since the stated balance — not `epfProjection`'s
   * own inclusive count.
   *
   * `epfProjection` counts the opening month, which is right for its own
   * contract (1 Apr → 31 Mar is twelve contributions) and wrong here: the
   * balance is stated AS AT `openedOn`, so whatever happened in that month is
   * already inside it. Counting it again credited a month's contribution and a
   * month's interest on the very day the figure was entered — a day-one
   * overstatement of net worth, and one that repeats on every restatement.
   *
   * So the projection window starts a month later and the elapsed count is
   * recovered exactly, and a zero-month window skips the projection entirely
   * rather than being rounded up to one.
   */
  const elapsedMonths = monthsBetween(account.openedOn, end);

  if (account.annualRatePct === undefined || elapsedMonths === 0) {
    const contributed = Money.add(
      account.openingBalance,
      Money.multiply(Money.add(employee, employer), elapsedMonths),
    );
    return {
      value: contributed,
      contributed,
      accruedInterest: Money.zero(currency),
      ...(account.annualRatePct === undefined ? { flatReason: NO_RATE } : {}),
    };
  }

  const projected = epfProjection({
    openingBalance: account.openingBalance,
    monthlyEmployee: employee,
    monthlyEmployer: employer,
    annualRatePct: account.annualRatePct,
    fromDate: addMonths(account.openedOn, 1),
    toDate: end,
  });

  return {
    value: projected.closingBalance,
    contributed: Money.add(account.openingBalance, projected.contributions),
    accruedInterest: projected.interest,
  };
}

function gratuityEntitlement(
  account: BalanceAccount,
  asOf: IsoDate,
): Omit<BalanceView, 'account' | 'asOf' | 'matured' | 'closed'> {
  const currency = account.openingBalance.currency;
  const wage = account.lastDrawnMonthly;
  const completedYears = Math.floor(monthsBetween(account.openedOn, accrualEndFor(account, asOf)) / 12);

  if (wage === undefined) {
    return {
      value: Money.zero(currency),
      contributed: Money.zero(currency),
      accruedInterest: Money.zero(currency),
      completedYears,
      flatReason: 'no last-drawn monthly wage was recorded, so the 15/26 formula has no base',
    };
  }

  const value = gratuity({ lastDrawnMonthly: wage, completedYears });
  return {
    value,
    /*
     * Cost basis equals the entitlement, so nothing here shows as a gain.
     *
     * Gratuity is earned, not bought — there is no acquisition cost, and a zero
     * basis would report the whole entitlement as an unrealised gain it can
     * never be. It is also exempt under s.10(10) up to the statutory ceiling,
     * so a "gain" figure here would be doubly misleading.
     */
    contributed: value,
    accruedInterest: Money.zero(currency),
    completedYears,
    ...(completedYears < 5
      ? {
          flatReason:
            'gratuity is payable only after five completed years of service, so the entitlement is nil until then',
        }
      : {}),
  };
}

function statedBalance(account: BalanceAccount): Omit<BalanceView, 'account' | 'asOf' | 'matured' | 'closed'> {
  return {
    value: account.openingBalance,
    contributed: account.openingBalance,
    accruedInterest: Money.zero(account.openingBalance.currency),
    flatReason:
      'a stated balance moves only when you restate it — this application has no NAV or transaction feed to move it for you',
  };
}

/** What a balance account is worth on a date, and what it is made of. */
export function viewOf(account: BalanceAccount, asOf: IsoDate): BalanceView {
  const closed = account.closedOn !== undefined && compareIsoDates(asOf, account.closedOn) >= 0;
  const matured =
    account.maturityDate !== undefined && compareIsoDates(asOf, account.maturityDate) >= 0;

  if (closed) {
    const zero = Money.zero(account.openingBalance.currency);
    return {
      account,
      asOf,
      value: zero,
      contributed: zero,
      accruedInterest: zero,
      matured,
      closed,
      flatReason:
        'this account was closed; the proceeds are cash in a bank account and are counted there, not twice',
    };
  }

  const computed =
    account.kind === 'TERM_DEPOSIT'
      ? termDeposit(account, asOf)
      : account.kind === 'RECURRING_DEPOSIT'
        ? recurringDeposit(account, asOf)
        : account.kind === 'PROVIDENT_FUND'
          ? providentFund(account, asOf)
          : account.kind === 'GRATUITY'
            ? gratuityEntitlement(account, asOf)
            : statedBalance(account);

  return { account, asOf, matured, closed, ...computed };
}

/**
 * Interest that accrued DURING a window, for the other-sources derivation.
 *
 * Closing minus opening, for the same reason `accruedDuring` computes hand-loan
 * interest that way: the cumulative figure would tax the whole life of the
 * deposit in every year it is open, an error that grows with its age and never
 * corrects itself.
 */
export function interestAccruedBetween(
  account: BalanceAccount,
  from: IsoDate,
  to: IsoDate,
): MoneyValue {
  const opening = viewOf(account, from).accruedInterest;
  const closing = viewOf(account, to).accruedInterest;
  const difference = Money.subtract(closing, opening);
  // A closure inside the window drops the closing figure to nil; negative
  // interest income is not a thing.
  return Money.compare(difference, Money.zero(difference.currency)) < 0
    ? Money.zero(difference.currency)
    : difference;
}
