/**
 * adapters-fx — the only place that speaks HTTP for rate data. Every call goes
 * through the EgressGateway, which is default-deny (ADR-010).
 */
import { notImplemented, type Currency, type IsoDate, type Result } from '@vantagepoint/shared-kernel';
import type { RateRecord } from '@vantagepoint/fx-itbr';

export interface RateFetcher {
  fetchSheet(date: IsoDate): Promise<Result<string>>;
  toRecords(sheet: string, currencies: readonly Currency[]): Result<readonly RateRecord[]>;
}

export const SbiScraper: RateFetcher = {
  fetchSheet: () => notImplemented('US-2.2', 'SbiScraper.fetchSheet'),
  toRecords: () => notImplemented('US-2.2', 'SbiScraper.toRecords'),
};
export const RbiClient: RateFetcher = {
  fetchSheet: () => notImplemented('US-2.3', 'RbiClient.fetchSheet'),
  toRecords: () => notImplemented('US-2.3', 'RbiClient.toRecords'),
};
export const EcbClient: RateFetcher = {
  fetchSheet: () => notImplemented('US-2.3', 'EcbClient.fetchSheet'),
  toRecords: () => notImplemented('US-2.3', 'EcbClient.toRecords'),
};
