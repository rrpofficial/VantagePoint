/**
 * US-3.1 × US-2.6 — the snapshot index the amendment engine depends on.
 *
 * M3 shipped `finaliseWithOfficialRate` against a stub port so it did not need the
 * snapshot package to exist. This closes that loop: a real index built from frozen
 * snapshots, proving the two halves fit and that flagging never mutates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContentHasher, type Snapshot } from '@vantagepoint/snapshot';
import { RateAmendment, RateStore } from '@vantagepoint/fx-itbr';
import { expectOk, inr, seedStandardRates } from '@vantagepoint/test-kit';

function frozenSnapshot(id: string, asOf: string, scope: 'DOMESTIC' | 'FOREIGN'): Snapshot {
  const draft = {
    snapshotId: id,
    kind: scope === 'DOMESTIC' ? ('DOMESTIC_COMPLIANCE' as const) : ('FOREIGN_COMPLIANCE' as const),
    scope,
    asOf,
    positions: [],
    totals: {
      netWorth: inr('1000000'),
      grossAssets: inr('1000000'),
      liabilities: inr('0'),
      byAssetClass: {},
    },
    createdAt: asOf,
    frozen: true as const,
  };
  return Object.freeze({ ...draft, contentHash: ContentHasher.hash(draft) });
}

/** Reports snapshots whose as-of instant is on or after the amended rate date. */
function indexOver(snapshots: readonly Snapshot[]) {
  return {
    snapshotsCovering: (date: string) =>
      snapshots.filter((s) => s.asOf.slice(0, 10) >= date).map((s) => s.snapshotId),
  };
}

const OFFICIAL = {
  currency: 'USD' as const,
  date: '2025-08-15',
  rate: '83.7500',
  source: 'SBI_ITBR' as const,
  rateType: 'TTBR' as const,
  retrievedAt: '2025-08-20T10:00:00+05:30',
  sourceDocumentRef: 'sbi-forex-2025-08-15.pdf',
};

describe('US-2.6 × US-3.1 snapshot index integration', () => {
  beforeEach(() => {
    seedStandardRates();
    RateAmendment.clear();
    RateAmendment.resetSnapshotIndex();
    RateStore.clear();
    seedStandardRates();
  });

  it('reports the frozen snapshots that cover an amended rate date', () => {
    const snapshots = [
      frozenSnapshot('FOR_31DEC2025', '2025-12-31T23:59:59.999+05:30', 'FOREIGN'),
      frozenSnapshot('DOM_31MAR2026', '2026-03-31T23:59:59.999+05:30', 'DOMESTIC'),
      frozenSnapshot('DOM_31MAR2025', '2025-03-31T23:59:59.999+05:30', 'DOMESTIC'),
    ];
    RateAmendment.registerSnapshotIndex(indexOver(snapshots));

    const amendment = expectOk(
      RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official: OFFICIAL }),
    );
    // The March 2025 snapshot predates the amended rate and is unaffected.
    expect([...amendment.affectedSnapshots].sort()).toEqual(['DOM_31MAR2026', 'FOR_31DEC2025']);
  });

  it('leaves every affected snapshot byte-identical (ADR-006)', () => {
    const snapshots = [frozenSnapshot('FOR_31DEC2025', '2025-12-31T23:59:59.999+05:30', 'FOREIGN')];
    const hashesBefore = snapshots.map((s) => s.contentHash);
    RateAmendment.registerSnapshotIndex(indexOver(snapshots));

    expectOk(RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official: OFFICIAL }));

    expect(snapshots.map((s) => s.contentHash)).toEqual(hashesBefore);
    for (const snapshot of snapshots) expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('records the supersession from the RBI fallback to the official SBI rate', () => {
    RateAmendment.registerSnapshotIndex(indexOver([]));
    const amendment = expectOk(
      RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official: OFFICIAL }),
    );
    expect(amendment.previous.valuationRateSource).toBe('RBI_REFERENCE');
    expect(amendment.current.valuationRateSource).toBe('SBI_ITBR');
    expect(RateAmendment.forDate('2025-08-15')).toHaveLength(1);
  });
});
