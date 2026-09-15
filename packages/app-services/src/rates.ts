/**
 * FX rate ingestion and coverage (US-2.1, US-2.2).
 *
 * Rates are the one input to a tax figure that cannot be recovered later. SBI
 * publishes today's card and nothing older, so a rate not captured when it was
 * available is gone — which is why the store is in the vault (migration v8) and
 * why an import reports what it could not read instead of quietly narrowing.
 */
import {
  Err,
  Ok,
  VaultStateError,
  type Currency,
  type IsoDate,
  type Result,
} from '@porttrack/shared-kernel';
import {
  FallbackChain,
  Rule115Resolver,
  SbiArchiveParser,
  rateStore,
  type IntradayPolicy,
  type IntradayRevision,
  type SkippedDay,
} from '@porttrack/fx-itbr';
import { RateRepository, Vault } from '@porttrack/persistence';
import { currentPorts } from './context.js';
import { requireEditMode } from './edit-mode.js';

export interface ImportRatesInput {
  readonly csv: string;
  readonly currency: Currency;
  /** Where the file came from. Recorded against rates that name no source PDF. */
  readonly documentRef: string;
  readonly intraday?: IntradayPolicy;
}

export interface ImportRatesReport {
  readonly parsed: number;
  readonly stored: number;
  /** Already present at the identical rate. Re-importing a file is idempotent. */
  readonly alreadyPresent: number;
  readonly earliest: IsoDate;
  readonly latest: IsoDate;
  /** Days SBI published no TT buy rate. A gap the resolver will walk back over. */
  readonly skipped: readonly SkippedDay[];
  /** Days SBI republished a card, and which one was taken. */
  readonly revisions: readonly IntradayRevision[];
}

export interface RateCoverage {
  readonly currency: string;
  readonly source: string;
  readonly count: number;
  readonly earliest: string;
  readonly latest: string;
}

function importArchiveSync(input: ImportRatesInput): Result<ImportRatesReport> {
  if (!Vault.isUnlocked()) return Err(new VaultStateError('vault is locked'));

  const permitted = requireEditMode('importing an exchange-rate archive');
  if (!permitted.ok) return permitted;

  const parsed = SbiArchiveParser.parse(input.csv, {
    currency: input.currency,
    retrievedAt: currentPorts().clock.now(),
    documentRef: input.documentRef,
    ...(input.intraday === undefined ? {} : { intraday: input.intraday }),
  });
  if (!parsed.ok) return parsed;

  const { records, skipped, revisions } = parsed.value;

  // Counted BEFORE the write, so "already present" distinguishes a re-import
  // from a first one rather than reporting every row as newly stored.
  const before = RateRepository.count();
  const written = RateRepository.putAll(
    records.map((record) => ({
      currency: record.currency,
      date: record.date,
      rate: record.rate,
      source: record.source,
      rateType: record.rateType,
      retrievedAt: record.retrievedAt,
      sourceDocumentRef: record.sourceDocumentRef,
    })),
  );
  if (!written.ok) return written;

  const stored = RateRepository.count() - before;
  currentPorts().logger.info('fx rate archive imported');

  return Ok({
    parsed: records.length,
    stored,
    alreadyPresent: records.length - stored,
    earliest: records[0]?.date ?? '',
    latest: records[records.length - 1]?.date ?? '',
    skipped,
    revisions,
  });
}

export const RatesUC = {
  /**
   * Imports a historical archive.
   *
   * Gated on edit mode, unlike other imports. Every other import ADDS records
   * that are visible and correctable; this one writes the denominators that
   * every foreign figure is computed through, where a wrong value is invisible
   * in the output and changes a tax number.
   *
   * Synchronous throughout — parsing is pure and the repository is sync by
   * design (see rate-repository.ts). The Promise is for the caller's benefit, so
   * every use case reads the same way from a route.
   */
  importArchive: (input: ImportRatesInput): Promise<Result<ImportRatesReport>> =>
    Promise.resolve(importArchiveSync(input)),

  /** What the vault holds, so a missing span is visible before a figure depends on it. */
  coverage(): Promise<Result<readonly RateCoverage[]>> {
    if (!Vault.isUnlocked()) {
      return Promise.resolve(Err(new VaultStateError('vault is locked')));
    }
    return Promise.resolve(Ok(RateRepository.coverage()));
  },

  /**
   * Both bases for one date, side by side (ADR-003, risk R4).
   *
   * `transactionDate` is the rate on the day itself — what an RSU's cost basis
   * uses, since the perquisite was taxed in rupees at that rate. `rule115` is the
   * last day of the preceding month, which is what Rule 115 names for capital
   * gains. They differ, the correct one is contested, and the app's job is to
   * show both and record which was applied — not to decide.
   */
  explain(currency: Currency, transactionDate: IsoDate): Result<{
    readonly transactionDate: { date: IsoDate; rate: string; source: string; isFallback: boolean };
    readonly rule115: { date: IsoDate; rate: string; source: string; isFallback: boolean };
  }> {
    if (!Vault.isUnlocked()) return Err(new VaultStateError('vault is locked'));

    const onDate = FallbackChain.resolve(currency, transactionDate);
    if (!onDate.ok) return onDate;

    const rule115 = Rule115Resolver.resolve(currency, transactionDate);
    if (!rule115.ok) return rule115;

    return Ok({
      transactionDate: {
        date: onDate.value.appliedDate,
        rate: onDate.value.rate,
        source: onDate.value.source,
        isFallback: onDate.value.isFallback,
      },
      rule115: {
        date: rule115.value.appliedDate,
        rate: rule115.value.rate,
        source: rule115.value.source,
        isFallback: rule115.value.isFallback,
      },
    });
  },

  /** A single rate typed in by hand, for a date no archive covers. */
  record(input: {
    readonly currency: Currency;
    readonly date: IsoDate;
    readonly rate: string;
    readonly documentRef: string;
  }): Result<void> {
    if (!Vault.isUnlocked()) return Err(new VaultStateError('vault is locked'));

    const permitted = requireEditMode('recording an exchange rate by hand');
    if (!permitted.ok) return permitted;

    if (input.documentRef.trim().length === 0) {
      // Provenance is not optional. A hand-entered rate with no stated source
      // cannot be defended later, and this is the path most likely to produce
      // one — someone reading a number off a screen.
      return Err(
        new VaultStateError('a hand-entered rate must say where it came from'),
      );
    }

    return rateStore.put({
      currency: input.currency,
      date: input.date,
      rate: input.rate,
      source: 'SBI_ITBR',
      rateType: 'TTBR',
      retrievedAt: currentPorts().clock.now(),
      sourceDocumentRef: input.documentRef.trim(),
    });
  },
};
