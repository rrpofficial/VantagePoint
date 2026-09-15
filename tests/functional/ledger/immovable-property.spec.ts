/**
 * FUNCTIONAL — immovable property has a shape of its own.
 *
 * Property was recorded through the instrument shape: quantity `'1'`, the whole
 * price in `costPerUnit`, the name in `symbol` — a ticker column — and the
 * duties split across `fees` and `otherCharges` with nothing recording which was
 * which. There was no type, no area, no location, no current value, and no way
 * to record a sale at all.
 *
 * Worse than untidy: the importer wrote stamp duty to `otherCharges`, while the
 * screen read `stt` as "Stamp duty" — a field nothing sets for property, since
 * STT is a SECURITIES transaction tax. Every property showed ₹0 stamp duty.
 *
 * What these pin:
 *   - every field the deed states round-trips, including area and its unit;
 *   - the duties reach the cost basis, and `stt` stays zero;
 *   - area drives quantity, so a per-unit rate is expressible;
 *   - a sale is recordable and depletes the holding;
 *   - a current value is kept but never counted as the asset's value;
 *   - s.50C / s.56(2)(x) exposure is reported rather than silently dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  LedgerUC,
  PropertyUC,
  ValuePortfolioUC,
  VaultUC,
  resetPorts,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';

/** A flat, with every figure a sale deed actually states. */
const PURCHASE = {
  side: 'BUY' as const,
  transactionDate: '2024-06-10',
  propertyName: 'Whitefield flat',
  kind: 'FLAT' as const,
  areaValue: '1450',
  areaUnit: 'SQ_FT' as const,
  consideration: '95,00,000',
  stampDuty: '5,70,000',
  registrationFee: '30,000',
  gst: '0',
  otherTaxes: '9,500',
  brokerage: '95,000',
  city: 'Bengaluru',
  state: 'Karnataka',
  address: '12 Palm Grove, Whitefield',
  registrationNumber: 'WHF/2024/1182',
};

const propertyAsset = async () => {
  const assets = await LedgerUC.assets();
  return assets.find((asset) => asset.assetClass === 'REAL_ESTATE');
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-property-'));
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

describe('Scenario: A purchase records what the deed states', () => {
  it('keeps the property’s own facts, not just a price', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    const asset = await propertyAsset();
    expect(asset?.property?.propertyName).toBe('Whitefield flat');
    expect(asset?.property?.kind).toBe('FLAT');
    expect(asset?.property?.area).toEqual({ value: '1450', unit: 'SQ_FT' });
    expect(asset?.property?.location?.city).toBe('Bengaluru');
    expect(asset?.property?.location?.state).toBe('Karnataka');
    expect(asset?.property?.registrationNumber).toBe('WHF/2024/1182');
  });

  /*
   * ADR-013. A street address identifies a household, so it follows the
   * borrower-name rule: the plain value is in the vault and a reference is what
   * anything leaving this machine carries.
   */
  it('gives the address an opaque reference alongside the address itself', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    const location = (await propertyAsset())?.property?.location;
    expect(location?.address).toBe('12 Palm Grove, Whitefield');
    expect(location?.addressRef).toMatch(/^addr_[0-9a-f]{16}$/);
    expect(location?.addressRef).not.toContain('Palm');
  });

  it('breaks the duties out instead of merging them into one charge', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    const detail = (await propertyAsset())?.lots[0]?.property;
    expect(detail?.consideration.amount).toBe('9500000');
    expect(detail?.stampDuty.amount).toBe('570000');
    expect(detail?.registrationFee.amount).toBe('30000');
    expect(detail?.gst.amount).toBe('0');
    expect(detail?.otherTaxes.amount).toBe('9500');
    expect(detail?.brokerage?.amount).toBe('95000');
  });

  /*
   * STT is a SECURITIES transaction tax and cannot arise on land. The old
   * importer wrote stamp duty here and the screen read it back as stamp duty
   * from a field that was always zero.
   */
  it('leaves securities transaction tax at zero, where property is concerned', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    expect((await propertyAsset())?.lots[0]?.stt.amount).toBe('0');
  });

  /** Every duty is cost of acquisition, which is what Schedule AL reports. */
  it('adds every duty to the cost basis', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    // 95,00,000 + 5,70,000 + 30,000 + 9,500 + 95,000 = 1,02,04,500
    const asset = await propertyAsset();
    expect(Number(asset?.costBasis.amount)).toBeCloseTo(10_204_500, 0);
  });

  /*
   * Area becomes quantity, so `quantity × costPerUnit` reads as "1450 sq ft at
   * ₹6,551.72" rather than "1 at ₹95,00,000" — which is what made a per-unit
   * rate impossible to express at all.
   */
  it('uses the area as the quantity, so a rate per unit exists', async () => {
    expectOk(await PropertyUC.record(PURCHASE));

    const lot = (await propertyAsset())?.lots[0];
    expect(lot?.quantity).toBe('1450');
    expect(Number(lot?.costPerUnit.amount)).toBeCloseTo(6551.72, 2);
  });

  it('falls back to one unit when the deed states no area', async () => {
    const { areaValue: _areaValue, areaUnit: _areaUnit, ...withoutArea } = PURCHASE;
    expectOk(await PropertyUC.record(withoutArea));

    const lot = (await propertyAsset())?.lots[0];
    expect(lot?.quantity).toBe('1');
    expect(lot?.costPerUnit.amount).toBe('9500000');
  });
});

describe('Scenario: A sale can be recorded', () => {
  it('records a disposal against the property', async () => {
    expectOk(await PropertyUC.record(PURCHASE));
    expectOk(
      await PropertyUC.record({
        side: 'SELL',
        transactionDate: '2026-05-20',
        propertyName: 'Whitefield flat',
        kind: 'FLAT',
        areaValue: '1450',
        areaUnit: 'SQ_FT',
        consideration: '1,45,00,000',
        brokerage: '2,00,000',
      }),
    );

    const exits = await LedgerUC.exits();
    expect(exits).toHaveLength(1);
    expect(exits[0]?.exitDate).toBe('2026-05-20');
    expect(exits[0]?.property?.consideration.amount).toBe('14500000');
  });

  it('leaves nothing held once the whole property is sold', async () => {
    expectOk(await PropertyUC.record(PURCHASE));
    expectOk(
      await PropertyUC.record({
        side: 'SELL',
        transactionDate: '2026-05-20',
        propertyName: 'Whitefield flat',
        kind: 'FLAT',
        areaValue: '1450',
        areaUnit: 'SQ_FT',
        consideration: '1,45,00,000',
      }),
    );

    expect(Number((await propertyAsset())?.heldQuantity)).toBe(0);
  });
});

describe('Scenario: A current value is kept but never counted', () => {
  it('stores the value with the basis and date that qualify it', async () => {
    expectOk(
      await PropertyUC.record({
        ...PURCHASE,
        currentValue: { amount: '1,40,00,000', asOf: '2026-09-01', basis: 'CIRCLE_RATE' },
      }),
    );

    const value = (await propertyAsset())?.property?.currentValue;
    expect(value?.amount.amount).toBe('14000000');
    expect(value?.asOf).toBe('2026-09-01');
    expect(value?.basis).toBe('CIRCLE_RATE');
  });

  /*
   * The point of the whole optional field. Schedule AL asks for cost, and
   * `ValuationEngine` carries property at cost; a figure the user recorded for
   * their own reference must not quietly become net worth.
   */
  it('does not let it reach net worth, which stays at cost', async () => {
    expectOk(
      await PropertyUC.record({
        ...PURCHASE,
        currentValue: { amount: '1,40,00,000', asOf: '2026-09-01', basis: 'CIRCLE_RATE' },
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute('2026-09-15T10:00:00+05:30'));
    expect(Number(valuation.netWorth.amount)).toBeCloseTo(10_204_500, 0);
  });

  it('refuses a value with no date, because that is not a valuation', async () => {
    expectErr(
      await PropertyUC.record({
        ...PURCHASE,
        currentValue: { amount: '1,40,00,000', asOf: '', basis: 'CIRCLE_RATE' },
      }),
      'VAULT_STATE',
    );
  });
});

describe('Scenario: Figures that do not agree are reported, not corrected', () => {
  /*
   * A deed states area, rate and price, and they can disagree. Which one is
   * wrong is not knowable here, and recomputing the price would change a cost
   * basis on a guess.
   */
  it('flags a consideration that does not match area × rate', async () => {
    const result = expectOk(
      await PropertyUC.record({
        ...PURCHASE,
        pricePerAreaUnit: '10,000', // 1450 × 10,000 = 1,45,00,000, not 95,00,000
      }),
    );

    expect(result.advisories.map((advisory) => advisory.code)).toContain(
      'CONSIDERATION_MISMATCH',
    );
    // The STATED figure is what was stored.
    expect((await propertyAsset())?.lots[0]?.property?.consideration.amount).toBe('9500000');
  });

  /** s.50C on a sale, s.56(2)(x) on a purchase. Invisible without the number. */
  it('flags a stamp duty value above the price paid', async () => {
    const result = expectOk(
      await PropertyUC.record({ ...PURCHASE, stampDutyValue: '1,05,00,000' }),
    );

    const shortfall = result.advisories.find(
      (advisory) => advisory.code === 'STAMP_DUTY_SHORTFALL',
    );
    expect(shortfall).toBeDefined();
    expect(shortfall?.message).toContain('1000000');
  });

  it('says nothing when the stamp duty value is at or below the price', async () => {
    const result = expectOk(
      await PropertyUC.record({ ...PURCHASE, stampDutyValue: '90,00,000' }),
    );

    expect(result.advisories).toHaveLength(0);
  });
});

describe('Scenario: Input that would corrupt the register is refused', () => {
  it('refuses an area with no unit', async () => {
    const { areaUnit: _areaUnit, ...noUnit } = PURCHASE;
    expectErr(await PropertyUC.record(noUnit), 'VAULT_STATE');
  });

  it('refuses a property with no name', async () => {
    expectErr(await PropertyUC.record({ ...PURCHASE, propertyName: '  ' }), 'VAULT_STATE');
  });

  it('refuses a consideration of zero', async () => {
    expectErr(await PropertyUC.record({ ...PURCHASE, consideration: '0' }), 'VAULT_STATE');
  });

  it('refuses a date that is not ISO', async () => {
    expectErr(
      await PropertyUC.record({ ...PURCHASE, transactionDate: '10-06-2024' }),
      'VAULT_STATE',
    );
  });

  /** The same entry typed twice, which has no order id to tell it apart. */
  it('refuses a duplicate until it is confirmed', async () => {
    expectOk(await PropertyUC.record(PURCHASE));
    expectErr(await PropertyUC.record(PURCHASE), 'DUPLICATE_TRADE');

    expectOk(await PropertyUC.record({ ...PURCHASE, confirmDuplicate: true }));
    expect((await propertyAsset())?.lots.length).toBeGreaterThan(1);
  });

  it('is gated behind edit mode, like every other figure-changing write', async () => {
    EditModeUC.disable();
    expectErr(await PropertyUC.record(PURCHASE), 'EDIT_MODE_REQUIRED');
  });
});
