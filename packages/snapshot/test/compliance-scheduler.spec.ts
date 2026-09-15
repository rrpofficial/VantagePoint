/**
 * US-3.1 — Immutable content-addressed snapshot (PRD FR-3.1, ADR-006)
 * US-3.2 — 31-Mar domestic auto snapshot (PRD FR-3 AC)
 * US-3.3 — 31-Dec foreign auto snapshot (PRD FR-3 AC)
 * US-3.4 — Custom arbitrary-date snapshot
 */
import { describe, it, expect } from 'vitest';
import { CompliancePolicy, ContentHasher, SnapshotFactory, type Snapshot } from '@vantagepoint/snapshot';
import { expectErr, expectOk, inr } from '@vantagepoint/test-kit';

/**
 * Builds a genuine snapshot: deeply frozen, with its real content hash. A literal
 * placeholder hash would make the hash and verify assertions unsatisfiable, and an
 * unfrozen object would make the immutability assertion vacuous.
 */
const aSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot => {
  const draft = {
    snapshotId: 'DOM_31MAR2026',
    kind: 'DOMESTIC_COMPLIANCE' as const,
    scope: 'DOMESTIC' as const,
    asOf: '2026-03-31T23:59:59.999+05:30',
    positions: [],
    totals: {
      netWorth: inr('250000000'),
      grossAssets: inr('258000000'),
      liabilities: inr('8000000'),
      byAssetClass: {},
    },
    createdAt: '2026-04-01T00:05:00+05:30',
    frozen: true as const,
  };
  const withHash = { ...draft, contentHash: ContentHasher.hash(draft), ...overrides };
  return deepFreeze(withHash);
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

describe('US-3.2 / US-3.3 compliance snapshot scheduler', () => {
  describe('Scenario: Dual compliance snapshot generation (PRD FR-3 AC)', () => {
    it('creates DOM_31MAR2026 when the system date reaches 2026-04-01', () => {
      const due = CompliancePolicy.dueSnapshots('2026-04-01T00:05:00+05:30', []);
      expect(due.map((s) => s.snapshotId)).toContain('DOM_31MAR2026');
    });

    it('scopes the domestic snapshot to 31-Mar-2026 IST EOD', () => {
      const due = CompliancePolicy.dueSnapshots('2026-04-01T00:05:00+05:30', []);
      const dom = due.find((s) => s.snapshotId === 'DOM_31MAR2026');
      expect(dom?.asOf).toBe('2026-03-31T23:59:59.999+05:30');
      expect(dom?.scope).toBe('DOMESTIC');
    });

    it('creates FOR_31DEC2026 when the calendar date reaches 2027-01-01', () => {
      const due = CompliancePolicy.dueSnapshots('2027-01-01T00:05:00+05:30', []);
      expect(due.map((s) => s.snapshotId)).toContain('FOR_31DEC2026');
    });

    it('scopes the foreign snapshot to 31-Dec-2026 IST EOD', () => {
      const due = CompliancePolicy.dueSnapshots('2027-01-01T00:05:00+05:30', []);
      const foreign = due.find((s) => s.snapshotId === 'FOR_31DEC2026');
      expect(foreign?.asOf).toBe('2026-12-31T23:59:59.999+05:30');
      expect(foreign?.scope).toBe('FOREIGN');
    });

    it('does not schedule a foreign snapshot on 1 April', () => {
      const due = CompliancePolicy.dueSnapshots('2026-04-01T00:05:00+05:30', []);
      expect(due.some((s) => s.scope === 'FOREIGN')).toBe(false);
    });
  });

  describe('Scenario: Scheduler is idempotent', () => {
    it('returns nothing when DOM_31MAR2026 already exists', () => {
      expect(CompliancePolicy.dueSnapshots('2026-04-02T00:05:00+05:30', ['DOM_31MAR2026'])).toEqual(
        [],
      );
    });

    it('raises no error on a repeat run', () => {
      expect(() =>
        CompliancePolicy.dueSnapshots('2026-04-02T00:05:00+05:30', ['DOM_31MAR2026']),
      ).not.toThrow();
    });
  });

  describe('Scenario: EOD boundary is Asia/Kolkata (ADR-008)', () => {
    it('names the domestic snapshot for the financial year just ended', () => {
      expect(CompliancePolicy.domesticSnapshotId(2026)).toBe('DOM_31MAR2026');
    });

    it('names the foreign snapshot for the calendar year just ended', () => {
      expect(CompliancePolicy.foreignSnapshotId(2026)).toBe('FOR_31DEC2026');
    });

    it('does not schedule the 31-Mar snapshot at 2026-03-31T23:45 IST, before EOD', () => {
      expect(CompliancePolicy.dueSnapshots('2026-03-31T23:45:00+05:30', [])).toEqual([]);
    });
  });
});

describe('US-3.1 snapshot immutability (ADR-006)', () => {
  describe('Scenario: Snapshot is frozen and content-addressed', () => {
    it('rejects any mutation with SNAPSHOT_IMMUTABLE', () => {
      const snapshot = aSnapshot();
      expectErr(
        SnapshotFactory.attemptMutation(snapshot, () => {
          (snapshot.positions as unknown[]).push({});
        }),
        'SNAPSHOT_IMMUTABLE',
      );
    });

    it('reports the snapshot as deeply immutable', () => {
      expect(SnapshotFactory.isImmutable(aSnapshot())).toBe(true);
    });

    it('reports a non-frozen lookalike as mutable, so the check has teeth', () => {
      const mutable = { ...aSnapshot(), positions: [] } as unknown as Snapshot;
      expect(SnapshotFactory.isImmutable(mutable)).toBe(false);
    });

    it('leaves the content hash unchanged after a refused mutation', () => {
      const snapshot = aSnapshot();
      const hash = snapshot.contentHash;
      SnapshotFactory.attemptMutation(snapshot, () => {
        (snapshot.positions as unknown[]).push({});
      });
      expect(snapshot.contentHash).toBe(hash);
    });

    it('produces a contentHash matching SHA-256 of the canonical JSON', () => {
      const snapshot = aSnapshot();
      const { contentHash: _ignored, ...rest } = snapshot;
      expect(ContentHasher.hash(rest)).toBe(snapshot.contentHash);
    });

    it('verifies a snapshot whose hash matches its content', () => {
      expectOk(SnapshotFactory.verify(aSnapshot()));
    });
  });

  describe('Scenario: Regenerating an existing snapshot detects divergence', () => {
    it('fails with SNAPSHOT_DIVERGENCE when regeneration yields a different hash', () => {
      expectErr(SnapshotFactory.verify(aSnapshot({ contentHash: 'sha256:different' })), 'SNAPSHOT_DIVERGENCE');
    });
  });

  describe('Canonical JSON is order-independent', () => {
    it('hashes two objects with differently ordered keys identically', () => {
      expect(ContentHasher.canonicalJson({ a: 1, b: 2 })).toBe(
        ContentHasher.canonicalJson({ b: 2, a: 1 }),
      );
    });
  });
});
