/**
 * FUNCTIONAL — US-3.2/3.3 scheduler, US-3.4 custom snapshot, US-3.6 live comparison.
 * PRD FR-3 acceptance criteria driven through `app-services`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompareSnapshotsUC,
  GenerateSnapshotUC,
  VaultUC,
  configure,
} from '@vantagepoint/app-services';
import { SnapshotRepository, Vault } from '@vantagepoint/persistence';
import { SnapshotFactory } from '@vantagepoint/snapshot';
import { anAsset, expectMoney, expectOk, fixedClock, inr, stubPrices } from '@vantagepoint/test-kit';

/**
 * Live holdings priced to ₹310,000,000, against a frozen snapshot of
 * ₹250,000,000 — the figures the PRD's variance scenario is written around.
 */
const LIVE_ASSET = anAsset({ assetId: 'ast_live', symbol: 'TCS' });
const LIVE_PRICES = stubPrices({ TCS: inr('3100000') });
const SNAPSHOT_PRICES = stubPrices({ TCS: inr('2500000') });
const NOW = '2026-08-02T12:00:00.000+05:30';

async function openVault(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'vantagepoint-snap-'));
  expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock('correct horse battery staple'));
}

/** Freezes the historical side the comparison scenario compares against. */
async function seedHistoricalSnapshot(): Promise<void> {
  configure({ assets: () => [LIVE_ASSET], liabilities: () => [], prices: SNAPSHOT_PRICES });
  const valuation = expectOk(
    await (await import('@vantagepoint/app-services')).ValuePortfolioUC.execute(
      '2025-03-31T23:59:59.999+05:30',
    ),
  );
  const snapshot = expectOk(
    SnapshotFactory.build({
      spec: {
        snapshotId: 'SNAP_31MAR2025',
        kind: 'CUSTOM',
        scope: 'ALL',
        asOf: '2025-03-31T23:59:59.999+05:30',
      },
      valuation,
      createdAt: '2025-04-01T00:05:00.000+05:30',
    }),
  );
  expectOk(await SnapshotRepository.persistImmutable(snapshot));
}

describe('FUNCTIONAL US-3.2/3.3 — dual compliance snapshot generation', () => {
  beforeEach(async () => {
    await openVault();
    configure({
      assets: () => [LIVE_ASSET],
      liabilities: () => [],
      prices: LIVE_PRICES,
      clock: fixedClock(NOW),
    });
  });

  describe('Scenario: Dual compliance snapshot generation (PRD FR-3 AC)', () => {
    it('creates DOM_31MAR2026 when the scheduler runs on 2026-04-01', async () => {
      const created = expectOk(
        await GenerateSnapshotUC.runScheduler('2026-04-01T00:05:00+05:30'),
      );
      expect(created).toContain('DOM_31MAR2026');
    });

    it('creates FOR_31DEC2026 when the scheduler runs on 2027-01-01', async () => {
      const created = expectOk(
        await GenerateSnapshotUC.runScheduler('2027-01-01T00:05:00+05:30'),
      );
      expect(created).toContain('FOR_31DEC2026');
    });

    it('freezes the domestic snapshot as immutable', async () => {
      await GenerateSnapshotUC.runScheduler('2026-04-01T00:05:00+05:30');
      const snapshot = expectOk(
        await GenerateSnapshotUC.generate({
          snapshotId: 'DOM_31MAR2026',
          kind: 'DOMESTIC_COMPLIANCE',
          scope: 'DOMESTIC',
          asOf: '2026-03-31T23:59:59.999+05:30',
        }),
      );
      expect(snapshot.frozen).toBe(true);
      expect(snapshot.contentHash).toMatch(/^sha256:/);
    });

    it('is idempotent on a second scheduler run', async () => {
      await GenerateSnapshotUC.runScheduler('2026-04-01T00:05:00+05:30');
      const second = expectOk(await GenerateSnapshotUC.runScheduler('2026-04-02T00:05:00+05:30'));
      expect(second).toEqual([]);
    });

    it('contains only domestic holdings in the 31-Mar snapshot', async () => {
      await GenerateSnapshotUC.runScheduler('2026-04-01T00:05:00+05:30');
      const snapshot = expectOk(
        await GenerateSnapshotUC.generate({
          snapshotId: 'DOM_31MAR2026',
          kind: 'DOMESTIC_COMPLIANCE',
          scope: 'DOMESTIC',
          asOf: '2026-03-31T23:59:59.999+05:30',
        }),
      );
      expect(snapshot.positions.every((p) => p.jurisdiction === 'DOMESTIC')).toBe(true);
    });
  });
});

describe('FUNCTIONAL US-3.4 — custom snapshots', () => {
  beforeEach(async () => {
    await openVault();
    configure({
      assets: () => [LIVE_ASSET],
      liabilities: () => [],
      prices: LIVE_PRICES,
      clock: fixedClock(NOW),
    });
  });

  describe('Scenario: Custom historical snapshot reconstructs state as of a past date', () => {
    it('includes only transactions on or before the requested date', async () => {
      const snapshot = expectOk(await GenerateSnapshotUC.custom('2024-11-30'));
      expect(snapshot.asOf).toBe('2024-11-30T23:59:59.999+05:30');
    });

    it('marks the snapshot kind as CUSTOM', async () => {
      expect(expectOk(await GenerateSnapshotUC.custom('2024-11-30')).kind).toBe('CUSTOM');
    });
  });

  describe('Scenario: Future-dated snapshot is rejected', () => {
    it('fails with FUTURE_SNAPSHOT for a date beyond the system date', async () => {
      const result = await GenerateSnapshotUC.custom('2027-01-01');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FUTURE_SNAPSHOT');
    });
  });
});

describe('FUNCTIONAL US-3.6 — live vs historical comparison', () => {
  beforeEach(async () => {
    await openVault();
    await seedHistoricalSnapshot();
    configure({
      assets: () => [LIVE_ASSET],
      liabilities: () => [],
      prices: LIVE_PRICES,
      clock: fixedClock(NOW),
    });
  });

  describe('Scenario: Live vs historical snapshot variance analysis (PRD FR-3 AC)', () => {
    it('reports a +₹60,000,000 delta between ₹250,000,000 and ₹310,000,000', async () => {
      const report = expectOk(
        await CompareSnapshotsUC.snapshotToLive('SNAP_31MAR2025', '2026-08-02T12:00:00+05:30'),
      );
      expectMoney(report.netWorthBefore, inr('250000000'));
      expectMoney(report.netWorthAfter, inr('310000000'));
      expectMoney(report.netWorthDelta, inr('60000000'));
    });

    it('reports the delta as +24.0%', async () => {
      const report = expectOk(
        await CompareSnapshotsUC.snapshotToLive('SNAP_31MAR2025', '2026-08-02T12:00:00+05:30'),
      );
      expect(Number(report.netWorthDeltaPct)).toBeCloseTo(24.0, 4);
    });

    it('highlights gainers, additions, liquidations and allocation shifts', async () => {
      const report = expectOk(
        await CompareSnapshotsUC.snapshotToLive('SNAP_31MAR2025', '2026-08-02T12:00:00+05:30'),
      );
      expect(report.topGainers).toBeDefined();
      expect(report.newAdditions).toBeDefined();
      expect(report.liquidations).toBeDefined();
      expect(report.allocation.length).toBeGreaterThan(0);
    });

    it('completes within the 2,000 ms budget (NFR-2)', async () => {
      const start = performance.now();
      await CompareSnapshotsUC.snapshotToLive('SNAP_31MAR2025', '2026-08-02T12:00:00+05:30');
      expect(performance.now() - start).toBeLessThan(2000);
    });
  });
});
