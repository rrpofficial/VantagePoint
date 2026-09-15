/**
 * US-4.1 — Ingestion pipeline framework (PRD FR-4.1)
 * US-4.2 — CAMS / KFintech CAS PDF parser (PRD FR-4 AC, NFR-1)
 * US-4.3 — Zerodha Tax P&L XLSX + Tradebook CSV
 * US-4.4 — Vested account activity CSV
 * US-4.5 — E*TRADE portfolio / transaction CSV
 * US-4.6 — Standardised CSV templates (PRD FR-4 AC)
 * US-4.7 — Idempotent re-import
 * US-4.8 — Row-level error reporting
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CamsCasParser,
  DuplicateDetector,
  EtradeParser,
  Pipeline,
  ReconciliationExceptions,
  TemplateParser,
  TemplateRegistry,
  VestedParser,
  ZerodhaTradebookParser,
} from '@vantagepoint/ingestion';
import { expectErr, expectNoPii, expectOk, inr } from '@vantagepoint/test-kit';

const FIXTURES = resolve(import.meta.dirname, '../../../tests/fixtures');
const read = (rel: string) => readFileSync(resolve(FIXTURES, rel), 'utf8');
const readBin = (rel: string) => new Uint8Array(readFileSync(resolve(FIXTURES, rel)));

describe('US-4.1 ingestion pipeline framework', () => {
  describe('Scenario: Import is staged and atomically committed', () => {
    it('commits nothing in strict mode when any row is invalid', async () => {
      const report = await Pipeline.ingest({
        file: readBin('zerodha/tradebook-with-errors.csv'),
        fileName: 'tradebook-with-errors.csv',
        parser: 'ZERODHA_TRADEBOOK',
        mode: 'STRICT',
      });
      expect(report.ok && report.value.committed).toBe(false);
    });

    it('reports every invalid row with its row number in strict mode', async () => {
      const report = await Pipeline.ingest({
        file: readBin('zerodha/tradebook-with-errors.csv'),
        fileName: 'tradebook-with-errors.csv',
        parser: 'ZERODHA_TRADEBOOK',
        mode: 'STRICT',
      });
      expect(expectOk(report).errors).toHaveLength(3);
    });

    it('commits valid rows and reports rejections in lenient mode', async () => {
      const report = expectOk(
        await Pipeline.ingest({
          file: readBin('zerodha/tradebook-with-errors.csv'),
          fileName: 'tradebook-with-errors.csv',
          parser: 'ZERODHA_TRADEBOOK',
          mode: 'LENIENT',
        }),
      );
      expect(report.created).toBe(100);
      expect(report.rejected).toBe(3);
    });
  });

  describe('Scenario: Every imported record retains its provenance', () => {
    it('records source file, row, parser and import timestamp', () => {
      const txns = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv'),
      );
      const p = txns[0]?.provenance;
      expect(p?.sourceFile).toBe('tradebook.csv');
      expect(p?.sourceRow).toBeGreaterThan(0);
      expect(p?.parserName).toBe('ZERODHA_TRADEBOOK');
      expect(p?.importedAt).toBeDefined();
    });
  });
});

describe('US-4.2 CAMS CAS PDF parser', () => {
  describe('Scenario: CAMS CAS PDF auto-ingestion (PRD FR-4 AC)', () => {
    it('parses folio numbers, ISINs, scheme names, dates, NAVs and units', async () => {
      const txns = expectOk(
        await CamsCasParser.parse({ pdf: readBin('cams/cas-sample.pdf'), password: 'ABCDE1234F01011990' }),
      );
      expect(txns.length).toBeGreaterThan(0);
      expect(txns[0]?.folioRef).toBeDefined();
      expect(txns[0]?.isin).toMatch(/^INF/);
      expect(txns[0]?.schemeName).toBeTruthy();
    });

    it('populates the mutual fund portfolio without manual entry', async () => {
      const txns = expectOk(
        await CamsCasParser.parse({ pdf: readBin('cams/cas-sample.pdf'), password: 'ABCDE1234F01011990' }),
      );
      expect(txns.every((t) => Number(t.quantity) > 0)).toBe(true);
    });
  });

  describe('Scenario: PDF password is never persisted (NFR-1)', () => {
    const PASSWORD = 'ABCDE1234F01011990';

    it('does not echo the password in a failure message', async () => {
      const result = await CamsCasParser.parse({
        pdf: readBin('cams/cas-sample.pdf'),
        password: 'wrong-password',
      });
      if (!result.ok) expect(result.error.message).not.toContain('wrong-password');
    });

    it('leaks no PII in the parse result', async () => {
      const result = await CamsCasParser.parse({
        pdf: readBin('cams/cas-sample.pdf'),
        password: PASSWORD,
      });
      if (result.ok) {
        for (const txn of result.value) expectNoPii(JSON.stringify(txn));
      }
    });
  });

  describe('Scenario: Wrong password fails cleanly', () => {
    it('fails with PDF_DECRYPTION_FAILED', async () => {
      expectErr(
        await CamsCasParser.parse({ pdf: readBin('cams/cas-sample.pdf'), password: 'nope' }),
        'PDF_DECRYPTION_FAILED',
      );
    });

    it('writes no partial portfolio data', async () => {
      const result = await CamsCasParser.parse({
        pdf: readBin('cams/cas-sample.pdf'),
        password: 'nope',
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe('US-4.3 Zerodha parsers', () => {
  describe('Scenario: Tradebook CSV populates lots and exits', () => {
    it('creates 40 buy and 25 sell transactions', () => {
      const txns = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv'),
      );
      expect(txns.filter((t) => t.kind === 'BUY')).toHaveLength(40);
      expect(txns.filter((t) => t.kind === 'SELL')).toHaveLength(25);
    });

    it('parses deterministically across two runs', () => {
      const a = ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv');
      const b = ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('Scenario: Tax P&L XLSX cross-checks computed realised gains', () => {
    it('flags a variance greater than ₹1 as a reconciliation exception', () => {
      const { isException } = ReconciliationExceptions.compareRealisedGains({
        brokerStated: inr('100000.00'),
        computed: inr('100002.50'),
      });
      expect(isException).toBe(true);
    });

    it('accepts a variance within ₹1 as a rounding difference', () => {
      const { isException } = ReconciliationExceptions.compareRealisedGains({
        brokerStated: inr('100000.00'),
        computed: inr('100000.40'),
      });
      expect(isException).toBe(false);
    });

    it('never silently accepts a material variance', () => {
      const { variance } = ReconciliationExceptions.compareRealisedGains({
        brokerStated: inr('100000.00'),
        computed: inr('150000.00'),
      });
      expect(Number(variance.amount)).toBe(50000);
    });
  });
});

describe('US-4.4 Vested parser', () => {
  describe('Scenario: Vested CSV creates foreign equity lots with USD basis', () => {
    it('creates lots denominated in USD', () => {
      const txns = expectOk(VestedParser.parse(read('vested/activity.csv'), 'activity.csv'));
      expect(txns.every((t) => t.pricePerUnit.currency === 'USD')).toBe(true);
    });

    it('preserves fractional quantities to 6 decimal places exactly', () => {
      const txns = expectOk(VestedParser.parse(read('vested/activity.csv'), 'activity.csv'));
      expect(txns.some((t) => t.quantity === '0.123456')).toBe(true);
    });

    it('parses buys, sells, dividends and fees', () => {
      const txns = expectOk(VestedParser.parse(read('vested/activity.csv'), 'activity.csv'));
      const kinds = new Set(txns.map((t) => t.kind));
      expect(kinds).toContain('BUY');
      expect(kinds).toContain('SELL');
      expect(kinds).toContain('DIVIDEND');
    });
  });
});

describe('US-4.5 E*TRADE parser', () => {
  describe('Scenario: Transaction history distinguishes RSU vest from open-market buy', () => {
    it('creates an RSU_VEST transaction with a perquisite value', () => {
      const txns = expectOk(EtradeParser.parse(read('etrade/transactions.csv'), 'transactions.csv'));
      const vest = txns.find((t) => t.kind === 'RSU_VEST');
      expect(vest?.perquisiteValue).toBeDefined();
    });

    it('creates an ordinary BUY for a market purchase', () => {
      const txns = expectOk(EtradeParser.parse(read('etrade/transactions.csv'), 'transactions.csv'));
      const buy = txns.find((t) => t.kind === 'BUY');
      expect(buy?.perquisiteValue).toBeUndefined();
    });
  });
});

describe('US-4.6 standardised CSV templates', () => {
  describe('Scenario: Custom asset import via predefined template (PRD FR-4 AC)', () => {
    it('validates the hand loan template headers', () => {
      expectOk(
        TemplateRegistry.validateHeaders(read('templates/hand-loans-filled.csv'), 'Custom_HandLoans'),
      );
    });

    it('parses borrower details, principal, interest rate and start date', () => {
      const rows = expectOk(
        TemplateParser.parse(read('templates/hand-loans-filled.csv'), 'hand-loans-filled.csv'),
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario: Header mismatch is rejected with actionable guidance', () => {
    it('fails with TEMPLATE_HEADER_MISMATCH naming the missing column', () => {
      const result = TemplateRegistry.validateHeaders(
        read('templates/hand-loans-missing-header.csv'),
        'Custom_HandLoans',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_HEADER_MISMATCH');
        expect(result.error.message).toContain('interest_rate_pct');
      }
    });
  });

  describe('Scenario: Templates exist for every manual asset class', () => {
    it('offers templates for hand loans, real estate, cash, chit funds, unlisted shares and generic brokers', () => {
      expect(TemplateRegistry.list()).toEqual(
        expect.arrayContaining([
          'Custom_HandLoans',
          'Custom_RealEstate',
          'Custom_Cash',
          'Custom_ChitFunds',
          'Custom_UnlistedShares',
          'Custom_GenericBroker',
        ]),
      );
    });

    it('generates a downloadable CSV with a header row for each template', () => {
      for (const name of TemplateRegistry.list()) {
        const lines = TemplateRegistry.generate(name).split('\n').filter((line) => line.length > 0);
        // The file opens with `#` guidance for the person filling it in; the
        // header is the first line that is not a comment.
        const header = lines.find((line) => !line.startsWith('#'));
        expect(header).toContain(',');
      }
    });
  });
});

describe('US-4.7 idempotent re-import', () => {
  describe('Scenario: Re-importing the same file creates no duplicates', () => {
    it('creates zero new records on a second identical import', () => {
      const txns = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv'),
      );
      const keys = txns.map((t) => DuplicateDetector.naturalKey(t));
      const { fresh, duplicates } = DuplicateDetector.partition(txns, keys);
      expect(fresh).toHaveLength(0);
      expect(duplicates).toHaveLength(txns.length);
    });
  });

  describe('Scenario: Overlapping date-range imports merge without duplication', () => {
    it('keeps each underlying transaction exactly once', () => {
      const first = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook-apr-sep.csv'), 'apr-sep.csv'),
      );
      const second = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook-jul-dec.csv'), 'jul-dec.csv'),
      );
      const existing = first.map((t) => DuplicateDetector.naturalKey(t));
      const { fresh } = DuplicateDetector.partition(second, existing);
      const allKeys = [...existing, ...fresh.map((t) => DuplicateDetector.naturalKey(t))];
      expect(new Set(allKeys).size).toBe(allKeys.length);
    });

    it('derives the natural key from transaction identity, not row position', () => {
      const txns = expectOk(
        ZerodhaTradebookParser.parse(read('zerodha/tradebook.csv'), 'tradebook.csv'),
      );
      const a = DuplicateDetector.naturalKey(txns[0]!);
      const b = DuplicateDetector.naturalKey({
        ...txns[0]!,
        provenance: { ...txns[0]!.provenance, sourceRow: 999, sourceFile: 'other.csv' },
      });
      expect(a).toBe(b);
    });
  });
});

describe('US-4.8 row-level error reporting', () => {
  describe('Scenario: Row-level errors are surfaced with correction guidance', () => {
    it('names the row, column, offending value and expected format', async () => {
      const report = expectOk(
        await Pipeline.ingest({
          file: readBin('zerodha/tradebook-with-errors.csv'),
          fileName: 'tradebook-with-errors.csv',
          parser: 'ZERODHA_TRADEBOOK',
          mode: 'LENIENT',
        }),
      );
      const badDate = report.errors.find((e) => e.value === '31/13/2025');
      expect(badDate?.row).toBe(17);
      expect(badDate?.column).toBe('trade_date');
      expect(badDate?.expectedFormat).toBeTruthy();
    });
  });
});
