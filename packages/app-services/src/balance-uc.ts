/**
 * The balance register (Phase 5, objectives 1 and 4).
 *
 * Recording a balance is ADDITIVE and therefore ungated, exactly as recording a
 * trade, a loan payment or a property transaction is. Restating one is not: it
 * replaces a figure that every valuation between the two dates was computed
 * from, so it takes the same edit-mode gate every other change does.
 *
 * Closing is gated for the same reason — it drops the holding to nil from the
 * closing date, and a mistaken close looks exactly like an account that was
 * never opened.
 */
import {
  Err,
  Money,
  Ok,
  VaultStateError,
  type IsoDate,
  type Money as MoneyValue,
  type Result,
} from '@vantagepoint/shared-kernel';
import { balanceViewOf, type BalanceAccount, type BalanceView } from '@vantagepoint/core-domain';
import { AssetRepository, Vault } from '@vantagepoint/persistence';
import { currentPorts } from './context.js';
import { requireEditMode } from './edit-mode.js';
import {
  BALANCE_CLASSES,
  buildBalanceEntry,
  type BalanceClassOption,
  type RecordBalanceInput,
} from './balance-entry.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INR = 'INR' as const;

export interface BalanceTotals {
  readonly accountCount: number;
  readonly openCount: number;
  readonly totalValue: MoneyValue;
  readonly totalContributed: MoneyValue;
  readonly totalAccruedInterest: MoneyValue;
}

export interface BalanceRegister {
  readonly asOf: IsoDate;
  readonly accounts: readonly BalanceView[];
  readonly totals: BalanceTotals;
}

const requireUnlocked = (): Result<void> =>
  Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));

/** Every balance bag in the ledger, whatever asset class carries it. */
async function balanceAccounts(): Promise<readonly BalanceAccount[]> {
  const assets = await AssetRepository.all();
  return assets.flatMap((asset) => (asset.balanceAccount === undefined ? [] : [asset.balanceAccount]));
}

function totalsOf(views: readonly BalanceView[]): BalanceTotals {
  return {
    accountCount: views.length,
    openCount: views.filter((view) => !view.closed).length,
    totalValue: Money.sum(
      views.map((view) => view.value),
      INR,
    ),
    totalContributed: Money.sum(
      views.map((view) => view.contributed),
      INR,
    ),
    totalAccruedInterest: Money.sum(
      views.map((view) => view.accruedInterest),
      INR,
    ),
  };
}

export const BalanceUC = {
  classes: (): Promise<Result<readonly BalanceClassOption[]>> => Promise.resolve(Ok(BALANCE_CLASSES)),

  async register(asOf?: IsoDate): Promise<Result<BalanceRegister>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const date = asOf !== undefined && ISO_DATE.test(asOf) ? asOf : currentPorts().clock.today();
    const views = (await balanceAccounts())
      .map((account) => balanceViewOf(account, date))
      .sort((a, b) => a.account.label.localeCompare(b.account.label));

    return Ok({ asOf: date, accounts: views, totals: totalsOf(views) });
  },

  /**
   * Adds a balance, or replaces one whose identity matches.
   *
   * The id is derived from class, name, institution and opening date, so typing
   * the same deposit twice resolves to one account rather than two. Replacing an
   * EXISTING one is a change, so it takes the gate — otherwise the additive door
   * would be a way to rewrite any balance without turning edit mode on.
   */
  async record(input: RecordBalanceInput): Promise<Result<{ assetId: string; replaced: boolean }>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const built = buildBalanceEntry(input);
    if (!built.ok) return built;

    const existing = await AssetRepository.findById(built.value.assetId);
    if (existing !== undefined) {
      const gate = requireEditMode(`replacing the balance already recorded as "${input.label}"`);
      if (!gate.ok) return gate;
    }

    const saved = await AssetRepository.save(built.value);
    if (!saved.ok) return saved;

    currentPorts().logger.info('balance account recorded');
    return Ok({ assetId: built.value.assetId, replaced: existing !== undefined });
  },

  /**
   * Restates the balance, moving the accrual start with it.
   *
   * Both move together on purpose. A new figure with the old start date would
   * re-accrue interest that is already inside the new figure — the same
   * double-count the EPF guidance warns about, arrived at from the other side.
   */
  async restate(input: {
    assetId: string;
    openingBalance: string;
    asOf: IsoDate;
  }): Promise<Result<BalanceView>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    const gate = requireEditMode('restating a balance');
    if (!gate.ok) return gate;

    const asset = await AssetRepository.findById(input.assetId);
    const account = asset?.balanceAccount;
    if (asset === undefined || account === undefined) {
      return Err(new VaultStateError('no balance account with that id'));
    }
    if (!ISO_DATE.test(input.asOf)) {
      return Err(new VaultStateError('a restatement needs the date it is true as at, as YYYY-MM-DD'));
    }

    const amount = Money.parse(input.openingBalance, account.openingBalance.currency);
    if (!amount.ok) return amount;
    if (Money.compare(amount.value, Money.zero(amount.value.currency)) < 0) {
      return Err(new VaultStateError('a balance cannot be negative'));
    }

    const restated: BalanceAccount = {
      ...account,
      openingBalance: amount.value,
      openedOn: input.asOf,
    };
    const saved = await AssetRepository.save({ ...asset, balanceAccount: restated });
    if (!saved.ok) return saved;

    currentPorts().logger.info('balance restated');
    return Ok(balanceViewOf(restated, currentPorts().clock.today()));
  },

  async close(assetId: string, closedOn: IsoDate): Promise<Result<BalanceView>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    const gate = requireEditMode('closing a balance account');
    if (!gate.ok) return gate;

    const asset = await AssetRepository.findById(assetId);
    const account = asset?.balanceAccount;
    if (asset === undefined || account === undefined) {
      return Err(new VaultStateError('no balance account with that id'));
    }
    if (!ISO_DATE.test(closedOn)) {
      return Err(new VaultStateError('a closing date must be written as YYYY-MM-DD'));
    }

    const closedAccount: BalanceAccount = { ...account, closedOn };
    const saved = await AssetRepository.save({ ...asset, balanceAccount: closedAccount });
    if (!saved.ok) return saved;

    currentPorts().logger.info('balance account closed');
    return Ok(balanceViewOf(closedAccount, currentPorts().clock.today()));
  },
};
