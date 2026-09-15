/**
 * FUNCTIONAL — comparing two frozen snapshots (Phase 4, objective 2).
 *
 * `CompareSnapshotsUC.snapshotToSnapshot` and its route have existed since the
 * snapshot work. What was missing was any way to REACH them: the SPA had only
 * `compareToLive`, so the product could answer "how has it moved since?" and
 * never "how did it move between these two dates?" — which is the objective.
 *
 * The second half is scoping the reading to one asset class. `PositionDelta`
 * carried no asset class at all, so a class filter had to join every row back
 * against the live ledger — which answers a different question, because a
 * position sold since the snapshot is no longer there to classify.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompareSnapshotsUC,
  EditModeUC,
  GenerateSnapshotUC,
  TradeUC,
  VaultUC,
  resetPorts,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const buy = (symbol: string, quantity: string, price: string, date: string) =>
  TradeUC.record({
    assetClass: 'DOMESTIC_EQUITY',
    side: 'BUY',
    tradeDate: date,
    symbol,
    quantity,
    pricePerUnit: inr(price),
  });

const snapshotAt = async (asOf: string): Promise<string> => {
  const result = expectOk(
    await GenerateSnapshotUC.custom(`${asOf}T23:59:59+05:30`),
  );
  return result.snapshotId;
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-compare-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

describe('Scenario: Any two snapshots can be compared', () => {
  it('reports the delta between two frozen points', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');

    expectOk(await buy('BETA', '500', '200', '2026-02-10'));
    const second = await snapshotAt('2026-02-28');

    const report = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(first, second));

    expect(Number(report.netWorthBefore.amount)).toBeCloseTo(100_000, 0);
    expect(Number(report.netWorthAfter.amount)).toBeCloseTo(200_000, 0);
    expect(Number(report.netWorthDelta.amount)).toBeCloseTo(100_000, 0);
  });

  it('marks a holding that did not exist in the earlier snapshot as NEW', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');

    expectOk(await buy('BETA', '500', '200', '2026-02-10'));
    const second = await snapshotAt('2026-02-28');

    const report = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(first, second));
    const beta = report.positions.find((row) => row.assetId.includes('beta'));
    expect(beta?.bucket).toBe('NEW');
  });

  /** Order matters: comparing the other way round inverts the delta. */
  it('inverts the delta when the snapshots are given in the other order', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');
    expectOk(await buy('BETA', '500', '200', '2026-02-10'));
    const second = await snapshotAt('2026-02-28');

    const forward = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(first, second));
    const backward = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(second, first));

    expect(Number(backward.netWorthDelta.amount)).toBeCloseTo(
      -Number(forward.netWorthDelta.amount),
      0,
    );
  });

  it('refuses when a snapshot does not exist, rather than comparing to nothing', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');

    expectErr(
      await CompareSnapshotsUC.snapshotToSnapshot(first, 'snap_does_not_exist'),
      'VAULT_STATE',
    );
  });
});

describe('Scenario: A comparison can be read by asset class', () => {
  /*
   * The delta carries the class so the reading can be scoped without a join
   * against the live ledger — where a position sold since the snapshot no longer
   * exists to classify.
   */
  it('carries the asset class on every position delta', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');
    expectOk(await buy('BETA', '500', '200', '2026-02-10'));
    const second = await snapshotAt('2026-02-28');

    const report = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(first, second));

    expect(report.positions.length).toBeGreaterThan(0);
    for (const position of report.positions) {
      expect(position.assetClass).toBe('DOMESTIC_EQUITY');
    }
  });

  /*
   * A fully-sold holding is `DECREASED`, not `LIQUIDATED`: the asset is still in
   * the later snapshot, carrying zero. `LIQUIDATED` is for a position that has
   * left the ledger entirely.
   */
  it('keeps the class of a position that was sold down to nothing', async () => {
    expectOk(await buy('ACME', '1000', '100', '2026-01-10'));
    const first = await snapshotAt('2026-01-31');

    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'SELL',
        tradeDate: '2026-02-10',
        symbol: 'ACME',
        quantity: '1000',
        pricePerUnit: inr('150'),
      }),
    );
    const second = await snapshotAt('2026-02-28');

    const report = expectOk(await CompareSnapshotsUC.snapshotToSnapshot(first, second));
    const acme = report.positions.find((row) => row.assetId.includes('acme'));

    // Worth nothing in the later snapshot, and still classifiable — which is the
    // whole reason the class travels on the delta rather than being looked up
    // live, where a disposed holding may no longer be there to classify.
    expect(acme?.bucket).toBe('DECREASED');
    expect(Number(acme?.valueAfter.amount)).toBe(0);
    expect(acme?.assetClass).toBe('DOMESTIC_EQUITY');
  });
});
