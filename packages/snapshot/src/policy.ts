/**
 * Compliance snapshot scheduling (US-3.2, US-3.3, PRD FR-3.1).
 *
 * Two statutory freeze points, on different calendars:
 *   31 March    — domestic holdings, aligning with the Indian financial year.
 *   31 December — foreign holdings, aligning with the calendar year that
 *                 Schedule FA reports on.
 * Conflating them would file a US holding in the wrong disclosure year.
 *
 * The scheduler answers "which boundaries were crossed since I last ran?", not
 * "which boundaries have ever passed?". The difference matters: the latter would,
 * on 1 April 2026, also propose a 31-Dec-2025 foreign snapshot crossed three months
 * earlier. Callers that have genuinely been away pass an explicit `since` (their
 * last successful run) and get full catch-up; the default window is 24 hours,
 * matching a daily scheduler.
 *
 * Boundaries are IST end-of-day (ADR-008) and are compared as strings: ISO instants
 * with a fixed +05:30 offset sort lexicographically in time order, so this needs no
 * timezone library and cannot drift with the host's locale.
 */
import { FyCalendar, type IsoDateTime } from '@vantagepoint/shared-kernel';
import type { SnapshotSpec } from './types.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function domesticSnapshotId(year: number): string {
  return `DOM_31MAR${String(year)}`;
}

export function foreignSnapshotId(year: number): string {
  return `FOR_31DEC${String(year)}`;
}

export interface DueSnapshotOptions {
  /** Last successful scheduler run. Defaults to 24 hours before `now`. */
  readonly since?: IsoDateTime;
}

/**
 * Compliance freeze points whose IST end-of-day falls in `(since, now]` and which
 * do not already exist.
 */
export function dueSnapshots(
  now: IsoDateTime,
  existing: readonly string[],
  options: DueSnapshotOptions = {},
): readonly SnapshotSpec[] {
  const since = options.since ?? defaultSince(now);
  const known = new Set(existing);
  const nowYear = Number(now.slice(0, 4));
  const sinceYear = Number(since.slice(0, 4));

  const candidates: SnapshotSpec[] = [];
  for (let year = sinceYear; year <= nowYear; year++) {
    candidates.push({
      snapshotId: domesticSnapshotId(year),
      kind: 'DOMESTIC_COMPLIANCE',
      scope: 'DOMESTIC',
      asOf: FyCalendar.endOfDayIst(`${String(year)}-03-31`),
    });
    candidates.push({
      snapshotId: foreignSnapshotId(year),
      kind: 'FOREIGN_COMPLIANCE',
      scope: 'FOREIGN',
      asOf: FyCalendar.endOfDayIst(`${String(year)}-12-31`),
    });
  }

  return candidates
    .filter((spec) => spec.asOf > since && spec.asOf <= now && !known.has(spec.snapshotId))
    .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

function defaultSince(now: IsoDateTime): IsoDateTime {
  const offset = now.slice(-6);
  const shifted = new Date(new Date(now).getTime() - DEFAULT_WINDOW_MS);
  // Rebuild in the original offset so string comparison stays valid.
  const local = new Date(shifted.getTime() + offsetMinutes(offset) * 60_000);
  return `${local.toISOString().slice(0, 23)}${offset}`;
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return sign * (hours * 60 + minutes);
}
