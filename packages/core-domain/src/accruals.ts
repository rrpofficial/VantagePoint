/**
 * Interest accrual for non-market assets (US-1.8, US-1.9, US-1.11, US-1.12).
 *
 * All day counts use 30/360 — see daycount.ts for why that basis and not ACT/365.
 */
import { Money, type IsoDate, type Money as MoneyValue, type Percentage } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { compareIsoDates, monthsBetween, yearFraction } from './daycount.js';
import type {
  DepositInput,
  DepositResult,
  EpfInput,
  EpfResult,
  GratuityInput,
  HandLoan,
} from './types.js';

const pct = (value: Percentage) => new Decimal(value).dividedBy(100);

/**
 * Simple interest on the outstanding principal, recomputed across each repayment
 * period. Interest stops on repaid principal from the repayment date forward.
 */
export function handLoanAccruedInterest(loan: HandLoan, asOf: IsoDate): MoneyValue {
  if (compareIsoDates(asOf, loan.startDate) <= 0) {
    return Money.zero(loan.principal.currency);
  }

  const repayments = [...loan.repayments]
    .filter((r) => compareIsoDates(r.date, asOf) <= 0)
    .sort((a, b) => compareIsoDates(a.date, b.date));

  const rate = pct(loan.interestRatePct);
  let outstanding = new Decimal(loan.principal.amount);
  let periodStart = loan.startDate;
  let interest = new Decimal(0);

  const accrue = (from: IsoDate, to: IsoDate, principal: Decimal): void => {
    const fraction = yearFraction(from, to);
    if (fraction <= 0) return;
    interest = interest.plus(principal.times(rate).times(fraction));
  };

  for (const repayment of repayments) {
    accrue(periodStart, repayment.date, outstanding);
    outstanding = Decimal.max(0, outstanding.minus(repayment.principal.amount));
    periodStart = repayment.date;
  }
  accrue(periodStart, asOf, outstanding);

  return Money.round(
    Money.of(interest.toFixed(), loan.principal.currency),
    2,
    'HALF_UP',
  );
}

/** Outstanding principal after repayments up to `asOf`. */
export function handLoanOutstandingPrincipal(loan: HandLoan, asOf: IsoDate): MoneyValue {
  const repaid = loan.repayments
    .filter((r) => compareIsoDates(r.date, asOf) <= 0)
    .reduce((sum, r) => sum.plus(r.principal.amount), new Decimal(0));
  const outstanding = Decimal.max(0, new Decimal(loan.principal.amount).minus(repaid));
  return Money.of(outstanding.toFixed(), loan.principal.currency);
}

const PERIODS_PER_YEAR = { MONTHLY: 12, QUARTERLY: 4, ANNUAL: 1 } as const;

/** Compound interest on a lump-sum deposit (FD). */
export function depositAccruedValue(input: DepositInput): DepositResult {
  const currency = input.principal.currency;
  const periods = PERIODS_PER_YEAR[input.compounding];
  const elapsed = yearFraction(input.startDate, input.asOf) * periods;
  const principal = new Decimal(input.principal.amount);

  const growth = new Decimal(1).plus(pct(input.annualRatePct).dividedBy(periods));
  const value = principal.times(growth.toPower(elapsed));

  const rounded = Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');
  return {
    value: rounded,
    accruedInterest: Money.subtract(rounded, input.principal),
  };
}

/**
 * Total contributed into a recurring scheme (RD, chit fund) by `asOf`.
 * Instalments are counted inclusive of the opening month.
 */
export function recurringContributions(input: {
  instalment: MoneyValue;
  startDate: IsoDate;
  asOf: IsoDate;
}): { readonly contributions: MoneyValue; readonly instalmentsPaid: number } {
  if (compareIsoDates(input.asOf, input.startDate) < 0) {
    return { contributions: Money.zero(input.instalment.currency), instalmentsPaid: 0 };
  }
  const instalmentsPaid = monthsBetween(input.startDate, input.asOf) + 1;
  return {
    contributions: Money.multiply(input.instalment, instalmentsPaid),
    instalmentsPaid,
  };
}

/**
 * EPF/VPF projection. Interest is credited on the monthly running balance, which
 * is materially more than a flat rate on the opening balance once contributions
 * accumulate — the distinction the acceptance criteria check for.
 */
export function epfProjection(input: EpfInput): EpfResult {
  const currency = input.openingBalance.currency;
  // Inclusive of the opening month: 1-Apr → 31-Mar is twelve contributions, not eleven.
  const months = monthsBetween(input.fromDate, input.toDate) + 1;
  const monthlyRate = pct(input.annualRatePct).dividedBy(12);
  const monthlyContribution = new Decimal(input.monthlyEmployee.amount).plus(
    input.monthlyEmployer.amount,
  );

  let balance = new Decimal(input.openingBalance.amount);
  let interest = new Decimal(0);

  for (let month = 0; month < months; month++) {
    balance = balance.plus(monthlyContribution);
    const monthInterest = balance.times(monthlyRate);
    interest = interest.plus(monthInterest);
    balance = balance.plus(monthInterest);
  }

  const contributions = monthlyContribution.times(months);
  const round = (value: Decimal) => Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');

  const roundedContributions = round(contributions);
  const roundedInterest = round(interest);
  return {
    contributions: roundedContributions,
    interest: roundedInterest,
    closingBalance: Money.sum(
      [input.openingBalance, roundedContributions, roundedInterest],
      currency,
    ),
  };
}

/**
 * Gratuity under the Payment of Gratuity Act: 15/26 × last drawn monthly wage ×
 * completed years, payable only after five completed years of service.
 */
export function gratuity(input: GratuityInput): MoneyValue {
  const currency = input.lastDrawnMonthly.currency;
  if (input.completedYears < 5) return Money.zero(currency);

  const value = new Decimal(input.lastDrawnMonthly.amount)
    .times(15)
    .dividedBy(26)
    .times(input.completedYears);
  return Money.round(Money.of(value.toFixed(), currency), 2, 'HALF_UP');
}
