/**
 * FUNCTIONAL — Phase 7: export per register, CSV and PDF.
 *
 * Three things here are not cosmetic:
 *
 *  1. **Money never round-trips through a float (ADR-002).** A cell that went
 *     through `Number()` is a corrupted figure that still looks fine, so the
 *     bytes are asserted against the decimal string the domain produced.
 *  2. **Masking is an explicit choice (ADR-013).** A street address must not
 *     leave in a file the user will email unless they asked for it, and the file
 *     must say which way it was made.
 *  3. **A provisional year cannot produce a filing artifact.** A disposals table
 *     states a taxable gain against an assessment year, which is what
 *     `assertFilingReady` exists to keep off unverified rates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BalanceUC,
  ChitUC,
  ExportUC,
  PropertyUC,
  TradeUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

beforeEach(async () => {
  resetPorts();
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-exports-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
});

const aChit = async (): Promise<void> => {
  expectOk(
    await ChitUC.open({
      org: 'Sri Balaji Chits',
      label: '5L / 25 months',
      targetAmount: inr('500000'),
      startDate: '2025-04-01',
      durationMonths: 25,
      emiType: 'CONSTANT',
    }),
  );
};

const aHolding = async (): Promise<void> => {
  expectOk(
    await TradeUC.record({
      assetClass: 'DOMESTIC_EQUITY',
      side: 'BUY',
      tradeDate: '2025-06-02',
      symbol: 'INFY',
      quantity: '100',
      pricePerUnit: inr('1500.75'),
      fees: inr('120.50'),
    }),
  );
};

const aProperty = async (): Promise<void> => {
  expectOk(
    await PropertyUC.record({
      side: 'BUY',
      transactionDate: '2024-06-10',
      propertyName: 'Whitefield flat',
      kind: 'FLAT',
      consideration: '95,00,000',
      areaValue: '1450',
      areaUnit: 'SQ_FT',
      stampDuty: '5,70,000',
      registrationFee: '30,000',
      address: '12 Palm Grove, Whitefield',
      city: 'Bengaluru',
      state: 'Karnataka',
    }),
  );
};

describe('Phase 7 Scenario: Every register exports to CSV and PDF', () => {
  it.each(['chits', 'holdings', 'property', 'balances'] as const)(
    'produces a %s CSV carrying its own title and provenance',
    async (register) => {
      await aChit();
      await aHolding();
      await aProperty();
      expectOk(
        await BalanceUC.record({
          assetClass: 'FIXED_DEPOSIT',
          label: 'HDFC FD',
          openingBalance: '500000',
          openedOn: '2025-04-01',
          annualRatePct: '7.1',
        }),
      );

      const file = expectOk(await ExportUC.execute({ register, format: 'csv' }));

      expect(file.contentType).toContain('text/csv');
      expect(file.fileName).toMatch(new RegExp(`^VantagePoint-${register}-masked-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
      expect(text(file.bytes)).toContain('# VantagePoint');
    },
  );

  it.each(['chits', 'holdings', 'property', 'balances'] as const)(
    'produces a %s PDF a reader will open',
    async (register) => {
      await aChit();
      await aHolding();
      await aProperty();

      const file = expectOk(await ExportUC.execute({ register, format: 'pdf' }));

      expect(file.contentType).toBe('application/pdf');
      const body = Buffer.from(file.bytes).toString('latin1');
      expect(body.startsWith('%PDF-1.4')).toBe(true);
      expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
      // A PDF is a record, so it says when it was made.
      expect(body).toContain('Generated ');
    },
  );

  it('exports an empty register as a page saying so, not as an unopenable file', async () => {
    const file = expectOk(await ExportUC.execute({ register: 'chits', format: 'pdf' }));
    expect(Buffer.from(file.bytes).toString('latin1')).toContain('Chit fund register');
  });
});

describe('Phase 7 Scenario: Money reaches the byte as a decimal string (ADR-002)', () => {
  it('writes the exact figure the domain produced, never a rounded float', async () => {
    await aHolding();

    const csv = text(expectOk(await ExportUC.execute({ register: 'holdings', format: 'csv' })).bytes);

    // 100 × 1500.75 + 120.50 = 150195.5, and the cost per unit keeps its own
    // paise rather than being reconstructed from a float.
    expect(csv).toContain('1500.75');
    expect(csv).toContain('150195.5');
  });

  /*
   * The trap a float actually falls into. `3 × 0.1` is 0.30000000000000004 in
   * IEEE 754, and `0.1 + 0.2` is 0.30000000000000004 as well — either would
   * appear in the cell as a long tail of nines or zeros. Decimal arithmetic
   * gives exactly 0.3, which is what the byte must say.
   */
  it('multiplies a fractional quantity without producing a float tail', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'GOLD_PHYSICAL',
        side: 'BUY',
        tradeDate: '2025-06-02',
        symbol: 'Gold 24k',
        quantity: '3',
        pricePerUnit: inr('0.1'),
      }),
    );

    const csv = text(expectOk(await ExportUC.execute({ register: 'holdings', format: 'csv' })).bytes);

    expect(csv).toContain('0.3');
    expect(csv).not.toContain('0.30000000000000004');
    expect(csv).not.toMatch(/\d\.\d*(999999|000000\d)/);
  });

  it('quotes a cell containing a comma rather than shifting every column after it', async () => {
    await aProperty();

    const csv = text(
      expectOk(
        await ExportUC.execute({ register: 'property', format: 'csv', includePii: true }),
      ).bytes,
    );

    const row = csv.split('\n').find((line) => line.includes('Whitefield flat'));
    expect(row).toContain('"12 Palm Grove, Whitefield, Bengaluru, Karnataka"');
  });
});

describe('Phase 7 Scenario: Masking is an explicit choice, never a silent default', () => {
  it('replaces the street address with its opaque reference by default', async () => {
    await aProperty();

    const csv = text(expectOk(await ExportUC.execute({ register: 'property', format: 'csv' })).bytes);

    expect(csv).not.toContain('12 Palm Grove');
    expect(csv).toMatch(/addr_[0-9a-f]{16}/);
    // The file says which way it was made, so a recipient can tell.
    expect(csv).toContain('replaced by opaque references');
  });

  it('includes the address when the export asks for it, and says so in the file', async () => {
    await aProperty();

    const csv = text(
      expectOk(
        await ExportUC.execute({ register: 'property', format: 'csv', includePii: true }),
      ).bytes,
    );

    expect(csv).toContain('12 Palm Grove');
    expect(csv).toContain('Treat this file as confidential');
  });

  it('names the masked file differently, so the two cannot be confused on disk', async () => {
    await aProperty();

    const masked = expectOk(await ExportUC.execute({ register: 'property', format: 'csv' }));
    const full = expectOk(
      await ExportUC.execute({ register: 'property', format: 'csv', includePii: true }),
    );

    expect(masked.fileName).toContain('-masked-');
    expect(full.fileName).not.toContain('-masked-');
  });
});

describe('Phase 7 Scenario: A holdings export supports a capital-gains conversation', () => {
  it('carries a row per LOT, not only a summary per holding', async () => {
    await aHolding();
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-09-04',
        symbol: 'INFY',
        quantity: '50',
        pricePerUnit: inr('1600'),
      }),
    );

    const csv = text(expectOk(await ExportUC.execute({ register: 'holdings', format: 'csv' })).bytes);

    expect(csv).toContain('VantagePoint — Holdings');
    // A summary alone cannot support the conversation the export exists for.
    expect(csv).toContain('VantagePoint — Acquisition lots');
    expect(csv).toContain('2025-06-02');
    expect(csv).toContain('2025-09-04');
  });

  it('states that no year was selected rather than implying nothing was sold', async () => {
    await aHolding();

    const csv = text(expectOk(await ExportUC.execute({ register: 'holdings', format: 'csv' })).bytes);

    expect(csv).toContain('This is not a statement that none occurred');
  });

  it('lists the disposals for a selected, VERIFIED financial year', async () => {
    await aHolding();
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'SELL',
        tradeDate: '2025-11-10',
        symbol: 'INFY',
        quantity: '40',
        pricePerUnit: inr('1800'),
      }),
    );

    const csv = text(
      expectOk(
        await ExportUC.execute({
          register: 'holdings',
          format: 'csv',
          financialYear: '2025-26',
        }),
      ).bytes,
    );

    expect(csv).toContain('VantagePoint — Disposals');
    expect(csv).toContain('2025-11-10');
    expect(csv).toContain('assessment year 2026-27');
  });

  /*
   * The gate the plan asks for: "a PDF that looks like a filing document and
   * rests on a provisional rule set is exactly the artifact that gate exists to
   * prevent."
   */
  it('refuses a disposals export for a PROVISIONAL year', async () => {
    await aHolding();

    const result = await ExportUC.execute({
      register: 'holdings',
      format: 'pdf',
      financialYear: '2024-25',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('PROVISIONAL');
      expect(result.error.message).toContain('Filing artifacts cannot be produced');
    }
  });

  it('still exports holdings and lots for that year with no disposals requested', async () => {
    await aHolding();
    // The gate is on the FILING artifact, not on getting your own data out.
    expectOk(await ExportUC.execute({ register: 'holdings', format: 'pdf' }));
  });
});

describe('Phase 7 Scenario: The export refuses a locked vault', () => {
  it('produces nothing once the vault is locked', async () => {
    await aChit();
    await VaultUC.lock();

    const result = await ExportUC.execute({ register: 'chits', format: 'csv' });

    expect(result.ok).toBe(false);
  });
});
