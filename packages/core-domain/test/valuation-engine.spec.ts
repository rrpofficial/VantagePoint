/**
 * US-1.15 — Portfolio valuation engine (PRD NFR-2)
 * US-1.14 — Liabilities ledger (PRD FR-6.2)
 * US-1.7  — Mutual fund NAV valuation
 * US-1.10 — Alternative and private assets
 */
import { describe, it, expect } from 'vitest';
import { ValuationEngine, AssetRegistry } from '@vantagepoint/core-domain';
import {
  aLiability,
  anAsset,
  aForeignAsset,
  expectMoney,
  fixedClock,
  inr,
  manyLots,
  stubFx,
  stubPrices,
  usd,
} from '@vantagepoint/test-kit';

const CLOCK = fixedClock('2026-03-31T23:59:59.999+05:30');

/**
 * Prices and FX are injected ports (US-1.15). Without them a foreign holding cannot
 * be expressed in INR at all, so these stubs are part of the scenario, not scaffolding.
 */
const FX = stubFx({ USD: '83.50' });
const PRICES = stubPrices({
  TCS: inr('4000'),
  AAPL: usd('200'),
  INF090I01239: inr('87.4321'),
});

describe('US-1.14 liabilities ledger', () => {
  describe('Scenario: Liabilities reduce net worth but are reported separately', () => {
    const valuation = () =>
      ValuationEngine.value({
        assets: [anAsset()],
        liabilities: [aLiability({ principalOutstanding: inr('8000000') })],
        asOf: CLOCK.now(),
        prices: PRICES,
        fx: FX,
      });

    it('reports gross assets separately from liabilities', () => {
      const v = valuation();
      expectMoney(v.totalLiabilities, inr('8000000'));
      expect(Number(v.grossAssets.amount)).toBeGreaterThan(0);
    });

    it('computes net worth as gross assets minus liabilities', () => {
      const v = valuation();
      expect(Number(v.netWorth.amount)).toBe(
        Number(v.grossAssets.amount) - Number(v.totalLiabilities.amount),
      );
    });

    it('never represents a liability as a negative asset (ADR-009)', () => {
      const v = valuation();
      for (const position of v.positions) {
        expect(Number(position.marketValue.amount)).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

describe('US-1.15 valuation engine', () => {
  describe('Scenario: Valuation of a large portfolio meets the performance budget (NFR-2)', () => {
    it('values 1,000 lots across 8 asset classes in under 1,500 ms', () => {
      const assets = Array.from({ length: 8 }, (_, i) =>
        anAsset({ assetId: `ast_${String(i)}`, lots: manyLots(125) }),
      );
      const start = performance.now();
      ValuationEngine.value({ assets, liabilities: [], asOf: CLOCK.now(), prices: PRICES, fx: FX });
      expect(performance.now() - start).toBeLessThan(1500);
    });
  });

  describe('Scenario: Valuation is deterministic', () => {
    it('produces byte-identical results across two runs with a fixed clock', () => {
      const input = {
        assets: [anAsset(), aForeignAsset()],
        liabilities: [aLiability()],
        asOf: CLOCK.now(),
        prices: PRICES,
        fx: FX,
      };
      const a = JSON.stringify(ValuationEngine.value(input));
      const b = JSON.stringify(ValuationEngine.value(input));
      expect(a).toBe(b);
    });
  });

  describe('Asset-class breakdown', () => {
    it('sums the per-class breakdown to gross assets', () => {
      const v = ValuationEngine.value({
        assets: [anAsset(), aForeignAsset()],
        liabilities: [],
        asOf: CLOCK.now(),
        prices: PRICES,
        fx: FX,
      });
      const sum = Object.values(v.byAssetClass).reduce((t, m) => t + Number(m.amount), 0);
      expect(sum).toBe(Number(v.grossAssets.amount));
    });
  });
});

describe('US-1.7 mutual fund valuation', () => {
  describe('Scenario: MF units valued at applicable NAV on the valuation date', () => {
    // 1,234.567 × 87.4321 = 107,940.785 → ₹107,940.79. The original ₹107,943.06
    // was an arithmetic slip when the test was authored.
    it('values 1,234.567 units at NAV ₹87.4321 as ₹107,940.79', () => {
      const v = ValuationEngine.value({
        assets: [
          anAsset({
            assetClass: 'DOMESTIC_MUTUAL_FUND',
            isin: 'INF090I01239',
            lots: [
              {
                lotId: 'lot_mf',
                acquisitionDate: '2024-01-01',
                settlementDate: '2024-01-02',
                quantity: '1234.567',
                remainingQuantity: '1234.567',
                costPerUnit: inr('80.00'),
                fees: inr('0'),
                stt: inr('0'),
                otherCharges: inr('0'),
              },
            ],
          }),
        ],
        liabilities: [],
        asOf: CLOCK.now(),
        prices: PRICES,
      });
      expectMoney(v.positions[0]?.marketValue ?? inr('0'), inr('107940.79'));
    });
  });

  describe('Scenario: NAV unavailable on a non-business day falls back to last published NAV', () => {
    it('flags the position navSource LAST_PUBLISHED for a Sunday valuation', () => {
      const sunday = fixedClock('2026-03-29T23:59:59.999+05:30');
      const v = ValuationEngine.value({
        assets: [anAsset({ assetClass: 'DOMESTIC_MUTUAL_FUND' })],
        liabilities: [],
        asOf: sunday.now(),
        prices: stubPrices({ TCS: { price: inr('87.4321'), source: 'LAST_PUBLISHED' } }),
      });
      expect(v.positions[0]?.navSource).toBe('LAST_PUBLISHED');
    });
  });
});

describe('US-1.10 alternative and private assets', () => {
  describe('Scenario: Real estate holds cost of acquisition separately from market value', () => {
    it('reports ₹15,900,000 of cost basis including stamp duty', () => {
      const v = ValuationEngine.value({
        assets: [
          anAsset({
            assetClass: 'REAL_ESTATE',
            lots: [
              {
                lotId: 'lot_prop',
                acquisitionDate: '2019-08-01',
                settlementDate: '2019-08-01',
                quantity: '1',
                remainingQuantity: '1',
                costPerUnit: inr('15000000'),
                fees: inr('900000'),
                stt: inr('0'),
                otherCharges: inr('0'),
              },
            ],
          }),
        ],
        liabilities: [],
        asOf: CLOCK.now(),
        prices: stubPrices({ ast_domestic_equity_0001: inr('32000000') }),
      });
      expectMoney(v.positions[0]?.costBasis ?? inr('0'), inr('15900000'));
    });

    it('never substitutes market value for cost of acquisition', () => {
      const v = ValuationEngine.value({
        assets: [anAsset({ assetClass: 'REAL_ESTATE' })],
        liabilities: [],
        asOf: CLOCK.now(),
        prices: stubPrices({ ast_domestic_equity_0001: inr('32000000') }),
      });
      const p = v.positions[0];
      expect(p?.costBasis).not.toBe(p?.marketValue);
    });
  });

  describe('Alternative classes are registrable', () => {
    it.each(['REAL_ESTATE', 'UNLISTED_SHARES', 'CRYPTO', 'GOLD_PHYSICAL', 'GOLD_DIGITAL', 'SGB'] as const)(
      'registers %s',
      (assetClass) => {
        expect(AssetRegistry.register({ assetClass, currency: 'INR' }).ok).toBe(true);
      },
    );
  });
});
