/**
 * US-4.5c — grant → tranche → disposal identity.
 *
 * The property under test is STABILITY ACROSS SOURCES. A single vest is
 * described by more than one broker export — a Gains & Losses file lists the
 * part that was sold, a holdings file the part still held — and unless both
 * produce the same lot id the ledger records one tranche as two, doubling a
 * holding and halving the gain when it is eventually sold.
 *
 * Which is why none of these ids may depend on quantity, price, file name or row
 * number: every one of those differs between the two files describing the same
 * vest.
 */
import { describe, it, expect } from 'vitest';
import {
  equityExitId,
  equityLotId,
  grantRefOf,
  isSellToCover,
  type EquityAward,
} from '@porttrack/core-domain';

const rsu = (overrides: Partial<EquityAward> = {}): EquityAward => ({
  kind: 'RSU',
  grantRef: 'grant_00085961',
  grantDate: '2019-03-22',
  vestDate: '2021-02-10',
  ...overrides,
});

describe('US-4.5c Scenario: The grant reference', () => {
  it('uses the broker’s own grant number when there is one', () => {
    expect(grantRefOf({ grantNumber: '00085961' })).toBe('grant_00085961');
  });

  /*
   * Every ESPP row. E*TRADE issues no grant number for them, so the offering's
   * grant date is the only grant-level identifier the file carries.
   */
  it('falls back to the offering date when there is no grant number', () => {
    expect(grantRefOf({ grantDate: '2025-12-16' })).toBe('offer_2025_12_16');
  });

  /** Prefixed differently so a grant and an offering can never collide. */
  it('never produces the same reference for a grant and an offering', () => {
    expect(grantRefOf({ grantNumber: '2025-12-16' })).not.toBe(
      grantRefOf({ grantDate: '2025-12-16' }),
    );
  });

  it('treats E*TRADE’s "--" placeholder as absent', () => {
    expect(grantRefOf({ grantNumber: '--', grantDate: '2025-12-16' })).toBe('offer_2025_12_16');
  });

  it('has no reference at all when neither is present', () => {
    expect(grantRefOf({})).toBeUndefined();
  });
});

describe('US-4.5c Scenario: A tranche is identified by grant and acquisition date', () => {
  it('gives one vest the same id however it is described', () => {
    // As a G&L row would: 20 units sold. As a holdings row would: 80 retained.
    const fromGainsLosses = equityLotId(rsu(), '2021-02-10');
    const fromHoldings = equityLotId(rsu(), '2021-02-10');

    expect(fromGainsLosses).toBe(fromHoldings);
  });

  it('separates two tranches of one grant', () => {
    expect(equityLotId(rsu({ vestDate: '2021-02-10' }), '2021-02-10')).not.toBe(
      equityLotId(rsu({ vestDate: '2022-02-10' }), '2022-02-10'),
    );
  });

  it('separates the same vest date under two different grants', () => {
    expect(equityLotId(rsu({ grantRef: 'grant_a' }), '2021-02-10')).not.toBe(
      equityLotId(rsu({ grantRef: 'grant_b' }), '2021-02-10'),
    );
  });

  /*
   * The ESPP case the user asked about: two purchases under ONE offering. The
   * grant date is identical for both, so grant date alone would merge them.
   */
  it('separates two purchase dates inside one ESPP offering', () => {
    const offering = { kind: 'ESPP', grantRef: 'offer_2025_12_16' } as const;

    expect(equityLotId({ ...offering, purchaseDate: '2026-06-15' }, '2026-06-15')).not.toBe(
      equityLotId({ ...offering, purchaseDate: '2026-12-15' }, '2026-12-15'),
    );
  });

  /*
   * Quantity is NOT an identifier. A G&L row states only the units disposed of
   * and a holdings row only the units retained, so keying on it would give one
   * tranche a different identity in every file that mentions it — the precise
   * bug this module exists to remove.
   */
  it('does not vary with quantity or price', () => {
    const award = rsu();
    // Same grant, same vest, nothing else in the key.
    expect(equityLotId(award, '2021-02-10')).toBe(equityLotId(award, '2021-02-10'));
  });

  /** A grant number must not travel inside an id that reaches an export (FR-7.2). */
  it('does not embed the grant number in clear text', () => {
    expect(equityLotId(rsu(), '2021-02-10')).not.toContain('00085961');
  });
});

describe('US-4.5c Scenario: A disposal is identified by order AND tranche', () => {
  const lotId = equityLotId(rsu(), '2021-02-10');

  /*
   * One tranche is routinely sold twice — a sell-to-cover on vest day and a
   * manual sale later. Sharing an id means the second is discarded as already
   * seen, and its proceeds vanish from the gain.
   */
  it('separates two sales of one tranche', () => {
    expect(
      equityExitId({ orderRef: '900001', lotId, exitDate: '2021-02-10', quantity: '10' }),
    ).not.toBe(
      equityExitId({ orderRef: '900002', lotId, exitDate: '2026-05-20', quantity: '10' }),
    );
  });

  /** One order spans several tranches — 11 orders covered 33 rows in a real file. */
  it('separates two tranches sold under one order', () => {
    const other = equityLotId(rsu({ vestDate: '2022-02-10' }), '2022-02-10');

    expect(
      equityExitId({ orderRef: '900001', lotId, exitDate: '2026-05-20', quantity: '10' }),
    ).not.toBe(
      equityExitId({ orderRef: '900001', lotId: other, exitDate: '2026-05-20', quantity: '10' }),
    );
  });

  /*
   * The split fill, and the reason quantity is in the key.
   *
   * A broker reports one order against one tranche on one day as SEVERAL rows
   * where a wash-sale adjustment applies to part of it — real pairs from an
   * E*TRADE export are 5.002/0.998 and 4.998/1.002. Sharing an identity, the
   * second row is discarded as an already-seen disposal and its units are never
   * taken off the holding. That left six tranches overstated in real data.
   */
  it('separates a split fill of one order against one tranche on one day', () => {
    expect(
      equityExitId({ orderRef: '76324960', lotId, exitDate: '2023-09-25', quantity: '5.002' }),
    ).not.toBe(
      equityExitId({ orderRef: '76324960', lotId, exitDate: '2023-09-25', quantity: '0.998' }),
    );
  });

  it('is stable for the same order, tranche and quantity', () => {
    expect(
      equityExitId({ orderRef: '900001', lotId, exitDate: '2026-05-20', quantity: '10' }),
    ).toBe(equityExitId({ orderRef: '900001', lotId, exitDate: '2026-05-20', quantity: '10' }));
  });

  /** No order number means no stable id; the caller falls back to provenance. */
  it('declines to invent one when the source states no order', () => {
    expect(equityExitId({ lotId, exitDate: '2026-05-20', quantity: '10' })).toBeUndefined();
    expect(
      equityExitId({ orderRef: '--', lotId, exitDate: '2026-05-20', quantity: '10' }),
    ).toBeUndefined();
  });
});

describe('US-4.5c Scenario: Recognising a sell-to-cover', () => {
  it('reads E*TRADE’s own order type', () => {
    expect(isSellToCover('RS STC')).toBe(true);
    expect(isSellToCover('Sell to Cover')).toBe(true);
  });

  it('does not treat an ordinary sale as one', () => {
    expect(isSellToCover('Sell Restricted Stock')).toBe(false);
    expect(isSellToCover('Sell ESPP')).toBe(false);
    expect(isSellToCover(undefined)).toBe(false);
  });

  /*
   * Read from the order type, never inferred from the dates. Someone can simply
   * choose to sell on vest day, and classifying that as a sell-to-cover would
   * drop a real disposal once the exclusion is switched on.
   */
  it('matches STC as a token, so "RSTC" in a symbol does not qualify', () => {
    expect(isSellToCover('RSTCORP')).toBe(false);
  });
});
