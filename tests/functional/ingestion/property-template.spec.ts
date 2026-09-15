/**
 * FUNCTIONAL — the property TEMPLATE reaches the same ledger the form does.
 *
 * Two entry points, one requirement. The manual form was built first and the
 * template lagged it: it hard-coded `kind: 'BUY'`, so a SALE could not be
 * imported at all, and it had no column for address, PIN code, survey number,
 * document reference, notes or a current value.
 *
 * These pin parity. A field the form accepts and the template silently drops is
 * the failure mode worth guarding, because the import reports success either way
 * and the missing value only surfaces later as a blank on screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ImportStatementUC,
  LedgerUC,
  VaultUC,
  resetPorts,
} from '@porttrack/app-services';
import { TemplateRegistry } from '@porttrack/ingestion';
import { Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';

/** Built by column NAME, so a template that gains a field cannot shift the row. */
function row(values: Readonly<Record<string, string>>): string {
  const template = TemplateRegistry.definitions().find(
    (entry) => entry.name === 'Custom_RealEstate',
  );
  if (template === undefined) throw new Error('Custom_RealEstate is not registered');

  const unknown = Object.keys(values).filter((key) => !template.columns.includes(key));
  if (unknown.length > 0) throw new Error(`no such column(s): ${unknown.join(', ')}`);

  // Quoted where it has to be: an address contains a comma, and an unquoted one
  // shifts every later cell one column left — which reads as the parser dropping
  // fields rather than as a malformed row.
  const cell = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

  return template.columns.map((column) => cell(values[column] ?? '')).join(',');
}

const csvOf = (...rows: readonly string[]) =>
  [TemplateRegistry.generate('Custom_RealEstate').trimEnd(), ...rows].join('\n');

const importCsv = (csv: string) =>
  ImportStatementUC.execute({
    file: Buffer.from(`${csv}\n`, 'utf8'),
    fileName: 'property.csv',
    parser: 'TEMPLATE',
    mode: 'STRICT',
  });

const propertyAsset = async () => {
  const assets = await LedgerUC.assets();
  return assets.find((asset) => asset.assetClass === 'REAL_ESTATE');
};

const PURCHASE = row({
  property_name: 'Whitefield flat',
  property_type: 'FLAT',
  transaction_type: 'BUY',
  purchase_date: '2024-06-10',
  area: '1450',
  area_unit: 'SQ_FT',
  purchase_price: '9500000',
  stamp_duty: '570000',
  registration_fee: '30000',
  other_taxes: '9500',
  brokerage: '95000',
  address: '12 Palm Grove, Whitefield',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560066',
  registration_number: 'WHF/2024/1182',
  survey_number: '42/3B',
  document_ref: 'DOC-8891',
  notes: 'Two-bedroom, east facing',
  current_value: '14000000',
  current_value_date: '2026-09-01',
  current_value_basis: 'CIRCLE_RATE',
  currency: 'INR',
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-prop-tmpl-'));
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

describe('Scenario: The template carries every field the form does', () => {
  it('records the property’s own facts', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const property = (await propertyAsset())?.property;
    expect(property?.propertyName).toBe('Whitefield flat');
    expect(property?.kind).toBe('FLAT');
    expect(property?.area).toEqual({ value: '1450', unit: 'SQ_FT' });
    expect(property?.registrationNumber).toBe('WHF/2024/1182');
    expect(property?.surveyNumber).toBe('42/3B');
    expect(property?.notes).toBe('Two-bedroom, east facing');
  });

  it('records the full location, PIN code included', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const location = (await propertyAsset())?.property?.location;
    expect(location?.address).toBe('12 Palm Grove, Whitefield');
    expect(location?.city).toBe('Bengaluru');
    expect(location?.state).toBe('Karnataka');
    expect(location?.pincode).toBe('560066');
  });

  /** Hashed at the parser boundary, exactly as a borrower's name is (ADR-013). */
  it('gives the address an opaque reference', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const location = (await propertyAsset())?.property?.location;
    expect(location?.addressRef).toMatch(/^addr_[0-9a-f]{16}$/);
    expect(location?.addressRef).not.toContain('Palm');
  });

  it('records every duty separately, and the document reference', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const detail = (await propertyAsset())?.lots[0]?.property;
    expect(detail?.consideration.amount).toBe('9500000');
    expect(detail?.stampDuty.amount).toBe('570000');
    expect(detail?.registrationFee.amount).toBe('30000');
    expect(detail?.otherTaxes.amount).toBe('9500');
    expect(detail?.brokerage?.amount).toBe('95000');
    expect(detail?.documentRef).toBe('DOC-8891');
  });

  it('records a current value with its basis and date', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const value = (await propertyAsset())?.property?.currentValue;
    expect(value?.amount.amount).toBe('14000000');
    expect(value?.asOf).toBe('2026-09-01');
    expect(value?.basis).toBe('CIRCLE_RATE');
  });

  /** All three or none — a bare number is what `ValuationBasis` exists to prevent. */
  it('ignores a current value with no basis', async () => {
    const noBasis = row({
      property_name: 'Plot A',
      purchase_date: '2024-06-10',
      purchase_price: '2000000',
      current_value: '3000000',
      currency: 'INR',
    });
    expectOk(await importCsv(csvOf(noBasis)));

    expect((await propertyAsset())?.property?.currentValue).toBeUndefined();
  });
});

describe('Scenario: A sale can be imported, not only a purchase', () => {
  /*
   * The gap this file was written for. The parser emitted `kind: 'BUY'`
   * unconditionally, so a SELL row was imported as a second PURCHASE — which
   * does not merely lose the disposal, it DOUBLES the holding and the cost.
   */
  it('records a SELL row as a disposal', async () => {
    const sale = row({
      property_name: 'Whitefield flat',
      property_type: 'FLAT',
      transaction_type: 'SELL',
      purchase_date: '2026-05-20',
      area: '1450',
      area_unit: 'SQ_FT',
      purchase_price: '14500000',
      brokerage: '200000',
      currency: 'INR',
    });
    expectOk(await importCsv(csvOf(PURCHASE, sale)));

    const exits = await LedgerUC.exits();
    expect(exits).toHaveLength(1);
    expect(exits[0]?.exitDate).toBe('2026-05-20');
    expect(exits[0]?.property?.consideration.amount).toBe('14500000');
    expect(Number((await propertyAsset())?.heldQuantity)).toBe(0);
  });

  it('treats a blank transaction_type as a purchase, as older sheets intend', async () => {
    const legacy = row({
      property_name: 'Plot B',
      purchase_date: '2024-02-01',
      purchase_price: '3000000',
      currency: 'INR',
    });
    expectOk(await importCsv(csvOf(legacy)));

    expect(await LedgerUC.exits()).toHaveLength(0);
    expect(Number((await propertyAsset())?.heldQuantity)).toBe(1);
  });
});

describe('Scenario: A sheet written before the template grew still imports', () => {
  /*
   * The six-column original. Every column added since is optional precisely so
   * this keeps working — rejecting it over a header mismatch would strand files
   * already on disk.
   */
  it('accepts the original six columns', async () => {
    const legacy = [
      'property_name,purchase_date,purchase_price,stamp_duty,registration_fee,currency',
      'Old flat,2020-03-15,4500000,270000,20000,INR',
    ].join('\n');

    expectOk(await importCsv(legacy));

    const asset = await propertyAsset();
    expect(asset?.property?.propertyName).toBe('Old flat');
    // No type was stated, and guessing one would invent a tax characteristic.
    expect(asset?.property?.kind).toBe('OTHER');
    expect(asset?.lots[0]?.property?.stampDuty.amount).toBe('270000');
    expect(asset?.lots[0]?.property?.registrationFee.amount).toBe('20000');
    // 45,00,000 + 2,70,000 + 20,000
    expect(Number(asset?.costBasis.amount)).toBeCloseTo(4_790_000, 0);
  });

  /** A blank rate must not be read as ₹0 and become the cost per unit. */
  it('does not zero the price when no rate per unit is given', async () => {
    expectOk(await importCsv(csvOf(PURCHASE)));

    const lot = (await propertyAsset())?.lots[0];
    expect(lot?.quantity).toBe('1450');
    expect(Number(lot?.costPerUnit.amount)).toBeCloseTo(6551.72, 2);
  });
});
