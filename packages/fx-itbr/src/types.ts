/** FX rate types. Types only — no runtime behaviour. */
import type { Currency, IsoDate, IsoDateTime, Rate } from '@vantagepoint/shared-kernel';
import type { DualRate, RateSource } from '@vantagepoint/core-domain';

export type RateType = 'TTBR' | 'TTSR' | 'REFERENCE';

export interface RateRecord {
  readonly currency: Currency;
  readonly date: IsoDate;
  readonly rate: Rate;
  readonly source: RateSource;
  readonly rateType: RateType;
  readonly retrievedAt: IsoDateTime;
  readonly sourceDocumentRef: string;
}

export interface ResolvedRate {
  readonly rate: Rate;
  readonly source: RateSource;
  readonly appliedDate: IsoDate;
  readonly isFallback: boolean;
  readonly flag?: string;
  /** Ordered list of sources tried, for audit. */
  readonly resolutionPath: readonly string[];
}

/** Amendment linking a provisional rate pair to its finalised replacement (US-2.6). */
export interface RateAmendmentRecord {
  readonly amendmentId: string;
  readonly txnId: string;
  readonly date: IsoDate;
  readonly currency: Currency;
  readonly previous: DualRate;
  readonly current: DualRate;
  /** Frozen snapshots covering `date`. Reported for flagging, never mutated. */
  readonly affectedSnapshots: readonly string[];
}

/**
 * Lookup of frozen snapshots covering a date. Injected so US-2.6 does not need the
 * snapshot package to exist (the tracker listed US-3.1 as a hard dependency).
 */
export interface SnapshotIndex {
  snapshotsCovering(date: IsoDate): readonly string[];
}
