/**
 * US-3.4 — Custom arbitrary-date snapshot (PRD FR-3.1)
 * US-3.6 — Snapshot ↔ live comparison (PRD FR-3 AC)
 *
 * The domain half of both stories. Their functional counterparts in
 * tests/functional/snapshot/ drive the same behaviour through app-services and
 * stay red until M8; nothing here depends on that layer existing.
 */
import { describe, it, expect } from 'vitest';
import { DeltaEngine, SnapshotFactory, type Snapshot } from '@vantagepoint/snapshot';
import type { PortfolioValuation } from '@vantagepoint/core-domain';
import { expectErr, expectMoney, expectOk, inr } from '@vantagepoint/test-kit';

const TODAY = '2026-08-02';

const valuation = (netWorth: string, positions: PortfolioValuation['positions']): PortfolioValuation => ({
  asOf: '2026-08-02T12:00:00.000+05:30',
  positions,
  grossAssets: inr(netWorth),
  totalLiabilities: inr('0'),
  netWorth: inr(netWorth),
  byAssetClass: {},
});

const position = (assetId: string, marketValue: string): PortfolioValuation['positions'][number] => ({
  assetId,
  assetClass: 'DOMESTIC_EQUITY',
  jurisdiction: 'DOMESTIC',
  quantity: '100',
  marketValue: inr(marketValue),
  costBasis: inr('1'),
});

const snapshotOf = (netWorth: string, positions: readonly { id: string; value: string }[]): Snapshot =>
  expectOk(
    SnapshotFactory.build({
      spec: {
        snapshotId: 'SNAP_31MAR2025',
        kind: 'CUSTOM',
        scope: 'ALL',
        asOf: '2025-03-31T23:59:59.999+05:30',
      },
      valuation: valuation(
        netWorth,
        positions.map((p) => position(p.id, p.value)),
      ),
      createdAt: '2025-04-01T00:05:00.000+05:30',
    }),
  );

describe('US-3.4 custom snapshot date guard', () => {
  describe('Scenario: Future-dated snapshot is rejected', () => {
    it('rejects a date after today with FUTURE_SNAPSHOT', () => {
      expectErr(SnapshotFactory.assertNotFuture('2027-01-01', TODAY), 'FUTURE_SNAPSHOT');
    });

    it('accepts today itself', () => {
      expectOk(SnapshotFactory.assertNotFuture(TODAY, TODAY));
    });

    it('accepts a past date', () => {
      expectOk(SnapshotFactory.assertNotFuture('2024-11-30', TODAY));
    });

    it('refuses to build a snapshot whose as-of is after its creation instant', () => {
      expectErr(
        SnapshotFactory.build({
          spec: {
            snapshotId: 'CUSTOM_2027',
            kind: 'CUSTOM',
            scope: 'ALL',
            asOf: '2027-01-01T23:59:59.999+05:30',
          },
          valuation: valuation('1000', []),
          createdAt: '2026-08-02T12:00:00.000+05:30',
        }),
        'FUTURE_SNAPSHOT',
      );
    });
  });

  describe('Scenario: Scope filters which holdings a snapshot contains', () => {
    const mixed = valuation('3000', [
      position('domestic', '1000'),
      { ...position('foreign', '2000'), jurisdiction: 'FOREIGN', assetClass: 'FOREIGN_EQUITY' },
    ]);

    it('keeps only domestic holdings under DOMESTIC scope', () => {
      const positions = SnapshotFactory.positionsInScope(mixed, 'DOMESTIC');
      expect(positions.map((p) => p.assetId)).toEqual(['domestic']);
    });

    it('keeps only foreign holdings under FOREIGN scope', () => {
      const positions = SnapshotFactory.positionsInScope(mixed, 'FOREIGN');
      expect(positions.map((p) => p.assetId)).toEqual(['foreign']);
    });

    it('keeps everything under ALL scope', () => {
      expect(SnapshotFactory.positionsInScope(mixed, 'ALL')).toHaveLength(2);
    });
  });
});

describe('US-3.6 snapshot compared against a live valuation', () => {
  describe('Scenario: Live vs historical variance analysis (PRD FR-3 AC)', () => {
    const before = snapshotOf('250000000', [
      { id: 'held', value: '200000000' },
      { id: 'sold', value: '50000000' },
    ]);
    const live = valuation('310000000', [
      position('held', '280000000'),
      position('bought', '30000000'),
    ]);

    it('reports a delta of +₹60,000,000 between a snapshot and live holdings', () => {
      expectMoney(DeltaEngine.compare(before, live).netWorthDelta, inr('60000000'));
    });

    it('reports the delta as +24.0%', () => {
      expect(Number(DeltaEngine.compare(before, live).netWorthDeltaPct)).toBeCloseTo(24.0, 6);
    });

    it('classifies a holding present only live as NEW', () => {
      const report = DeltaEngine.compare(before, live);
      expect(report.newAdditions.map((p) => p.assetId)).toEqual(['bought']);
    });

    it('classifies a holding absent from live as LIQUIDATED', () => {
      const report = DeltaEngine.compare(before, live);
      expect(report.liquidations.map((p) => p.assetId)).toEqual(['sold']);
    });

    it('does not mutate the frozen snapshot it compares against', () => {
      const hashBefore = before.contentHash;
      DeltaEngine.compare(before, live);
      expect(before.contentHash).toBe(hashBefore);
      expect(Object.isFrozen(before)).toBe(true);
    });
  });
});
