/**
 * VantagePoint shared kernel — the vocabulary every other package speaks.
 *
 * Pure: no I/O, no ambient clock. Time and identity are injected via the `Clock`
 * and `IdGenerator` ports, which is what makes the tax engine deterministically
 * testable across financial years.
 *
 * Types and values are re-exported explicitly rather than with `export *` so that
 * `Money` can be both a type (the value object) and a value (its operations) —
 * a star re-export would let the const shadow the interface.
 */
export * from './errors.js';

export type {
  Result,
  Currency,
  RoundingMode,
  MoneyOps,
  Quantity,
  Rate,
  Percentage,
  IsoDate,
  IsoDateTime,
  Clock,
  IdGenerator,
  FinancialYear,
  AssessmentYear,
  Quarter,
  FyCalendarOps,
  EgressRequest,
  EgressAuditEntry,
  EgressGateway,
} from './types.js';

export { Ok, Err, IST_OFFSET } from './types.js';

import { MoneyImpl } from './money.js';
import { FyCalendarImpl } from './fy-calendar.js';
import type { FyCalendarOps, Money as MoneyValue, MoneyOps } from './types.js';

/**
 * Declared as a local alias rather than re-exported, so that the `Money` type and
 * the `Money` operations object can share a name (TS keeps type and value in
 * separate namespaces, but two export *bindings* of one name collide).
 */
export type Money = MoneyValue;

/** ADR-002: all monetary arithmetic goes through here. */
export const Money: MoneyOps = MoneyImpl;

/** US-5.1: Indian FY/AY calendar and advance-tax quarter boundaries. */
export const FyCalendar: FyCalendarOps = FyCalendarImpl;
