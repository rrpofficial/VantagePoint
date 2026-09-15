/**
 * US-3.7 — price/currency attribution across the REAL path.
 *
 * The existing attribution test hand-builds SnapshotPositions, so it passed while
 * `ValuationEngine` never emitted `nativeValue`/`fxRate` and attribution was dead
 * in production. This drives the actual chain — ValuationEngine → SnapshotFactory
 * → DeltaEngine — so the wiring cannot rot again without a failure.
 */
import { describe, it, expect } from 'vitest';
import { ValuationEngine } from '@vantagepoint/core-domain';
import { DeltaEngine, SnapshotFactory } from '@vantagepoint/snapshot';
import { aForeignAsset, anAsset, expectMoney, expectOk, inr, stubFx, stubPrices, usd } from '@vantagepoint/test-kit';

/** $200/share × 100 shares at ₹80 → ₹1,600,000. */
const before = ValuationEngine.value({
  assets: [aForeignAsset()],
  liabilities: [],
  asOf: '2025-03-31T23:59:59.999+05:30',
  prices: stubPrices({ AAPL: usd('200') }),
  fx: stubFx({ USD: '80' }),
});

/** $240/share at ₹85 → ₹2,040,000. */
const after = ValuationEngine.value({
  assets: [aForeignAsset()],
  liabilities: [],
  asOf: '2026-03-31T23:59:59.999+05:30',
  prices: stubPrices({ AAPL: usd('240') }),
  fx: stubFx({ USD: '85' }),
});

describe('US-3.7 attribution through the production path', () => {
  it('emits nativeValue and fxRate on a foreign position', () => {
    const position = before.positions[0];
    expectMoney(position?.nativeValue ?? inr('0'), usd('20000'));
    expect(position?.fxRate).toBe('80');
  });

  it('omits both on a domestic position', () => {
    const domestic = ValuationEngine.value({
      assets: [anAsset()],
      liabilities: [],
      asOf: '2026-03-31T23:59:59.999+05:30',
      prices: stubPrices({ TCS: inr('4000') }),
      fx: stubFx({}),
    });
    expect(domestic.positions[0]?.nativeValue).toBeUndefined();
    expect(domestic.positions[0]?.fxRate).toBeUndefined();
  });

  it('attributes price and currency effects without any hand-built position', () => {
    const delta = DeltaEngine.compare(before, after).positions[0];
    // $4,000 of price growth valued at the opening ₹80 rate.
    expectMoney(delta?.priceEffect ?? inr('0'), inr('320000'));
    // $24,000 held while the rupee moved ₹5.
    expectMoney(delta?.currencyEffect ?? inr('0'), inr('120000'));
  });

  it('has the effects sum exactly to the INR delta', () => {
    const delta = DeltaEngine.compare(before, after).positions[0];
    const sum = Number(delta?.priceEffect?.amount ?? 0) + Number(delta?.currencyEffect?.amount ?? 0);
    expect(sum).toBe(Number(delta?.valueDelta.amount));
  });

  it('survives the round trip through a frozen snapshot', () => {
    const frozen = expectOk(
      SnapshotFactory.build({
        spec: {
          snapshotId: 'FOR_31DEC2025',
          kind: 'FOREIGN_COMPLIANCE',
          scope: 'FOREIGN',
          asOf: '2025-12-31T23:59:59.999+05:30',
        },
        valuation: before,
        createdAt: '2026-01-01T00:05:00.000+05:30',
      }),
    );
    expect(frozen.positions[0]?.fxRate).toBe('80');

    const delta = DeltaEngine.compare(frozen, after).positions[0];
    expectMoney(delta?.priceEffect ?? inr('0'), inr('320000'));
  });
});
