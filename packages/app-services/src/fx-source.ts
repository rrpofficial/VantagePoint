/**
 * The FX rate source that portfolio valuation reads through.
 *
 * `ValuationInput.fx` is the twin of `ValuationInput.prices`, and it had the
 * same defect: the port was declared in `core-domain` from the first commit and
 * nothing in the application ever supplied it. The only implementation anywhere
 * was a test fixture, so every functional test converted currency correctly and
 * the shipped application could not convert at all.
 *
 * `prices` failed open — an absent quote falls back to cost basis, which is
 * wrong but quiet. `fx` fails CLOSED: `toInr` throws rather than invent a rate.
 * That is the right instinct and it is why a single USD holding took the whole
 * dashboard down, rupee assets included.
 *
 * ## Which rate this is
 *
 * The VALUATION rate, not the tax rate (ADR-003). A foreign transaction produces
 * two rupee amounts from two different rates:
 *
 *   valuation — the ITBR on the date being valued, for portfolio display;
 *   tax       — the Rule 115 rate, last day of the PRECEDING month.
 *
 * `FallbackChain.resolve` is the resolver for the first. Nothing here may reach
 * for `rule115Rate`: collapsing the two satisfies the display requirement while
 * silently changing every taxable figure.
 */
import { FallbackChain } from '@vantagepoint/fx-itbr';
import type { FxSource } from '@vantagepoint/core-domain';
import type { Currency, IsoDate, Rate } from '@vantagepoint/shared-kernel';

/**
 * Reads through whatever rate store is installed — the vault once unlocked, an
 * empty in-memory store before that (see `vault-rate-store.ts`). A locked vault
 * therefore yields `undefined` rather than throwing from inside pure valuation
 * code, which is what lets the dashboard render at all before unlock.
 *
 * The resolver already walks back over bank holidays and through the
 * SBI → RBI → ECB → OANDA priority order mandated by FR-2.1, so a Sunday
 * valuation resolves to Friday's rate instead of failing. Returning `undefined`
 * here means no source published anything in the 40 days before the date — a
 * real gap, and the caller's refusal to guess is correct.
 */
export const vaultFxSource: FxSource = {
  rateFor(currency: Currency, asOf: IsoDate): Rate | undefined {
    const resolved = FallbackChain.resolve(currency, asOf);
    return resolved.ok ? resolved.value.rate : undefined;
  },
};
