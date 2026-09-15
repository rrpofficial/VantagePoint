/**
 * Stable identities for equity-compensation lots and the disposals against them.
 *
 * The problem these solve: a single vest is described by more than one broker
 * export. A Gains & Losses file shows the part that was SOLD; a holdings file
 * shows the part still HELD. Both describe the same tranche of the same grant,
 * and unless they produce the same identifier the ledger cannot tell that — it
 * falls back to matching quantity and price, which differ between the two files
 * by rounding and by construction (a G&L row states only the quantity disposed).
 *
 * So identity is derived from what the GRANT says, never from the file:
 *
 *   grant   →  lot (grant + acquisition date)  →  disposal (order + lot)
 *
 * Every id is a pure function of that data, so the same tranche read from any
 * source, in any order, on any day, resolves to the same lot.
 *
 * ## Why the acquisition date is the tranche discriminator
 *
 * For an RSU it is the vest date: one grant vests in tranches, and each tranche
 * has its own fair market value and its own holding period.
 *
 * For an ESPP it is the purchase date, and this is the case worth stating,
 * because ESPP rows carry no grant number at all — the offering's grant date is
 * the only grant-level identifier available. One offering commonly has several
 * purchase dates (semi-annual buys inside a 24-month offering), so grant date
 * alone would collapse them into one lot. Grant date plus purchase date does not.
 *
 * Quantity is deliberately NOT part of any key. It is not stable: a G&L row
 * carries only the units disposed of, the holdings file only the units retained,
 * and a partially sold lot shrinks over time. Keying on it would give one
 * tranche a different identity in every file that mentions it.
 */
import { createHash } from 'node:crypto';
import type { IsoDate, Quantity } from '@vantagepoint/shared-kernel';
import type { EquityAward } from './types.js';

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Short, stable, and opaque — a grant number is not something to put in a payload. */
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/**
 * The grant's reference, as the ledger stores it.
 *
 * A broker-issued grant number is used as-is once slugged. Where there is none —
 * every ESPP row — the offering's grant date stands in, prefixed so the two can
 * never be confused with each other.
 */
export function grantRefOf(input: {
  readonly grantNumber?: string;
  readonly grantDate?: IsoDate;
}): string | undefined {
  const number = input.grantNumber?.trim();
  if (number !== undefined && number.length > 0 && number !== '--') {
    return `grant_${slug(number)}`;
  }
  const date = input.grantDate?.trim();
  if (date !== undefined && date.length > 0) return `offer_${slug(date)}`;
  return undefined;
}

/**
 * The tranche this lot belongs to: one grant, one vest or purchase date.
 *
 * Hashed rather than concatenated so a grant number never travels in a lot id,
 * which appears in exports and in the AI payload path (FR-7.2).
 */
export function equityLotId(award: EquityAward, acquisitionDate: IsoDate): string {
  const tranche = award.vestDate ?? award.purchaseDate ?? acquisitionDate;
  return `lot_${slug(award.kind)}_${digest(`${award.grantRef}|${tranche}`)}`;
}

/**
 * A disposal's identity: the order, and the tranche it came out of.
 *
 * Both halves are needed. One order routinely consumes several tranches — in a
 * real export, 11 orders covered 33 disposal rows — so the order number alone
 * would collapse them; the tranche alone would collapse a sell-to-cover and a
 * later manual sale of the same vest into one.
 */
export function equityExitId(input: {
  readonly orderRef?: string;
  readonly lotId: string;
  readonly exitDate: IsoDate;
  /**
   * Required, and the reason is not obvious.
   *
   * One order against one tranche on one day can still be reported as SEVERAL
   * rows — brokers split a fill where a wash-sale adjustment applies to part of
   * it, giving pairs like 5.002 and 0.998. Without the quantity those rows share
   * an identity, the second is discarded as an already-seen disposal, and its
   * units are never taken off the holding. In real data that silently left six
   * tranches overstated.
   *
   * Two rows identical in order, tranche, date AND quantity remain
   * indistinguishable — but so are they to every other reading, and the
   * duplicate detector treats them as one for the same reason.
   */
  readonly quantity: Quantity;
}): string | undefined {
  const order = input.orderRef?.trim();
  if (order === undefined || order.length === 0 || order === '--') return undefined;
  return `exit_${digest(`${slug(order)}|${input.lotId}|${input.exitDate}|${input.quantity}`)}`;
}

/**
 * Whether a disposal was the block sold on vest day to fund withholding.
 *
 * Read from the broker's own order type rather than inferred from the dates.
 * A same-day sale is not necessarily a sell-to-cover — someone can simply sell
 * on vest day — and treating one as the other would silently drop a real
 * disposal from the gain when the exclusion setting is on.
 */
export function isSellToCover(orderType: string | undefined): boolean {
  const value = (orderType ?? '').trim().toUpperCase();
  // E*TRADE writes `RS STC`. Matched on the token so `RS STC SHARES` also reads.
  return /\bSTC\b/.test(value) || value.includes('SELL TO COVER');
}
