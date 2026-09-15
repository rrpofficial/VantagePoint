/**
 * US-8.5 — how a holding is grouped for the user.
 *
 * The grouping is presentational, but it is derived from the tax character where
 * one exists. A screen that files a debt fund under Equity while the engine
 * behind it treats that fund as slab-taxed is a screen that contradicts its own
 * application — which is the failure these tests exist to prevent.
 */
import { describe, it, expect } from 'vitest';
import { ALL_ASSET_CLASSES, HOLDING_BUCKETS, bucketOf } from '@porttrack/core-domain';

describe('US-8.5 Scenario: Classes that are equity however they are held', () => {
  it.each([
    'DOMESTIC_EQUITY',
    'FOREIGN_EQUITY',
    'FOREIGN_ETF',
    'UNLISTED_SHARES',
  ] as const)('puts %s in Equity', (assetClass) => {
    expect(bucketOf({ assetClass })).toBe('EQUITY');
  });
});

describe('US-8.5 Scenario: A fund is grouped by what it holds, not what it is', () => {
  /*
   * ADR-016 in one test. Both of these are DOMESTIC_MUTUAL_FUND; they are taxed
   * completely differently, and they must not sit in the same tab.
   */
  it('puts an equity-oriented fund in Equity', () => {
    expect(
      bucketOf({
        assetClass: 'DOMESTIC_MUTUAL_FUND',
        schemeCategory: 'EQUITY',
        equityAllocationPct: '95',
      }),
    ).toBe('EQUITY');
  });

  it('puts a debt-oriented fund in Non-Equity, despite the identical asset class', () => {
    expect(
      bucketOf({
        assetClass: 'DOMESTIC_MUTUAL_FUND',
        schemeCategory: 'DEBT',
        equityAllocationPct: '0',
      }),
    ).toBe('NON_EQUITY');
  });

  /*
   * Every fund imported before the scheme category was captured is in this state.
   * Equity is the chosen default — see the note in asset-bucket.ts. The tax engine
   * reads the character itself and is unaffected either way.
   */
  it('puts a fund with no recorded scheme category in Equity', () => {
    expect(bucketOf({ assetClass: 'DOMESTIC_MUTUAL_FUND' })).toBe('EQUITY');
  });

  it('puts a domestic ETF in Equity, having no scheme category to consult', () => {
    expect(bucketOf({ assetClass: 'DOMESTIC_ETF' })).toBe('EQUITY');
  });
});

describe('US-8.5 Scenario: Everything else', () => {
  it('puts real estate in Immovable', () => {
    expect(bucketOf({ assetClass: 'REAL_ESTATE' })).toBe('IMMOVABLE');
  });

  /** Each already has a screen shaped around it; neither fits a holdings table. */
  it('keeps hand loans and chits in their own buckets', () => {
    expect(bucketOf({ assetClass: 'HAND_LOAN' })).toBe('LOAN');
    expect(bucketOf({ assetClass: 'CHIT_FUND' })).toBe('CHIT');
  });

  it.each([
    'EPF',
    'VPF',
    'PPF',
    'GRATUITY',
    'NPS_TIER_I',
    'NPS_TIER_II',
    'FIXED_DEPOSIT',
    'RECURRING_DEPOSIT',
    'CRYPTO',
    'GOLD_PHYSICAL',
    'GOLD_DIGITAL',
    'SGB',
    'CASH_IN_HAND',
    'BANK_BALANCE',
  ] as const)('puts %s in Non-Equity', (assetClass) => {
    expect(bucketOf({ assetClass })).toBe('NON_EQUITY');
  });
});

describe('US-8.5 Scenario: The taxonomy is covered exhaustively', () => {
  /*
   * The guard that matters as the taxonomy grows. A class added without a
   * bucket falls through to the Non-Equity default and appears in a tab nobody
   * chose for it — silently, and only noticed when a holding goes missing from
   * where its owner looked.
   */
  it('assigns every asset class a bucket', () => {
    for (const assetClass of ALL_ASSET_CLASSES) {
      expect(bucketOf({ assetClass }), assetClass).toBeDefined();
    }
  });

  /*
   * A bucket outside this set would render in no tab at all — the holding would
   * simply vanish from the UI, with nothing to say it had. The nav dispatches on
   * exact values, so a typo'd or newly-invented bucket fails silently.
   */
  it('never returns a bucket the UI has no tab for', () => {
    const known = new Set(['EQUITY', 'NON_EQUITY', 'IMMOVABLE', 'LOAN', 'CHIT']);
    const unroutable = ALL_ASSET_CLASSES.filter(
      (assetClass) => !known.has(bucketOf({ assetClass })),
    );
    expect(unroutable).toEqual([]);
  });

  it('routes every holdings bucket to one the tabs actually render', () => {
    expect([...HOLDING_BUCKETS]).toEqual(['EQUITY', 'NON_EQUITY', 'IMMOVABLE']);
  });
});
