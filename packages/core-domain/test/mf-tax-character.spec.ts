/**
 * US-1.7 / US-5.7 — mutual fund tax character.
 *
 * One asset class, three tax treatments. These tests pin the mapping so the
 * capital gains engine cannot be written against the asset class alone.
 */
import { describe, it, expect } from 'vitest';
import { taxCharacterFor, taxCharacterOf, type MfSchemeCategory } from '@vantagepoint/core-domain';

describe('US-5.7 mutual fund tax character', () => {
  describe('Scenario: Categories with a guaranteed equity mandate are equity-oriented', () => {
    it.each(['EQUITY', 'SOLUTION_ORIENTED'] as const)('treats %s as equity-oriented', (category) => {
      expect(taxCharacterFor(category)).toBe('EQUITY_ORIENTED');
    });

    /**
     * The case the whole design exists for: an arbitrage fund returns cash-like
     * yields but qualifies as equity-oriented, so it is taxed as equity. Anyone
     * reasoning from "it behaves like debt" gets the tax wrong.
     */
    it('treats ARBITRAGE as equity-oriented despite its debt-like returns', () => {
      expect(taxCharacterFor('ARBITRAGE')).toBe('EQUITY_ORIENTED');
    });

    it('gives ARBITRAGE the same character as EQUITY, not the same as DEBT', () => {
      expect(taxCharacterFor('ARBITRAGE')).toBe(taxCharacterFor('EQUITY'));
      expect(taxCharacterFor('ARBITRAGE')).not.toBe(taxCharacterFor('DEBT'));
    });
  });

  describe('Scenario: Debt and liquid schemes are debt-oriented', () => {
    it.each(['DEBT', 'LIQUID'] as const)('treats %s as debt-oriented', (category) => {
      expect(taxCharacterFor(category)).toBe('DEBT_ORIENTED');
    });
  });

  describe('Scenario: A hybrid scheme is placed by its actual equity allocation', () => {
    it.each([
      ['80', 'EQUITY_ORIENTED'],
      ['65', 'EQUITY_ORIENTED'],
      ['64.9', 'HYBRID_MID_BAND'],
      ['50', 'HYBRID_MID_BAND'],
      ['35', 'HYBRID_MID_BAND'],
      ['34.9', 'DEBT_ORIENTED'],
      ['10', 'DEBT_ORIENTED'],
    ])('places a hybrid holding %s%% equity as %s', (allocation, expected) => {
      expect(taxCharacterFor('HYBRID', allocation)).toBe(expected);
    });

    it('falls back to debt-oriented when the allocation is unknown', () => {
      // The conservative direction: debt treatment is the higher tax, so an
      // unknown allocation cannot cause an understated liability.
      expect(taxCharacterFor('HYBRID')).toBe('DEBT_ORIENTED');
    });

    it('falls back to debt-oriented on an unparseable allocation', () => {
      expect(taxCharacterFor('HYBRID', 'not-a-number')).toBe('DEBT_ORIENTED');
    });

    it('honours overridden bands so the thresholds stay data, not code', () => {
      expect(
        taxCharacterFor('HYBRID', '55', { equityOrientedMinPct: 50, debtOrientedMaxPct: 20 }),
      ).toBe('EQUITY_ORIENTED');
    });
  });

  describe('Scenario: Only mutual funds carry a tax character', () => {
    it('returns a character for a categorised mutual fund', () => {
      expect(
        taxCharacterOf({ assetClass: 'DOMESTIC_MUTUAL_FUND', schemeCategory: 'DEBT' }),
      ).toBe('DEBT_ORIENTED');
    });

    it('returns none for a mutual fund with no category recorded', () => {
      expect(taxCharacterOf({ assetClass: 'DOMESTIC_MUTUAL_FUND' })).toBeUndefined();
    });

    it.each(['DOMESTIC_EQUITY', 'FOREIGN_EQUITY', 'FIXED_DEPOSIT', 'CRYPTO'] as const)(
      'returns none for %s, whose treatment follows from the class alone',
      (assetClass) => {
        expect(taxCharacterOf({ assetClass })).toBeUndefined();
      },
    );
  });

  describe('Every scheme category resolves to a character', () => {
    const ALL: readonly MfSchemeCategory[] = [
      'EQUITY',
      'DEBT',
      'HYBRID',
      'LIQUID',
      'ARBITRAGE',
      'SOLUTION_ORIENTED',
    ];

    it('maps all six categories without a gap', () => {
      for (const category of ALL) {
        expect(['EQUITY_ORIENTED', 'DEBT_ORIENTED', 'HYBRID_MID_BAND']).toContain(
          taxCharacterFor(category, '50'),
        );
      }
    });
  });
});
