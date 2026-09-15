/**
 * Duplicate detection (US-4.7).
 *
 * The natural key is the transaction's identity — instrument, date, side,
 * quantity, price — deliberately EXCLUDING provenance. Overlapping date-range
 * exports are the normal case (a user downloads Apr–Sep, then Jul–Dec), and the
 * same trade appearing at a different row of a different file is still the same
 * trade. Keying on file or row would duplicate every overlapping period.
 */
import { equityLotId } from '@porttrack/core-domain';
import type { ParsedTransaction } from './types.js';

export function naturalKey(txn: ParsedTransaction): string {
  return [
    txn.kind,
    txn.date,
    txn.isin ?? txn.symbol ?? txn.schemeName ?? txn.folioRef ?? '',
    txn.quantity,
    txn.pricePerUnit.amount,
    txn.pricePerUnit.currency,
    /*
     * The TRANCHE, for equity compensation — and it is not optional detail.
     *
     * One stock-plan order routinely sells equal quantities out of several
     * different vests, at one execution price, on one day. Every field above is
     * then identical across those rows and they collapse into a single
     * "duplicate", even though they are separate disposals of lots with
     * different cost bases and different holding periods.
     *
     * In real data one order sold 6 units from a Sep-2020 vest and 6 from a
     * Dec-2020 vest on the same day: the second vanished, and 29 units stayed on
     * the books as holdings that had in fact been sold.
     */
    txn.equityAward === undefined
      ? ''
      : equityLotId(txn.equityAward, txn.date),
  ].join('|');
}

/**
 * The same identity WITHOUT the tranche.
 *
 * Needed because not every source names one. A broker's transaction history
 * records an RSU release with no grant number at all, so a holding that arrived
 * that way carries no tranche — and a Gains & Losses row describing the very same
 * vest would not match it, leaving the ledger with two copies of one lot.
 */
function looseKey(txn: ParsedTransaction): string {
  const full = naturalKey(txn);
  // The separator is KEPT: a record with no tranche ends in an empty final
  // field, so the shapes must line up exactly — `…|USD|`, not `…|USD`.
  return full.slice(0, full.lastIndexOf('|') + 1);
}

export function partition(
  incoming: readonly ParsedTransaction[],
  existingKeys: readonly string[],
): { fresh: readonly ParsedTransaction[]; duplicates: readonly ParsedTransaction[] } {
  /*
   * Two sets, and the distinction is what makes both cases work.
   *
   * Against what the ledger ALREADY holds, a match without the tranche counts:
   * the stored record may have come from a source that never named one, and
   * re-recording the same vest would double the holding.
   *
   * Within the file being imported, only a full match counts. One stock-plan
   * order sells equal quantities out of several vests at one price on one day,
   * and those rows are identical apart from the tranche — treating them as
   * duplicates of each other loses every disposal after the first.
   */
  const onLedger = new Set(existingKeys);
  const seenInFile = new Set<string>();
  const fresh: ParsedTransaction[] = [];
  const duplicates: ParsedTransaction[] = [];

  for (const txn of incoming) {
    const key = naturalKey(txn);
    if (onLedger.has(key) || onLedger.has(looseKey(txn)) || seenInFile.has(key)) {
      duplicates.push(txn);
      continue;
    }
    seenInFile.add(key);
    fresh.push(txn);
  }
  return { fresh, duplicates };
}
