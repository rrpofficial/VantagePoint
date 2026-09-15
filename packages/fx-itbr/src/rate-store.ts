/**
 * FX rate store with provenance (US-2.1, PRD FR-2.1).
 *
 * Rates are write-once per (currency, date, source). A silent overwrite would let a
 * corrected rate sheet retroactively change a frozen snapshot's value with no trace,
 * so a differing value for an existing key is an error, not an update — corrections
 * go through the amendment path (US-2.6) instead.
 */
import { Err, Ok, RateConflictError, type Currency, type IsoDate, type Result } from '@vantagepoint/shared-kernel';
import type { RateSource } from '@vantagepoint/core-domain';
import type { RateRecord } from './types.js';

const keyOf = (currency: Currency, date: IsoDate, source: RateSource) =>
  `${currency}|${date}|${source}`;

export class InMemoryRateStore {
  private readonly records = new Map<string, RateRecord>();

  put(record: RateRecord): Result<void> {
    const key = keyOf(record.currency, record.date, record.source);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.rate === record.rate) return Ok(undefined); // idempotent
      return Err(
        new RateConflictError(
          `conflicting ${record.currency} rate for ${record.date} from ${record.source}: ` +
            `stored ${existing.rate}, received ${record.rate}`,
        ),
      );
    }
    this.records.set(key, record);
    return Ok(undefined);
  }

  get(currency: Currency, date: IsoDate, source: RateSource): RateRecord | undefined {
    return this.records.get(keyOf(currency, date, source));
  }

  /** Most recent record on or before `date`, walking back over non-publishing days. */
  latestOnOrBefore(
    currency: Currency,
    date: IsoDate,
    source: RateSource,
  ): RateRecord | undefined {
    let best: RateRecord | undefined;
    for (const record of this.records.values()) {
      if (record.currency !== currency || record.source !== source) continue;
      if (record.date > date) continue;
      if (best === undefined || record.date > best.date) best = record;
    }
    return best;
  }

  clear(): void {
    this.records.clear();
  }

  size(): number {
    return this.records.size;
  }
}

/**
 * What a rate store must do, so the vault can back one without this package
 * ever importing persistence.
 *
 * SYNCHRONOUS on purpose. Resolution sits inside `DualRateConverter.convert`,
 * which pure valuation and capital-gains code calls per position and per
 * disposal; an async port would make all three packages async for what is a
 * primary-key read against a local file.
 */
export interface RateStorePort {
  put(record: RateRecord): Result<void>;
  get(currency: Currency, date: IsoDate, source: RateSource): RateRecord | undefined;
  latestOnOrBefore(currency: Currency, date: IsoDate, source: RateSource): RateRecord | undefined;
  clear(): void;
}

/**
 * Defaults to memory so this package stays usable — and testable — with no vault
 * open at all. Production swaps in the vault-backed implementation at startup;
 * see `useRateStore`.
 */
let active: RateStorePort = new InMemoryRateStore();

/** Installs the backing store. Called once, during application wiring. */
export function useRateStore(store: RateStorePort): void {
  active = store;
}

/** Test seam: restores the in-memory default between scenarios. */
export function resetRateStore(): void {
  active = new InMemoryRateStore();
}

/**
 * Process-wide façade. A stable binding that forwards to whatever is installed,
 * so `resolvers.ts` and every caller keep importing one thing and none of them
 * need to know whether rates are in memory or in the vault.
 */
export const rateStore: RateStorePort = {
  put: (record) => active.put(record),
  get: (currency, date, source) => active.get(currency, date, source),
  latestOnOrBefore: (currency, date, source) => active.latestOnOrBefore(currency, date, source),
  clear: () => {
    active.clear();
  },
};
