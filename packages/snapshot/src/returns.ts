/**
 * Return measures (US-3.8).
 *
 * XIRR uses bisection rather than Newton-Raphson. Newton is faster but diverges on
 * the irregular, sign-alternating cash flows a real portfolio produces, and a
 * silently divergent solver returning NaN — or worse, a plausible wrong number —
 * is exactly what must not happen in a returns figure. Bisection is slower and
 * always right when a root is bracketed, and reports honestly when it is not.
 */
import {
  Err,
  Ok,
  XirrNonConvergenceError,
  type Money as MoneyValue,
  type Percentage,
  type Result,
} from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { CashFlow } from './types.js';

const DAYS_PER_YEAR = 365;
const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-9;
/** Rates below -100% are meaningless; the upper bound covers any real portfolio. */
const RATE_LOWER_BOUND = -0.9999999;
const RATE_UPPER_BOUND = 1000;

const dayDiff = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

function npv(rate: number, flows: readonly { years: number; amount: number }[]): number {
  return flows.reduce((sum, flow) => sum + flow.amount / (1 + rate) ** flow.years, 0);
}

export function xirr(cashFlows: readonly CashFlow[]): Result<Percentage> {
  if (cashFlows.length < 2) {
    return Err(new XirrNonConvergenceError('at least two cash flows are required'));
  }

  const sorted = [...cashFlows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const origin = sorted[0]?.date ?? '';
  const flows = sorted.map((flow) => ({
    years: dayDiff(origin, flow.date) / DAYS_PER_YEAR,
    amount: Number(flow.amount.amount),
  }));

  const hasInflow = flows.some((flow) => flow.amount > 0);
  const hasOutflow = flows.some((flow) => flow.amount < 0);
  if (!hasInflow || !hasOutflow) {
    // No sign change means no root: there is no rate at which this breaks even.
    return Err(
      new XirrNonConvergenceError('cash flows must contain both an inflow and an outflow'),
    );
  }

  let low = RATE_LOWER_BOUND;
  let high = RATE_UPPER_BOUND;
  let npvLow = npv(low, flows);
  const npvHigh = npv(high, flows);

  if (npvLow * npvHigh > 0) {
    return Err(new XirrNonConvergenceError('no rate brackets a zero net present value'));
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid, flows);
    if (Math.abs(npvMid) < TOLERANCE || high - low < TOLERANCE) {
      return Ok(new Decimal(mid).times(100).toFixed(4));
    }
    if (npvLow * npvMid <= 0) {
      high = mid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }

  return Err(new XirrNonConvergenceError(`did not converge within ${String(MAX_ITERATIONS)} iterations`));
}

/** Compound annual growth rate over `years`. */
export function cagr(begin: MoneyValue, end: MoneyValue, years: string): Percentage {
  const start = new Decimal(begin.amount);
  const period = new Decimal(years);
  if (start.lessThanOrEqualTo(0) || period.lessThanOrEqualTo(0)) return '0';
  const growth = new Decimal(end.amount).dividedBy(start).toNumber();
  return new Decimal(growth ** (1 / period.toNumber()) - 1).times(100).toFixed(4);
}

export function absoluteReturn(begin: MoneyValue, end: MoneyValue): Percentage {
  const start = new Decimal(begin.amount);
  if (start.isZero()) return '0';
  return new Decimal(end.amount).minus(start).dividedBy(start.abs()).times(100).toFixed(4);
}
