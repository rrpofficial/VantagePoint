/**
 * US-2.1 — FX rate store with provenance (PRD FR-2.1)
 * US-2.2 — SBI ITBR ingestion pipeline
 */
import { describe, it, expect } from 'vitest';
import { RateStore, SbiSheetParser, type RateRecord } from '@vantagepoint/fx-itbr';
import { expectErr, expectOk } from '@vantagepoint/test-kit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, '../../../tests/fixtures/rates');

const USD_31JUL: RateRecord = {
  currency: 'USD',
  date: '2025-07-31',
  rate: '83.4500',
  source: 'SBI_ITBR',
  rateType: 'TTBR',
  retrievedAt: '2025-08-01T10:00:00+05:30',
  sourceDocumentRef: 'sbi-forex-2025-07-31.pdf',
};

describe('US-2.1 rate store', () => {
  describe('Scenario: Every stored rate carries its source and retrieval timestamp', () => {
    it('retains source, rate type, retrieval time and document reference', () => {
      expectOk(RateStore.put(USD_31JUL));
      const stored = RateStore.get('USD', '2025-07-31', 'SBI_ITBR');
      expect(stored?.source).toBe('SBI_ITBR');
      expect(stored?.rateType).toBe('TTBR');
      expect(stored?.retrievedAt).toBeDefined();
      expect(stored?.sourceDocumentRef).toBe('sbi-forex-2025-07-31.pdf');
    });

    it('is idempotent for an identical repeat write', () => {
      expectOk(RateStore.put(USD_31JUL));
      expectOk(RateStore.put(USD_31JUL));
    });
  });

  describe('Scenario: Conflicting rate for the same key is rejected, not overwritten', () => {
    it('fails with RATE_CONFLICT when the same key gets a different value', () => {
      expectOk(RateStore.put(USD_31JUL));
      expectErr(RateStore.put({ ...USD_31JUL, rate: '83.9000' }), 'RATE_CONFLICT');
    });

    it('leaves the original value in place after a conflict', () => {
      expectOk(RateStore.put(USD_31JUL));
      RateStore.put({ ...USD_31JUL, rate: '83.9000' });
      expect(RateStore.get('USD', '2025-07-31', 'SBI_ITBR')?.rate).toBe('83.4500');
    });
  });

  describe('latestOnOrBefore walks backwards over non-publishing days', () => {
    it('returns the 2025-07-31 rate when asked for 2025-08-03', () => {
      expectOk(RateStore.put(USD_31JUL));
      expect(RateStore.latestOnOrBefore('USD', '2025-08-03', 'SBI_ITBR')?.date).toBe('2025-07-31');
    });
  });
});

describe('US-2.2 SBI ITBR ingestion', () => {
  describe('Scenario: Daily SBI rate sheet is parsed into rate records', () => {
    it('extracts TTBR rates for USD, EUR, GBP, SGD and AED', () => {
      const sheet = readFileSync(resolve(FIXTURES, 'sbi-forex-2025-07-31.csv'), 'utf8');
      const records = expectOk(SbiSheetParser.parse(sheet));
      expect(records.map((r) => r.currency).sort()).toEqual(['AED', 'EUR', 'GBP', 'SGD', 'USD']);
    });

    it('tags every parsed record with source SBI_ITBR', () => {
      const sheet = readFileSync(resolve(FIXTURES, 'sbi-forex-2025-07-31.csv'), 'utf8');
      const records = expectOk(SbiSheetParser.parse(sheet));
      expect(records.every((r) => r.source === 'SBI_ITBR')).toBe(true);
    });

    it('retains the source document reference for audit', () => {
      const sheet = readFileSync(resolve(FIXTURES, 'sbi-forex-2025-07-31.csv'), 'utf8');
      const records = expectOk(SbiSheetParser.parse(sheet));
      expect(records.every((r) => r.sourceDocumentRef.length > 0)).toBe(true);
    });
  });

  describe('Scenario: Malformed rate sheet does not corrupt the store', () => {
    it('commits nothing and names the missing USD column', () => {
      const sheet = readFileSync(resolve(FIXTURES, 'sbi-forex-malformed.csv'), 'utf8');
      const result = SbiSheetParser.parse(sheet);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('USD');
    });
  });
});
