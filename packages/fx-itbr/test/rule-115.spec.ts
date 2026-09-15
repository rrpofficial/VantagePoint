/**
 * US-2.3 — Fallback hierarchy resolver (PRD FR-2 AC)
 * US-2.4 — Rule 115 resolver (PRD FR-2 AC)
 * US-2.5 — Dual-rate conversion service (ADR-003)
 * US-2.6 — Retroactive rate finalisation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DualRateConverter,
  FallbackChain,
  RateAmendment,
  Rule115Resolver,
} from '@vantagepoint/fx-itbr';
import { aDualRate, expectErr, expectMoney, expectOk, inr, usd , seedStandardRates } from '@vantagepoint/test-kit';

beforeEach(() => {
  seedStandardRates();
  RateAmendment.clear();
  RateAmendment.resetSnapshotIndex();
});

describe('US-2.4 Rule 115 resolver', () => {
  describe('Scenario: Automated SBI ITBR fetch and Rule 115 compliance (PRD FR-2 AC)', () => {
    it('selects 2025-07-31 as the basis date for a 2025-08-14 dividend', () => {
      expect(Rule115Resolver.basisDateFor('2025-08-14')).toBe('2025-07-31');
    });

    it('resolves the SBI TTBR rate published for that basis date', () => {
      const resolved = expectOk(Rule115Resolver.resolve('USD', '2025-08-14'));
      expect(resolved.appliedDate).toBe('2025-07-31');
      expect(resolved.source).toBe('SBI_ITBR');
    });
  });

  describe('Scenario: January transaction uses the prior December rate', () => {
    it('selects 2025-12-31 for a 2026-01-05 transaction', () => {
      expect(Rule115Resolver.basisDateFor('2026-01-05')).toBe('2025-12-31');
    });

    it('crosses the calendar year boundary correctly', () => {
      const resolved = expectOk(Rule115Resolver.resolve('USD', '2026-01-05'));
      expect(resolved.appliedDate).toBe('2025-12-31');
    });
  });

  describe('Scenario: Preceding month-end on a non-publishing day walks backwards', () => {
    it('uses the last published rate on or before 2025-08-31 for a September transaction', () => {
      const resolved = expectOk(Rule115Resolver.resolve('USD', '2025-09-10'));
      expect(new Date(resolved.appliedDate).getTime()).toBeLessThanOrEqual(
        new Date('2025-08-31').getTime(),
      );
    });

    it('records the resolution path for audit', () => {
      const resolved = expectOk(Rule115Resolver.resolve('USD', '2025-09-10'));
      expect(resolved.resolutionPath.length).toBeGreaterThan(0);
    });
  });

  describe('Month-end basis dates across every month length', () => {
    it.each([
      ['2026-03-15', '2026-02-28'],
      ['2024-03-15', '2024-02-29'],
      ['2025-05-01', '2025-04-30'],
      ['2025-12-31', '2025-11-30'],
    ])('maps %s to basis date %s', (txnDate, expected) => {
      expect(Rule115Resolver.basisDateFor(txnDate)).toBe(expected);
    });
  });
});

describe('US-2.3 fallback hierarchy', () => {
  describe('Scenario: System fallback when SBI rate sheet is delayed (PRD FR-2 AC)', () => {
    it('applies the RBI reference rate for the nearest prior working day', () => {
      const resolved = expectOk(FallbackChain.resolve('USD', '2025-08-15'));
      expect(resolved.source).toBe('RBI_REFERENCE');
      expect(resolved.isFallback).toBe(true);
    });

    it('flags the transaction with the pending-finalisation note', () => {
      const resolved = expectOk(FallbackChain.resolve('USD', '2025-08-15'));
      expect(resolved.flag).toBe('Rate Source: RBI Fallback (Pending SBI ITBR Finalization)');
    });
  });

  describe('Scenario: Fallback order is SBI → RBI → ECB → OANDA', () => {
    it('falls through to the ECB rate for 2025-12-24 when SBI and RBI are absent', () => {
      const resolved = expectOk(FallbackChain.resolve('USD', '2025-12-25'));
      expect(resolved.source).toBe('ECB');
      expect(resolved.appliedDate).toBe('2025-12-24');
      expect(resolved.isFallback).toBe(true);
    });

    it('attempts sources in the mandated order', () => {
      const resolved = expectOk(FallbackChain.resolve('USD', '2025-12-25'));
      expect(resolved.resolutionPath).toEqual([
        'SBI_ITBR',
        'RBI_REFERENCE',
        'ECB',
      ]);
    });
  });

  describe('Scenario: Complete rate unavailability fails loudly', () => {
    it('fails with RATE_UNAVAILABLE rather than substituting a rate', () => {
      expectErr(FallbackChain.resolve('AED', '1990-01-01'), 'RATE_UNAVAILABLE');
    });

    it('never returns 1.0 as an implicit rate', () => {
      const result = FallbackChain.resolve('AED', '1990-01-01');
      expect(result.ok).toBe(false);
    });
  });
});

describe('US-2.5 dual-rate conversion (ADR-003)', () => {
  describe('Scenario: A single foreign transaction yields two distinct INR amounts', () => {
    const rates = aDualRate({ valuationRate: '84.10', taxRate: '83.55' });

    it('computes valuationInr as ₹605,520.00 at the 84.10 trade-date rate', () => {
      expectMoney(DualRateConverter.convert(usd('7200.00'), rates).valuationInr, inr('605520.00'));
    });

    it('computes taxableInr as ₹601,560.00 at the 83.55 Rule 115 rate', () => {
      expectMoney(DualRateConverter.convert(usd('7200.00'), rates).taxableInr, inr('601560.00'));
    });

    it('persists provenance for both rates', () => {
      const resolved = expectOk(DualRateConverter.ratesFor('USD', '2026-02-15'));
      expect(resolved.valuationRateSource).toBeDefined();
      expect(resolved.taxRateSource).toBeDefined();
    });
  });

  describe('Scenario: Tax computation never consumes the valuation rate', () => {
    it('returns the two amounts under distinct keys so a caller cannot confuse them', () => {
      const result = DualRateConverter.convert(usd('7200.00'), aDualRate());
      expect(Object.keys(result).sort()).toEqual(['taxableInr', 'valuationInr']);
    });
  });
});

describe('US-2.6 retroactive rate finalisation', () => {
  describe('Scenario: Late SBI rate supersedes a fallback and triggers recomputation', () => {
    const official = {
      currency: 'USD' as const,
      date: '2025-08-15',
      rate: '83.7500',
      source: 'SBI_ITBR' as const,
      rateType: 'TTBR' as const,
      retrievedAt: '2025-08-20T10:00:00+05:30',
      sourceDocumentRef: 'sbi-forex-2025-08-15.pdf',
    };

    it('records an amendment linking the previous and current rates', () => {
      const amendment = expectOk(
        RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official }),
      );
      expect(amendment.previous).not.toEqual(amendment.current);
      expect(amendment.amendmentId).toBeTruthy();
    });

    it('supersedes an RBI fallback with the official SBI rate', () => {
      const amendment = expectOk(
        RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official }),
      );
      expect(amendment.previous.valuationRateSource).toBe('RBI_REFERENCE');
      expect(amendment.current.valuationRateSource).toBe('SBI_ITBR');
      expect(amendment.current.valuationRate).toBe('83.7500');
    });

    it('reports the frozen snapshots covering that date without mutating them', () => {
      // A default index returns nothing, which would make this assertion vacuous.
      const frozen = Object.freeze({ snapshotId: 'DOM_31MAR2026', frozen: true });
      RateAmendment.registerSnapshotIndex({
        snapshotsCovering: (date) => (date === '2025-08-15' ? [frozen.snapshotId] : []),
      });
      try {
        const amendment = expectOk(
          RateAmendment.finaliseWithOfficialRate({ txnId: 'txn_0001', official }),
        );
        expect(amendment.affectedSnapshots).toEqual(['DOM_31MAR2026']);
        expect(Object.isFrozen(frozen)).toBe(true);
      } finally {
        RateAmendment.resetSnapshotIndex();
      }
    });

    it('refuses to finalise with a non-SBI rate', () => {
      expectErr(
        RateAmendment.finaliseWithOfficialRate({
          txnId: 'txn_0001',
          official: { ...official, source: 'RBI_REFERENCE' },
        }),
        'NOT_OFFICIAL_RATE',
      );
    });
  });
});
