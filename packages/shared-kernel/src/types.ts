/** Shared vocabulary. Types only — no runtime behaviour lives here. */
import type { DomainError } from './errors.js';

/* ------------------------------------------------------------------ result */

export type Result<T, E extends DomainError = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E extends DomainError>(error: E): Result<never, E> => ({ ok: false, error });

/* ------------------------------------------------------------------- money */

export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'SGD' | 'AED';

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

/**
 * The only legal representation of a monetary amount (ADR-002).
 * `amount` is a decimal string so it survives serialisation without float drift.
 */
export interface Money {
  readonly amount: string;
  readonly currency: Currency;
}

export interface MoneyOps {
  of(amount: string | number, currency: Currency): Money;
  /** User input → Money, without throwing. Accepts digit grouping (`1,00,000`). */
  parse(amount: string | number, currency: Currency): Result<Money>;
  /** A stored amount → canonical Money. Never throws; unreadable reads as zero. */
  fromStorage(amount: string, currency: Currency): Money;
  add(a: Money, b: Money): Money;
  subtract(a: Money, b: Money): Money;
  multiply(a: Money, factor: string | number): Money;
  divide(a: Money, divisor: string | number): Money;
  compare(a: Money, b: Money): -1 | 0 | 1;
  equals(a: Money, b: Money): boolean;
  isZero(a: Money): boolean;
  negate(a: Money): Money;
  /** Rounds to `dp` decimal places using `mode`. Explicit at every call site. */
  round(a: Money, dp: number, mode: RoundingMode): Money;
  /** Section 288B: tax payable rounds to the nearest ₹10. */
  roundToNearestTen(a: Money): Money;
  zero(currency: Currency): Money;
  sum(items: readonly Money[], currency: Currency): Money;
}

/** Non-monetary exact decimals (quantities, rates, percentages). */
export type Quantity = string;
export type Rate = string;
export type Percentage = string;

/* -------------------------------------------------------------------- time */

/** `YYYY-MM-DD`. */
export type IsoDate = string;
/** ISO-8601 with offset, always `+05:30` at VantagePoint boundaries (ADR-008). */
export type IsoDateTime = string;

export const IST_OFFSET = '+05:30' as const;

export interface Clock {
  now(): IsoDateTime;
  today(): IsoDate;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** `2025-26`. */
export type FinancialYear = string;
/** `2026-27`. */
export type AssessmentYear = string;
export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface FyCalendarOps {
  financialYearOf(date: IsoDate): FinancialYear;
  assessmentYearOf(fy: FinancialYear): AssessmentYear;
  fyStart(fy: FinancialYear): IsoDate;
  fyEnd(fy: FinancialYear): IsoDate;
  advanceTaxDueDate(fy: FinancialYear, quarter: Quarter): IsoDate;
  cumulativePercentage(quarter: Quarter): Percentage;
  /** IST end-of-day instant for a calendar date (ADR-008). */
  endOfDayIst(date: IsoDate): IsoDateTime;
}

/* ------------------------------------------------------------------ egress */

export interface EgressRequest {
  readonly url: string;
  readonly purpose: 'FX_RATE' | 'NAV_REFRESH' | 'AI_INSIGHT';
  readonly body?: string;
}

export interface EgressAuditEntry {
  readonly destination: string;
  readonly purpose: string;
  readonly timestamp: IsoDateTime;
  readonly payloadBytes: number;
}

export interface EgressGateway {
  dispatch(request: EgressRequest): Promise<Result<string>>;
  auditLog(): readonly EgressAuditEntry[];
}
