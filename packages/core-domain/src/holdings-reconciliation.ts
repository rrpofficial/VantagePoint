/**
 * What the broker says you hold, against what the ledger can account for.
 *
 * The answer to the question a portfolio import cannot otherwise settle: *is my
 * history complete?*
 *
 * A holdings export states what remains of each tranche today. The ledger
 * derives the same figure by taking each tranche at its original size and
 * applying the disposals it knows about. When the two differ, disposals exist
 * that were never imported — a sale from a year whose statement was not loaded,
 * or one made outside the plan account entirely.
 *
 * **Nothing else surfaces this.** Every figure derived from an incomplete ledger
 * is internally consistent: the positions add up, the gains reconcile against
 * the trades on record, and the whole picture is wrong by exactly the history
 * that is missing. Only an independent statement of what is held can reveal it,
 * which is why the broker's own claim is stored rather than merged away.
 *
 * Pure: takes assets, returns a report. It decides nothing and corrects nothing —
 * a disagreement is shown to the person who knows which side is right.
 */
import { Decimal } from 'decimal.js';
import type { Asset } from './types.js';

export interface TrancheDiscrepancy {
  readonly assetId: string;
  readonly lotId: string;
  readonly symbol?: string;
  readonly acquisitionDate: string;
  /** The grant this tranche came from, where it is equity compensation. */
  readonly grantRef?: string;
  /** What the broker says is left. */
  readonly stated: string;
  /** What the ledger works out from the disposals it holds. */
  readonly computed: string;
  /** `computed − stated`. Positive means the ledger is missing disposals. */
  readonly difference: string;
}

export interface HoldingsReconciliation {
  /** Tranches whose stated and computed remainders disagree. */
  readonly discrepancies: readonly TrancheDiscrepancy[];
  /** Tranches the broker has stated a figure for, and which agree. */
  readonly agreed: number;
  /**
   * Units the ledger holds that the broker does not — almost always disposals
   * that were never imported. Positive means the portfolio is OVERSTATED.
   */
  readonly unaccountedUnits: string;
  /**
   * True when no holdings export has ever been loaded, so there is nothing to
   * reconcile against. Distinct from "everything agrees", which is the answer
   * that matters and which this is NOT.
   */
  readonly noStatementLoaded: boolean;
}

export function reconcileHoldings(
  assets: readonly Asset[],
): HoldingsReconciliation {
  const discrepancies: TrancheDiscrepancy[] = [];
  let agreed = 0;
  let unaccounted = new Decimal(0);
  let anyStated = false;

  for (const asset of assets) {
    for (const lot of asset.lots) {
      if (lot.statedRemainingQuantity === undefined) continue;
      anyStated = true;

      const computed = new Decimal(lot.remainingQuantity);
      const stated = new Decimal(lot.statedRemainingQuantity);
      if (computed.equals(stated)) {
        agreed++;
        continue;
      }

      const difference = computed.minus(stated);
      unaccounted = unaccounted.plus(difference);
      discrepancies.push({
        assetId: asset.assetId,
        lotId: lot.lotId,
        ...(asset.symbol === undefined ? {} : { symbol: asset.symbol }),
        acquisitionDate: lot.acquisitionDate,
        ...(lot.equityAward?.grantRef === undefined
          ? {}
          : { grantRef: lot.equityAward.grantRef }),
        stated: stated.toFixed(),
        computed: computed.toFixed(),
        difference: difference.toFixed(),
      });
    }
  }

  // Oldest first: the missing history is usually the earliest, and that is where
  // a user starts looking.
  discrepancies.sort((a, b) => a.acquisitionDate.localeCompare(b.acquisitionDate));

  return {
    discrepancies,
    agreed,
    unaccountedUnits: unaccounted.toFixed(),
    noStatementLoaded: !anyStated,
  };
}
