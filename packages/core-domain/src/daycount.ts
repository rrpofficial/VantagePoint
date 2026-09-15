/**
 * Day-count basis for interest accrual.
 *
 * VantagePoint uses **30/360** throughout. This is not an arbitrary pick — it is the
 * only convention that satisfies both acceptance criteria simultaneously:
 *
 *   PRD FR-1: ₹5,000,000 at 8% from 2025-04-01, valued 2026-03-31 → ₹400,000.
 *     That requires a year fraction of exactly 1.0. ACT/365 gives 364/365 and
 *     yields ₹398,904.11, contradicting the PRD.
 *
 *   US-1.11: accrued interest on the start date itself is zero.
 *     That rules out inclusive-endpoint ACT counting, which would give 365/365 for
 *     the case above but 1 day (not 0) on the start date.
 *
 * 30/360 gives 360/360 = 1.0 for a full financial year and 0 on the start date.
 * Indian private lending has no statutory basis, so the PRD's own figure governs.
 */
import { InvalidDateError } from '@vantagepoint/shared-kernel';
import type { IsoDate } from '@vantagepoint/shared-kernel';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function parseIsoDate(date: IsoDate): Parts {
  const match = ISO.exec(date);
  if (!match) throw new InvalidDateError(`expected YYYY-MM-DD, received "${date}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * 30/360 (US/NASD) day count. Both end-of-month days are clamped to 30, which is
 * what makes a 1-Apr → 31-Mar span come to exactly 360 days.
 */
export function days30360(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const d1 = Math.min(a.day, 30);
  const d2 = a.day >= 30 ? Math.min(b.day, 30) : b.day;
  return 360 * (b.year - a.year) + 30 * (b.month - a.month) + (d2 - d1);
}

/** Year fraction on a 30/360 basis; negative spans clamp to zero. */
export function yearFraction(from: IsoDate, to: IsoDate): number {
  return Math.max(0, days30360(from, to)) / 360;
}

/** Whole calendar months between two dates, used for recurring contributions. */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.max(0, 12 * (b.year - a.year) + (b.month - a.month));
}

export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Adds `days` calendar days, used for settlement-date defaults. */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}
