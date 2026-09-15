/**
 * Market prices, and the lookup that turns them into a valuation.
 *
 * SYNCHRONOUS, like the rate repository and for the same reason: resolution sits
 * inside `valuation.value`, which is pure domain code called per position. An
 * async lookup there would make the whole valuation async and put a round trip
 * in a loop that runs once per holding (NFR-2).
 *
 * ## Where prices come from
 *
 * Not from a feed. The API container has no route to the internet (ADR-010), so
 * a price reaches this table only inside a statement the user imported. Each row
 * therefore records the document it came from and the date it was recorded, and
 * any figure derived from it can be traced back and dated on screen.
 *
 * ## Why "latest at or before"
 *
 * A price is valid until a newer one is recorded. Asking for today's value when
 * the last statement was imported in March should answer with March's price and
 * say so — not refuse, and certainly not silently use a price from the future.
 */
import { Money, Ok, VaultStateError, type Currency, type Result } from '@vantagepoint/shared-kernel';
import type { PriceQuote } from '@vantagepoint/core-domain';
import { Vault } from './vault.js';

export interface AssetPrice {
  /** ISIN or ticker, as the statement wrote it. Compared case-insensitively. */
  readonly instrument: string;
  readonly priceDate: string;
  readonly price: string;
  readonly currency: Currency;
  readonly source: string;
  /** The file this price was read out of, for audit. */
  readonly sourceDocument?: string;
}

interface PriceRow {
  readonly instrument: string;
  readonly price_date: string;
  readonly price: string;
  readonly currency: string;
  readonly source: string;
  readonly source_document: string | null;
}

/** Instruments are matched case- and whitespace-insensitively. */
const key = (instrument: string) => instrument.trim().toUpperCase();

export const PriceRepository = {
  /**
   * Records prices, newest-wins per (instrument, date, source).
   *
   * An overwrite is allowed here, unlike the FX rate store. A rate is a
   * published fact that must never change once a tax figure rests on it; a
   * market price is a running observation, and re-importing a corrected
   * statement should update it.
   */
  save(prices: readonly AssetPrice[]): Promise<Result<void>> {
    if (!Vault.isUnlocked()) {
      return Promise.resolve({ ok: false, error: new VaultStateError('vault is locked') });
    }
    const db = Vault.connection();
    const insert = db.prepare(
      `INSERT INTO asset_prices (instrument, price_date, source, price, currency, source_document)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(instrument, price_date, source) DO UPDATE SET
         price = excluded.price,
         currency = excluded.currency,
         source_document = excluded.source_document`,
    );

    db.transaction(() => {
      for (const price of prices) {
        insert.run(
          key(price.instrument),
          price.priceDate,
          price.source,
          price.price,
          price.currency,
          price.sourceDocument ?? null,
        );
      }
    })();
    return Promise.resolve(Ok(undefined));
  },

  /**
   * The most recent price for an instrument at or before `asOf`.
   *
   * `undefined` means no price is known, and the caller values at cost — which
   * is the honest answer for a flat or an unlisted holding, and must never be
   * confused with a price of zero.
   */
  latest(instrument: string, asOf: string): AssetPrice | undefined {
    if (!Vault.isUnlocked()) return undefined;
    const row = Vault.connection()
      .prepare(
        `SELECT * FROM asset_prices
         WHERE instrument = ? AND price_date <= ?
         ORDER BY price_date DESC LIMIT 1`,
      )
      .get(key(instrument), asOf) as PriceRow | undefined;

    if (row === undefined) return undefined;
    return {
      instrument: row.instrument,
      priceDate: row.price_date,
      price: row.price,
      currency: row.currency as Currency,
      source: row.source,
      ...(row.source_document === null ? {} : { sourceDocument: row.source_document }),
    };
  },

  all(): readonly AssetPrice[] {
    if (!Vault.isUnlocked()) return [];
    const rows = Vault.connection()
      .prepare('SELECT * FROM asset_prices ORDER BY instrument, price_date DESC')
      .all() as PriceRow[];
    return rows.map((row) => ({
      instrument: row.instrument,
      priceDate: row.price_date,
      price: row.price,
      currency: row.currency as Currency,
      source: row.source,
      ...(row.source_document === null ? {} : { sourceDocument: row.source_document }),
    }));
  },
};

/**
 * The domain's `PriceSource`, backed by the vault.
 *
 * Tries ISIN before ticker: an ISIN identifies a security globally, while a
 * ticker is only unique within an exchange.
 *
 * `LAST_PUBLISHED` rather than `PUBLISHED` whenever the price predates the date
 * asked for — which, with prices arriving by import, is almost always. The
 * distinction is what lets a screen say "as at 15 September" instead of
 * implying the figure is current.
 */
export const vaultPriceSource = {
  priceFor(query: {
    assetId: string;
    assetClass: string;
    asOf: string;
    isin?: string;
    symbol?: string;
  }): PriceQuote | undefined {
    for (const instrument of [query.isin, query.symbol]) {
      if (instrument === undefined || instrument.trim().length === 0) continue;
      const found = PriceRepository.latest(instrument, query.asOf);
      if (found === undefined) continue;

      return {
        price: Money.of(found.price, found.currency),
        source: found.priceDate === query.asOf ? 'PUBLISHED' : 'LAST_PUBLISHED',
      };
    }
    return undefined;
  },
};
