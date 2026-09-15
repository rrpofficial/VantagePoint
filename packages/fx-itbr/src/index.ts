/**
 * fx-itbr — SBI ITBR rate store, fallback chain, Rule 115 and dual-rate conversion.
 * Pure: fetching rate sheets is `adapters-fx`; this package only reasons about them.
 */
import type { Currency, IsoDate, Result } from '@vantagepoint/shared-kernel';
import { rateStore } from './rate-store.js';
import {
  convert,
  ratesFor,
  resolveRule115,
  resolveWithFallback,
  rule115BasisDate,
} from './resolvers.js';
import { parseSbiSheet, type SbiParseOptions } from './sbi-sheet.js';
import {
  parseSbiArchive,
  type ArchiveParseOptions,
  type ArchiveParseResult,
} from './sbi-archive.js';
import {
  amendmentLog,
  amendmentsForDate,
  clearAmendments,
  finaliseWithOfficialRate,
  isProvisional,
  registerSnapshotIndex,
  resetSnapshotIndex,
} from './amendment.js';
import type { RateRecord } from './types.js';

export * from './types.js';
export {
  InMemoryRateStore,
  rateStore,
  resetRateStore,
  useRateStore,
  type RateStorePort,
} from './rate-store.js';
export { FALLBACK_ORDER, FALLBACK_FLAG } from './resolvers.js';

/** US-2.1 — rate storage with provenance. */
export const RateStore = {
  put: (record: RateRecord): Result<void> => rateStore.put(record),
  get: (currency: Currency, date: IsoDate, source: RateRecord['source']) =>
    rateStore.get(currency, date, source),
  latestOnOrBefore: (currency: Currency, date: IsoDate, source: RateRecord['source']) =>
    rateStore.latestOnOrBefore(currency, date, source),
  clear: () => { rateStore.clear(); },
};

/** US-2.3 — SBI → RBI → ECB → OANDA. */
export const FallbackChain = { resolve: resolveWithFallback };

/** US-2.4 — Rule 115 of the Income Tax Rules. */
export const Rule115Resolver = { basisDateFor: rule115BasisDate, resolve: resolveRule115 };

/** US-2.5 — the dual-rate service (ADR-003). */
export const DualRateConverter = { ratesFor, convert };

/** US-2.2 — SBI rate sheet ingestion. */
export const SbiSheetParser = {
  parse: (sheet: string, options?: SbiParseOptions): Result<readonly RateRecord[]> =>
    parseSbiSheet(sheet, options),
};

/**
 * US-2.2 — historical TT Buy archive, for dates SBI no longer publishes.
 *
 * A separate parser from the daily sheet because it is a separate trust level:
 * the daily sheet comes from SBI, the archive is someone's transcription of it.
 */
export const SbiArchiveParser = {
  parse: (csv: string, options: ArchiveParseOptions): Result<ArchiveParseResult> =>
    parseSbiArchive(csv, options),
};
export {
  ArchiveFormatError,
  type ArchiveParseOptions,
  type ArchiveParseResult,
  type IntradayPolicy,
  type IntradayRevision,
  type SkippedDay,
} from './sbi-archive.js';

/** US-2.6 — retroactive finalisation of provisional rates. */
export const RateAmendment = {
  finaliseWithOfficialRate,
  isProvisional,
  log: amendmentLog,
  forDate: amendmentsForDate,
  clear: clearAmendments,
  registerSnapshotIndex,
  resetSnapshotIndex,
};
