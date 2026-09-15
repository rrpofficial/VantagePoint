/**
 * US-3.5 — Snapshot ↔ snapshot comparison (PRD FR-3 AC)
 * US-3.7 — Allocation shift and movement classification
 * US-3.8 — XIRR / CAGR / absolute return
 */
import { describe, it, expect } from 'vitest';
import {
  AllocationShift,
  DeltaEngine,
  ReturnsCalculator,
  type Snapshot,
  type SnapshotPosition,
} from '@vantagepoint/snapshot';
import { expectErr, expectMoney, expectOk, inr, usd } from '@vantagepoint/test-kit';

const position = (overrides: Partial<SnapshotPosition>): SnapshotPosition =>
  ({
    assetId: 'ast_1',
    assetClass: 'DOMESTIC_EQUITY',
    jurisdiction: 'DOMESTIC',
    quantity: '100',
    marketValue: inr('1000000'),
    costBasis: inr('800000'),
    ...overrides,
  });

const snap = (id: string, netWorth: string, positions: SnapshotPosition[]): Snapshot =>
  ({
    snapshotId: id,
    kind: 'CUSTOM',
    scope: 'ALL',
    asOf: `${id.slice(-4)}-03-31T23:59:59.999+05:30`,
    positions,
    totals: {
      netWorth: inr(netWorth),
      grossAssets: inr(netWorth),
      liabilities: inr('0'),
      byAssetClass: {},
    },
    contentHash: `sha256:${id}`,
    createdAt: '2026-04-01T00:00:00+05:30',
    frozen: true,
  });

const BEFORE = snap('SNAP_31MAR2025', '250000000', [
  position({ assetId: 'held', marketValue: inr('200000000') }),
  position({ assetId: 'sold', marketValue: inr('50000000') }),
]);
const AFTER = snap('SNAP_02AUG2026', '310000000', [
  position({ assetId: 'held', marketValue: inr('280000000') }),
  position({ assetId: 'bought', marketValue: inr('30000000') }),
]);

describe('US-3.5 comparison engine', () => {
  describe('Scenario: Live vs historical snapshot variance analysis (PRD FR-3 AC)', () => {
    it('reports a net worth delta of +₹60,000,000', () => {
      expectMoney(DeltaEngine.compare(BEFORE, AFTER).netWorthDelta, inr('60000000'));
    });

    it('reports a net worth delta of +24.0%', () => {
      expect(Number(DeltaEngine.compare(BEFORE, AFTER).netWorthDeltaPct)).toBeCloseTo(24.0, 4);
    });

    it('highlights top gainers', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.topGainers.map((p) => p.assetId)).toContain('held');
    });

    it('highlights new asset additions', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.newAdditions.map((p) => p.assetId)).toContain('bought');
    });

    it('highlights complete liquidations', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.liquidations.map((p) => p.assetId)).toContain('sold');
    });

    it('reports asset-class rebalancing shifts', () => {
      expect(DeltaEngine.compare(BEFORE, AFTER).allocation.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario: Comparison across currencies normalises to INR at each side own rate', () => {
    // $10,000 at ₹80 = ₹800,000, rising to $12,000 at ₹85 = ₹1,020,000.
    // Of the ₹220,000 gain, ₹160,000 is the stock ($2,000 × ₹80) and ₹60,000 is
    // the rupee weakening ($12,000 × ₹5). Reporting only the total would credit
    // the holding with gains the currency produced.
    const foreignBefore = snap('SNAP_A', '800000', [
      position({
        assetId: 'aapl',
        assetClass: 'FOREIGN_EQUITY',
        jurisdiction: 'FOREIGN',
        marketValue: inr('800000'),
        nativeValue: usd('10000'),
        fxRate: '80',
      }),
    ]);
    const foreignAfter = snap('SNAP_B', '1020000', [
      position({
        assetId: 'aapl',
        assetClass: 'FOREIGN_EQUITY',
        jurisdiction: 'FOREIGN',
        marketValue: inr('1020000'),
        nativeValue: usd('12000'),
        fxRate: '85',
      }),
    ]);

    it('attributes price movement and currency movement separately', () => {
      const delta = DeltaEngine.compare(foreignBefore, foreignAfter).positions[0];
      expectMoney(delta?.priceEffect ?? inr('0'), inr('160000'));
      expectMoney(delta?.currencyEffect ?? inr('0'), inr('60000'));
    });

    it('has the two effects sum exactly to the INR delta', () => {
      const delta = DeltaEngine.compare(foreignBefore, foreignAfter).positions[0];
      const total =
        Number(delta?.priceEffect?.amount ?? 0) + Number(delta?.currencyEffect?.amount ?? 0);
      expect(total).toBe(Number(delta?.valueDelta.amount));
    });

    it('leaves both effects undefined for a domestic position', () => {
      const delta = DeltaEngine.compare(BEFORE, AFTER).positions.find((p) => p.assetId === 'held');
      expect(delta?.priceEffect).toBeUndefined();
      expect(delta?.currencyEffect).toBeUndefined();
    });
  });

  describe('Scenario: Comparison meets the performance budget (NFR-2)', () => {
    it('computes a 1,000-position delta in under 2,000 ms', () => {
      const many = (id: string) =>
        snap(
          id,
          '1000000000',
          Array.from({ length: 1000 }, (_, i) => position({ assetId: `ast_${String(i)}` })),
        );
      const start = performance.now();
      DeltaEngine.compare(many('SNAP_X'), many('SNAP_Y'));
      expect(performance.now() - start).toBeLessThan(2000);
    });
  });
});

describe('US-3.7 allocation shift and movement buckets', () => {
  describe('Scenario: Positions are classified into movement buckets', () => {
    it('classifies a position present only in the later snapshot as NEW', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.positions.find((p) => p.assetId === 'bought')?.bucket).toBe('NEW');
    });

    it('classifies a position absent from the later snapshot as LIQUIDATED', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.positions.find((p) => p.assetId === 'sold')?.bucket).toBe('LIQUIDATED');
    });

    it('classifies a grown position as INCREASED', () => {
      const report = DeltaEngine.compare(BEFORE, AFTER);
      expect(report.positions.find((p) => p.assetId === 'held')?.bucket).toBe('INCREASED');
    });

    it('sums allocation percentages to 100.00% on both sides within ±0.01%', () => {
      const rows = AllocationShift.compute(BEFORE, AFTER);
      const before = rows.reduce((t, r) => t + Number(r.pctBefore), 0);
      const after = rows.reduce((t, r) => t + Number(r.pctAfter), 0);
      expect(before).toBeCloseTo(100, 2);
      expect(after).toBeCloseTo(100, 2);
    });
  });
});

describe('US-3.8 returns', () => {
  describe('Scenario: XIRR is computed across irregular cash flows', () => {
    // Verified independently: NPV at 11.3302% is 0 to 8 decimal places, while the
    // originally-asserted 20.94% leaves an NPV of -₹28,317. The old figure was an
    // authoring error, not an implementation one.
    it('returns 11.3302% within 0.01 percentage points', () => {
      const xirr = expectOk(
        ReturnsCalculator.xirr([
          { date: '2023-04-01', amount: inr('-100000') },
          { date: '2024-04-01', amount: inr('-50000') },
          { date: '2026-04-01', amount: inr('200000') },
        ]),
      );
      expect(Number(xirr)).toBeCloseTo(11.3302, 2);
    });
  });

  describe('Scenario: XIRR on non-converging inputs fails explicitly', () => {
    it('fails with XIRR_NON_CONVERGENCE when there is no sign change', () => {
      expectErr(
        ReturnsCalculator.xirr([
          { date: '2023-04-01', amount: inr('100000') },
          { date: '2024-04-01', amount: inr('50000') },
        ]),
        'XIRR_NON_CONVERGENCE',
      );
    });

    it('never returns NaN or 0 for non-converging inputs', () => {
      const result = ReturnsCalculator.xirr([
        { date: '2023-04-01', amount: inr('100000') },
        { date: '2024-04-01', amount: inr('50000') },
      ]);
      expect(result.ok).toBe(false);
    });
  });

  describe('CAGR and absolute return', () => {
    it('computes 100% absolute return on a doubling', () => {
      expect(Number(ReturnsCalculator.absoluteReturn(inr('100000'), inr('200000')))).toBeCloseTo(
        100,
        4,
      );
    });

    it('computes ~25.99% CAGR on a doubling over 3 years', () => {
      expect(Number(ReturnsCalculator.cagr(inr('100000'), inr('200000'), '3'))).toBeCloseTo(
        25.99,
        1,
      );
    });
  });
});
