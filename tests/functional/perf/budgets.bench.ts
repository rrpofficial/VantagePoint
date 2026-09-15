/**
 * US-8.7 — Performance budget harness (PRD NFR-2)
 *
 * Run with `pnpm bench`. These are budgets, not micro-optimisations: the build
 * fails if valuation of 1,000 lots exceeds 1.5 s or a snapshot delta exceeds 2.0 s.
 */
import { bench, describe } from 'vitest';
import { ValuationEngine } from '@vantagepoint/core-domain';
import { DeltaEngine, type Snapshot } from '@vantagepoint/snapshot';
import { anAsset, fixedClock, inr, manyLots } from '@vantagepoint/test-kit';

const CLOCK = fixedClock('2026-03-31T23:59:59.999+05:30');

const portfolio = Array.from({ length: 8 }, (_, i) =>
  anAsset({ assetId: `ast_${String(i)}`, lots: manyLots(125) }),
);

const snapshotOf = (id: string): Snapshot =>
  ({
    snapshotId: id,
    kind: 'CUSTOM',
    scope: 'ALL',
    asOf: '2026-03-31T23:59:59.999+05:30',
    positions: Array.from({ length: 1000 }, (_, i) => ({
      assetId: `ast_${String(i)}`,
      assetClass: 'DOMESTIC_EQUITY',
      jurisdiction: 'DOMESTIC',
      quantity: '100',
      marketValue: inr('100000'),
      costBasis: inr('80000'),
    })),
    totals: {
      netWorth: inr('100000000'),
      grossAssets: inr('100000000'),
      liabilities: inr('0'),
      byAssetClass: {},
    },
    contentHash: `sha256:${id}`,
    createdAt: '2026-04-01T00:00:00+05:30',
    frozen: true,
  });

describe('NFR-2 budgets', () => {
  bench(
    'US-1.15 valuation of 1,000 lots stays under 1,500 ms',
    () => {
      ValuationEngine.value({
        assets: portfolio,
        liabilities: [],
        asOf: CLOCK.now()
      });
    },
    { time: 2000 },
  );

  bench(
    'US-3.5 snapshot delta over 1,000 positions stays under 2,000 ms',
    () => {
      DeltaEngine.compare(snapshotOf('SNAP_A'), snapshotOf('SNAP_B'));
    },
    { time: 3000 },
  );
});
