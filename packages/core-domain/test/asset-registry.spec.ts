/**
 * US-1.1 — Typed asset registry and taxonomy (PRD FR-1.1)
 */
import { describe, it, expect } from 'vitest';
import { AssetRegistry, type AssetClass } from '@vantagepoint/core-domain';
import { expectErr, expectOk } from '@vantagepoint/test-kit';

const ALL_ASSET_CLASSES: readonly AssetClass[] = [
  'DOMESTIC_EQUITY',
  'DOMESTIC_ETF',
  'DOMESTIC_MUTUAL_FUND',
  'FOREIGN_EQUITY',
  'FOREIGN_ETF',
  'EPF',
  'VPF',
  'NPS_TIER_I',
  'NPS_TIER_II',
  'PPF',
  'GRATUITY',
  'FIXED_DEPOSIT',
  'RECURRING_DEPOSIT',
  'REAL_ESTATE',
  'UNLISTED_SHARES',
  'CRYPTO',
  'GOLD_PHYSICAL',
  'GOLD_DIGITAL',
  'SGB',
  'CASH_IN_HAND',
  'BANK_BALANCE',
  'HAND_LOAN',
  'CHIT_FUND',
];

const FOREIGN_CLASSES: readonly AssetClass[] = ['FOREIGN_EQUITY', 'FOREIGN_ETF'];

describe('US-1.1 asset registry', () => {
  describe('Scenario: Asset class determines jurisdiction and snapshot membership', () => {
    it('maps FOREIGN_EQUITY to the FOREIGN jurisdiction', () => {
      expect(AssetRegistry.jurisdictionOf('FOREIGN_EQUITY')).toBe('FOREIGN');
    });

    it('registers a foreign equity with jurisdiction FOREIGN', () => {
      const asset = expectOk(AssetRegistry.register({ assetClass: 'FOREIGN_EQUITY', currency: 'USD' }));
      expect(asset.jurisdiction).toBe('FOREIGN');
    });

    it('maps every domestic class to DOMESTIC', () => {
      for (const cls of ALL_ASSET_CLASSES.filter((c) => !FOREIGN_CLASSES.includes(c))) {
        expect(AssetRegistry.jurisdictionOf(cls), `${cls} should be DOMESTIC`).toBe('DOMESTIC');
      }
    });

    it('maps every foreign class to FOREIGN', () => {
      for (const cls of FOREIGN_CLASSES) {
        expect(AssetRegistry.jurisdictionOf(cls), `${cls} should be FOREIGN`).toBe('FOREIGN');
      }
    });
  });

  describe('Scenario: Unsupported asset class is rejected at the boundary', () => {
    it('fails with UNSUPPORTED_ASSET_CLASS for an unknown class', () => {
      expectErr(
        AssetRegistry.register({ assetClass: 'DOGECOIN_FUTURES', currency: 'INR' }),
        'UNSUPPORTED_ASSET_CLASS',
      );
    });

    it('persists no partial record when registration is rejected', () => {
      const result = AssetRegistry.register({ assetClass: 'DOGECOIN_FUTURES', currency: 'INR' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect('value' in result).toBe(false);
    });
  });

  describe('DoD: taxonomy covers all 23 classes in FR-1.1', () => {
    it('assigns a jurisdiction to every declared asset class', () => {
      for (const cls of ALL_ASSET_CLASSES) {
        expect(['DOMESTIC', 'FOREIGN']).toContain(AssetRegistry.jurisdictionOf(cls));
      }
    });
  });
});
