/**
 * Application context — the wiring that use cases share.
 *
 * Domain packages are pure and take their dependencies as ports; this is where
 * the real ones are assembled. Keeping assembly in one place is what lets a
 * functional test swap the price feed or the clock without a mock framework, and
 * what keeps every use case free of hidden global state except this.
 */
import { Money, type Clock } from '@vantagepoint/shared-kernel';
import { liabilityOf, type Asset, type FxSource, type Liability, type PriceSource } from '@vantagepoint/core-domain';
import {
  AssetRepository,
  BorrowedLoanRepository,
  LiabilityRepository,
  vaultPriceSource,
} from '@vantagepoint/persistence';
import { createLogger, type Logger } from '@vantagepoint/platform';
import { vaultFxSource } from './fx-source.js';

export interface AppContext {
  readonly dataDir: string;
  readonly unlocked: boolean;
}

/**
 * Holdings may resolve synchronously (a test fixture) or asynchronously (the
 * vault). Both are awaited at the call site, so a suite can keep wiring a plain
 * array while production reads from SQLite.
 */
export type AssetSource = () => readonly Asset[] | Promise<readonly Asset[]>;
export type LiabilitySource = () => readonly Liability[] | Promise<readonly Liability[]>;

export interface Ports {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly assets: AssetSource;
  readonly liabilities: LiabilitySource;
  readonly prices?: PriceSource;
  readonly fx?: FxSource;
}

const systemClock: Clock = {
  // The only wall-clock read in the application. Everything downstream receives
  // an explicit instant, so snapshots and tax computations stay reproducible.
  now: () => new Date().toISOString().replace('Z', '+00:00'),
  today: () => new Date().toISOString().slice(0, 10),
};

const NO_SINK = { write: () => undefined };

/**
 * The vault is the default source of holdings. It previously defaulted to an
 * empty array, which meant the shipped application valued a portfolio it never
 * read — the dashboard reported ₹0 no matter what had been imported, and every
 * test passed because each one supplied its own fixture.
 *
 * A locked vault yields an empty ledger rather than an error, so this is safe to
 * call before unlock.
 */
function vaultBackedPorts(): Ports {
  return {
    clock: systemClock,
    logger: createLogger({ sink: NO_SINK, now: () => systemClock.now() }),
    assets: () => AssetRepository.all(),
    /*
     * Borrowings projected to `Liability` at TODAY's date, plus any legacy rows
     * still in the old table (Phase 3).
     *
     * `valuation.ts` and `al-items.ts` read five fields and know nothing about
     * EMIs; `liabilityOf` supplies exactly those five with the balance reduced
     * by every payment made. Before this, a liability carried a principal figure
     * that never moved — so six months of EMIs left net worth unchanged, and
     * there was no way to create a row in the first place.
     */
    liabilities: async () => {
      const [legacy, borrowed] = await Promise.all([
        LiabilityRepository.all(),
        BorrowedLoanRepository.all(),
      ]);
      const today = systemClock.today();
      const projected = borrowed
        .filter((loan) => loan.status === 'ACTIVE')
        .map((loan) => liabilityOf(loan, today));

      // A migrated row exists in BOTH tables — the same id. The borrowing is
      // authoritative, because it is the one that can be updated.
      const ids = new Set(projected.map((liability) => liability.liabilityId));
      return [...projected, ...legacy.filter((row) => !ids.has(row.liabilityId))];
    },
    /*
     * Wired at last. This port existed from the start and nothing ever supplied
     * it, so `marketValueOf` looked for a quote, found none, and fell back to
     * cost basis — for every holding, everywhere. Three screens then labelled
     * that cost "value" and "net worth".
     *
     * A locked vault returns no quote rather than throwing, so this is safe to
     * call before unlock; valuation then carries everything at cost, which is
     * what it did before and is still the correct answer for an unpriced asset.
     */
    prices: vaultPriceSource,
    /*
     * Also wired at last, and its absence was louder than the price port's. An
     * unsupplied `prices` falls back to cost; an unsupplied `fx` THROWS, because
     * valuation refuses to invent an exchange rate. That throw escaped the use
     * case as an exception rather than a Result, so one USD holding returned a
     * 500 for the whole portfolio and the dashboard sat on "Loading your
     * portfolio…" indefinitely — with the rupee assets valued perfectly well and
     * never shown.
     */
    fx: vaultFxSource,
  };
}

let ports: Ports = vaultBackedPorts();

export function configure(overrides: Partial<Ports>): void {
  ports = { ...ports, ...overrides };
}

export function currentPorts(): Ports {
  return ports;
}

/** Test seam: restores the default wiring between scenarios. */
export function resetPorts(): void {
  ports = vaultBackedPorts();
}

export const ZERO_INR = Money.zero('INR');
