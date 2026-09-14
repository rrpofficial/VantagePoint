/**
 * FUNCTIONAL — deleting a record, and what has to stay true afterwards.
 *
 * Deletion is the one operation with no visible aftermath: a holding that is
 * gone looks exactly like a holding that was never recorded. So what these
 * scenarios check is not "did the row disappear" but everything ELSE that must
 * move with it, and the things that must not:
 *
 *  - net worth follows, so the Dashboard and the Ledger cannot disagree;
 *  - a deleted disposal returns its units to the lots it took them from, or the
 *    holding stays permanently short with nothing to show why;
 *  - a deleted loan leaves its audit trail behind, which is the only remaining
 *    answer to "what happened to the loan I remember";
 *  - reference data still in use is refused, not silently orphaned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChitUC,
  EditModeUC,
  LedgerUC,
  LoanUC,
  TradeUC,
  ValuePortfolioUC,
  resetPorts,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-04-01';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-delete-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
  EditModeUC.disable();
});

const buy = (quantity = '10', price = '1500', symbol = 'INFY') =>
  TradeUC.record({
    assetClass: 'DOMESTIC_EQUITY',
    side: 'BUY',
    tradeDate: '2025-05-01',
    symbol,
    quantity,
    pricePerUnit: inr(price),
  });

const sell = (quantity = '4', price = '1800', symbol = 'INFY') =>
  TradeUC.record({
    assetClass: 'DOMESTIC_EQUITY',
    side: 'SELL',
    tradeDate: '2025-09-01',
    symbol,
    quantity,
    pricePerUnit: inr(price),
  });

const lend = (name = 'Rajesh Sharma', amount = '100000') =>
  LoanUC.record({
    borrowerName: name,
    principal: inr(amount),
    interestRatePct: '12',
    loanDate: '2025-04-01',
  });

const openChit = (label = '5L / 25 months', scheduleLabel?: string) =>
  ChitUC.open({
    org: 'Sri Balaji Chits',
    label,
    targetAmount: inr('500000'),
    startDate: '2025-04-01',
    durationMonths: 25,
    emiType: 'CONSTANT',
    ...(scheduleLabel === undefined ? {} : { scheduleLabel }),
  });

const netWorth = async () =>
  expectOk(await ValuePortfolioUC.execute(`${AS_OF}T00:00:00+05:30`)).netWorth.amount;

describe('Scenario: A holding is deleted', () => {
  it('leaves the ledger', async () => {
    const trade = expectOk(await buy());

    expectOk(await LedgerUC.deleteAsset(trade.assetId));

    expect(await LedgerUC.assets()).toHaveLength(0);
  });

  it('takes its lots with it', async () => {
    const trade = expectOk(await buy());
    expectOk(await LedgerUC.deleteAsset(trade.assetId));

    const remaining = (await LedgerUC.assets()).flatMap((asset) => asset.lots);
    expect(remaining).toEqual([]);
  });

  /*
   * The disposal goes too. An exit left behind would report a realised gain on
   * units the book no longer says were ever acquired — a gain figure with no
   * cost basis anywhere behind it, which is worse than no figure at all.
   */
  it('takes the disposals recorded against it', async () => {
    const trade = expectOk(await buy());
    expectOk(await sell());

    expectOk(await LedgerUC.deleteAsset(trade.assetId));

    expect(await LedgerUC.exits()).toEqual([]);
  });

  it('moves net worth by what it was carried at', async () => {
    const trade = expectOk(await buy('10', '1500'));
    expect(await netWorth()).not.toBe('0');

    expectOk(await LedgerUC.deleteAsset(trade.assetId));

    expect(await netWorth()).toBe('0');
  });

  it('leaves every other holding alone', async () => {
    const infosys = expectOk(await buy('10', '1500', 'INFY'));
    expectOk(await buy('5', '3000', 'TCS'));

    expectOk(await LedgerUC.deleteAsset(infosys.assetId));

    const remaining = await LedgerUC.assets();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.symbol).toBe('TCS');
  });

  it('refuses an id that is not on the book', async () => {
    expectErr(await LedgerUC.deleteAsset('ast_not_a_real_asset'), 'VAULT_STATE');
  });

  /*
   * Routed, not refused outright. A loan deleted through the generic path would
   * skip the audit entry, and a trail that can be got around by using a
   * different endpoint is not a trail.
   */
  it('refuses a hand loan, pointing at the path that writes a trail', async () => {
    const loanId = expectOk(await lend());

    expectErr(await LedgerUC.deleteAsset(loanId), 'VAULT_STATE');
    expect(expectOk(await LoanUC.register({ asOf: AS_OF })).loans).toHaveLength(1);
  });

  it('refuses a chit, pointing at its own tab', async () => {
    const chitId = expectOk(await openChit());

    expectErr(await LedgerUC.deleteAsset(chitId), 'VAULT_STATE');
    expect(expectOk(await ChitUC.register({ asOf: AS_OF })).chits).toHaveLength(1);
  });
});

describe('Scenario: A disposal is deleted', () => {
  it('leaves the disposal list', async () => {
    expectOk(await buy('10'));
    expectOk(await sell('4'));
    const exit = (await LedgerUC.exits())[0];

    expectOk(await LedgerUC.deleteExit(exit?.txnId ?? ''));

    expect(await LedgerUC.exits()).toEqual([]);
  });

  /*
   * The whole reason this is not a row delete. Depletion lives in
   * `remainingQuantity`, not in the presence of the exit, so removing the row
   * alone would leave the holding permanently 4 units short with nothing left
   * on the book to explain where they went.
   */
  it('returns the units to the lots it took them from', async () => {
    expectOk(await buy('10'));
    expectOk(await sell('4'));

    const beforeDelete = (await LedgerUC.assets())[0]?.lots[0];
    expect(beforeDelete?.remainingQuantity).toBe('6');

    const exit = (await LedgerUC.exits())[0];
    expectOk(await LedgerUC.deleteExit(exit?.txnId ?? ''));

    const afterDelete = (await LedgerUC.assets())[0]?.lots[0];
    expect(afterDelete?.remainingQuantity).toBe('10');
  });

  it('puts the value of those units back into net worth', async () => {
    expectOk(await buy('10', '1500'));
    const whole = await netWorth();

    expectOk(await sell('4'));
    expect(await netWorth()).not.toBe(whole);

    const exit = (await LedgerUC.exits())[0];
    expectOk(await LedgerUC.deleteExit(exit?.txnId ?? ''));

    expect(await netWorth()).toBe(whole);
  });

  it('restores only the lots that disposal touched', async () => {
    expectOk(await buy('10', '1500', 'INFY'));
    expectOk(await buy('5', '3000', 'TCS'));
    expectOk(await sell('4', '1800', 'INFY'));

    const exit = (await LedgerUC.exits())[0];
    expectOk(await LedgerUC.deleteExit(exit?.txnId ?? ''));

    const tcs = (await LedgerUC.assets()).find((asset) => asset.symbol === 'TCS');
    expect(tcs?.lots[0]?.remainingQuantity).toBe('5');
  });

  it('leaves the holding itself in place', async () => {
    expectOk(await buy('10'));
    expectOk(await sell('4'));
    const exit = (await LedgerUC.exits())[0];

    expectOk(await LedgerUC.deleteExit(exit?.txnId ?? ''));

    expect(await LedgerUC.assets()).toHaveLength(1);
  });

  it('refuses an id that is not on the book', async () => {
    expectErr(await LedgerUC.deleteExit('txn_not_real'), 'VAULT_STATE');
  });
});

describe('Scenario: A hand loan is deleted', () => {
  it('leaves the register, and the money it represented leaves net worth', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '100000'));

    expectOk(await LoanUC.delete(loanId));

    expect(expectOk(await LoanUC.register({ asOf: AS_OF })).loans).toEqual([]);
    expect(await netWorth()).toBe('0');
  });

  /*
   * The point of `hand_loan_audit` carrying no foreign key to `assets` (v6
   * migration). The trail outliving the loan is what can still answer why a loan
   * someone remembers is no longer on the register.
   */
  it('leaves its audit trail behind, with an entry saying it was deleted', async () => {
    const loanId = expectOk(await lend());

    expectOk(await LoanUC.delete(loanId, { reason: 'recorded against the wrong person' }));

    const trail = expectOk(await LoanUC.auditFor(loanId));
    expect(trail.some((entry) => entry.action === 'DELETED')).toBe(true);
    expect(trail.find((entry) => entry.action === 'DELETED')?.reason).toBe(
      'recorded against the wrong person',
    );
  });

  it('records the terms in the trail, so what was removed is still legible', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '100000'));

    expectOk(await LoanUC.delete(loanId));

    const deleted = expectOk(await LoanUC.auditFor(loanId)).find(
      (entry) => entry.action === 'DELETED',
    );
    expect(deleted?.newValue).toContain('100000');
  });

  /*
   * ADR-013. An audit entry is read outside the register that holds it — the
   * borrower's name stays in the vault, and `borrowerRef` is what travels.
   */
  it('keeps the borrower name out of the trail entry', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma'));

    expectOk(await LoanUC.delete(loanId));

    const deleted = expectOk(await LoanUC.auditFor(loanId)).find(
      (entry) => entry.action === 'DELETED',
    );
    expect(JSON.stringify(deleted)).not.toContain('Rajesh');
  });

  it('keeps the earlier entries too, not just the deletion', async () => {
    const loanId = expectOk(await lend());
    expectOk(await LoanUC.edit(loanId, { notes: 'shop renovation' }));

    expectOk(await LoanUC.delete(loanId));

    const trail = expectOk(await LoanUC.auditFor(loanId));
    expect(trail.some((entry) => entry.action === 'EDITED')).toBe(true);
  });

  it('survives a lock and reload — the trail is in the vault, not in memory', async () => {
    const loanId = expectOk(await lend());
    expectOk(await LoanUC.delete(loanId));

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));
    expectOk(await EditModeUC.enable(PASSPHRASE));

    expect(expectOk(await LoanUC.auditFor(loanId))).not.toHaveLength(0);
  });

  it('leaves other loans alone', async () => {
    const first = expectOk(await lend('Rajesh Sharma'));
    expectOk(await lend('Priya Nair'));

    expectOk(await LoanUC.delete(first));

    const register = expectOk(await LoanUC.register({ asOf: AS_OF }));
    expect(register.loans).toHaveLength(1);
    expect(register.loans[0]?.borrowerName).toBe('Priya Nair');
  });

  it('refuses an id that is not a loan', async () => {
    const chitId = expectOk(await openChit());

    expectErr(await LoanUC.delete(chitId), 'VAULT_STATE');
  });
});

describe('Scenario: A chit is deleted', () => {
  it('leaves the register, taking its instalments with it', async () => {
    const chitId = expectOk(await openChit());
    expectOk(
      await ChitUC.recordEmi({
        chitId,
        date: '2025-05-01',
        amount: inr('20000'),
        mode: 'BANK_TRANSFER',
        paidTo: 'Balaji branch',
      }),
    );

    expectOk(await ChitUC.delete(chitId));

    expect(expectOk(await ChitUC.register({ asOf: AS_OF })).chits).toEqual([]);
    expect(await netWorth()).toBe('0');
  });

  it('leaves other chits alone', async () => {
    const first = expectOk(await openChit('5L / 25 months'));
    expectOk(await openChit('10L / 40 months'));

    expectOk(await ChitUC.delete(first));

    const register = expectOk(await ChitUC.register({ asOf: AS_OF }));
    expect(register.chits).toHaveLength(1);
    expect(register.chits[0]?.label).toBe('10L / 40 months');
  });

  it('refuses an id that is not a chit', async () => {
    const loanId = expectOk(await lend());

    expectErr(await ChitUC.delete(loanId), 'VAULT_STATE');
  });
});

describe('Scenario: A withdrawal schedule is deleted', () => {
  it('goes when nothing points at it', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'unused', rows: [{ month: 1, amount: inr('350000') }] }),
    );

    expectOk(await ChitUC.deleteSchedule('unused'));

    expect(expectOk(await ChitUC.schedules())).toEqual([]);
  });

  /*
   * Refused while in use. The schedule is what turns a month number into the
   * amount the pot pays out; removing it from under a chit leaves that chit's
   * withdrawal figure unresolvable, and the chit gives no sign the figure it
   * used to show ever existed.
   */
  it('is refused while a chit still names it', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'in use', rows: [{ month: 1, amount: inr('350000') }] }),
    );
    expectOk(await openChit('5L / 25 months', 'in use'));

    expectErr(await ChitUC.deleteSchedule('in use'), 'VAULT_STATE');
    expect(expectOk(await ChitUC.schedules())).toHaveLength(1);
  });

  it('goes once the chit using it has been deleted', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'in use', rows: [{ month: 1, amount: inr('350000') }] }),
    );
    const chitId = expectOk(await openChit('5L / 25 months', 'in use'));

    expectOk(await ChitUC.delete(chitId));

    expectOk(await ChitUC.deleteSchedule('in use'));
    expect(expectOk(await ChitUC.schedules())).toEqual([]);
  });
});
