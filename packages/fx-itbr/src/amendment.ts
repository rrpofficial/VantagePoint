/**
 * Retroactive rate finalisation (US-2.6, PRD FR-2.1).
 *
 * A transaction converted on an RBI fallback carries a provisional number. When the
 * official SBI rate is published days later, the correct behaviour is *not* to
 * quietly recompute: a frozen snapshot is a compliance artifact (ADR-006), and
 * silently changing what it says destroys the reason it exists.
 *
 * So this records an amendment linking the old rates to the new, and reports which
 * frozen snapshots are affected so they can be FLAGGED `supersededRateAvailable`.
 * Nothing here mutates a snapshot.
 *
 * The tracker had this story depending on US-3.1 (snapshots, M4). That dependency
 * is real but does not need to be a build-order dependency: the snapshot lookup is
 * an injected port, defaulting to "no snapshots known".
 */
import { Err, NotOfficialRateError, Ok, type IsoDate, type Result } from '@vantagepoint/shared-kernel';
import type { DualRate } from '@vantagepoint/core-domain';
import { rateStore } from './rate-store.js';
import { ratesFor } from './resolvers.js';
import type { RateAmendmentRecord, RateRecord, SnapshotIndex } from './types.js';

/** Default: nothing known about snapshots. M4 registers the real index. */
let snapshotIndex: SnapshotIndex = { snapshotsCovering: () => [] };

export function registerSnapshotIndex(index: SnapshotIndex): void {
  snapshotIndex = index;
}

export function resetSnapshotIndex(): void {
  snapshotIndex = { snapshotsCovering: () => [] };
}

const amendments: RateAmendmentRecord[] = [];

export function amendmentLog(): readonly RateAmendmentRecord[] {
  return [...amendments];
}

export function clearAmendments(): void {
  amendments.length = 0;
}

/**
 * Supersedes a provisional rate with the official SBI rate for the same date.
 * `official.date` identifies the date being finalised.
 */
export function finaliseWithOfficialRate(input: {
  txnId: string;
  official: RateRecord;
}): Result<RateAmendmentRecord> {
  const { official, txnId } = input;

  if (official.source !== 'SBI_ITBR') {
    return Err(
      new NotOfficialRateError('only an SBI ITBR rate can finalise a provisional conversion'),
    );
  }

  // Resolve as things stand — this is the provisional pair the transaction used.
  const before = ratesFor(official.currency, official.date);
  if (!before.ok) return before;

  const stored = rateStore.put(official);
  if (!stored.ok) return stored;

  const after = ratesFor(official.currency, official.date);
  if (!after.ok) return after;

  const record: RateAmendmentRecord = {
    amendmentId: `amd_${String(amendments.length + 1).padStart(6, '0')}`,
    txnId,
    date: official.date,
    currency: official.currency,
    previous: before.value,
    current: after.value,
    // Reported, never mutated (ADR-006).
    affectedSnapshots: snapshotIndex.snapshotsCovering(official.date),
  };
  amendments.push(record);
  return Ok(record);
}

/** True when a transaction's rates were provisional and can still be superseded. */
export function isProvisional(rates: DualRate): boolean {
  return rates.isFallback;
}

export function amendmentsForDate(date: IsoDate): readonly RateAmendmentRecord[] {
  return amendments.filter((amendment) => amendment.date === date);
}
