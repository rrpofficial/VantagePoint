/**
 * The vault-backed FX rate store.
 *
 * `fx-itbr` is pure and must not import persistence; `persistence` must not
 * import a domain package. This is the seam between them, and it lives here for
 * the same reason every other piece of wiring does — composition is this layer's
 * job (see `context.ts`).
 *
 * Installed once at unlock and torn down at lock, so a locked vault falls back to
 * an empty in-memory store rather than throwing from inside pure valuation code.
 */
import { resetRateStore, useRateStore, type RateRecord, type RateStorePort } from '@vantagepoint/fx-itbr';
import { RateRepository, type StoredRate } from '@vantagepoint/persistence';
import type { RateSource } from '@vantagepoint/core-domain';
import { VaultStateError, type Currency, type IsoDate, type Result } from '@vantagepoint/shared-kernel';

/*
 * The two record shapes are structurally identical and declared separately on
 * purpose — persistence owning a domain type, or fx-itbr owning a storage one,
 * is the dependency this file exists to avoid. These two functions are the whole
 * cost of that, and a round-trip test pins them together.
 */
const toStored = (record: RateRecord): StoredRate => ({
  currency: record.currency,
  date: record.date,
  rate: record.rate,
  source: record.source,
  rateType: record.rateType,
  retrievedAt: record.retrievedAt,
  sourceDocumentRef: record.sourceDocumentRef,
});

const toRecord = (stored: StoredRate): RateRecord => ({
  currency: stored.currency,
  date: stored.date,
  rate: stored.rate,
  source: stored.source as RateSource,
  rateType: stored.rateType,
  retrievedAt: stored.retrievedAt,
  sourceDocumentRef: stored.sourceDocumentRef,
});

export const vaultRateStore: RateStorePort = {
  put: (record: RateRecord): Result<void> => RateRepository.put(toStored(record)),

  get: (currency: Currency, date: IsoDate, source: RateSource): RateRecord | undefined => {
    const stored = RateRepository.get(currency, date, source);
    return stored === undefined ? undefined : toRecord(stored);
  },

  latestOnOrBefore: (
    currency: Currency,
    date: IsoDate,
    source: RateSource,
  ): RateRecord | undefined => {
    const stored = RateRepository.latestOnOrBefore(currency, date, source);
    return stored === undefined ? undefined : toRecord(stored);
  },

  /*
   * Refused outright. `clear` exists on the port for the in-memory store's test
   * seam; wiring it to a DELETE would make "reset the fixture" and "destroy every
   * rate a filed figure was computed from" the same call.
   */
  clear: (): void => {
    throw new VaultStateError('the vault rate store cannot be cleared; rates are write-once');
  },
};

/** Points rate resolution at the vault. Called once the vault is unlocked. */
export function useVaultRateStore(): void {
  useRateStore(vaultRateStore);
}

/** Back to memory. Called on lock, so a closed vault is never read through. */
export function useMemoryRateStore(): void {
  resetRateStore();
}
