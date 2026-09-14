/**
 * FUNCTIONAL — the edit/update/delete mode.
 *
 * What these pin down is the difference between a control and a courtesy. The
 * SPA hides its edit and delete buttons when the mode is off, which is helpful
 * and worth nothing on its own — anything that speaks HTTP goes straight past
 * it. So every scenario here calls the use cases directly, exactly as a script
 * or a second client would, and asserts the refusal happens there.
 *
 * The three properties that make the mode meaningful, one scenario each:
 *  - additions never need it, so nobody is tempted to leave it on;
 *  - changes and deletions always do, on every tab;
 *  - it dies with the session, and no wrong passphrase ever opens it.
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
  resetPorts,
  saveIncomeProfile,
  setIncomeProfile,
} from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-edit-mode-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
  // Every scenario starts with the mode OFF. That is the shipped default and
  // the state a fresh unlock must always land in.
  EditModeUC.disable();
});

afterEach(async () => {
  await Vault.close();
  setIncomeProfile(undefined);
  EditModeUC.disable();
});

const lend = (name = 'Rajesh Sharma') =>
  LoanUC.record({
    borrowerName: name,
    principal: inr('100000'),
    interestRatePct: '12',
    loanDate: '2025-04-01',
  });

const openChit = (label = '5L / 25 months') =>
  ChitUC.open({
    org: 'Sri Balaji Chits',
    label,
    targetAmount: inr('500000'),
    startDate: '2025-04-01',
    durationMonths: 25,
    emiType: 'CONSTANT',
  });

describe('Scenario: Turning the mode on is a deliberate act', () => {
  it('is off on a freshly unlocked vault', () => {
    expect(EditModeUC.isEnabled()).toBe(false);
  });

  it('opens for the vault passphrase', async () => {
    const state = expectOk(await EditModeUC.enable(PASSPHRASE));

    expect(state.enabled).toBe(true);
    expect(EditModeUC.isEnabled()).toBe(true);
  });

  it('records when it was turned on, so the UI can say how long it has been open', async () => {
    const state = expectOk(await EditModeUC.enable(PASSPHRASE));
    expect(state.since).toBeDefined();
  });

  it('refuses a wrong passphrase', async () => {
    expectErr(await EditModeUC.enable('not the passphrase'), 'EDIT_MODE_REQUIRED');
    expect(EditModeUC.isEnabled()).toBe(false);
  });

  /*
   * An empty passphrase must not be a shortcut. `Vault.unlock` refuses one for a
   * related reason — on a brand-new vault it would silently set the key — and a
   * verifier that accepted it here would hand the mode to a bare Enter press.
   */
  it('refuses an empty passphrase', async () => {
    expectErr(await EditModeUC.enable(''), 'EDIT_MODE_REQUIRED');
    expect(EditModeUC.isEnabled()).toBe(false);
  });

  it('says nothing about the passphrase it refused', async () => {
    const result = await EditModeUC.enable('hunter2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain('hunter2');
  });

  it('can be turned off again without one', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));

    expect(EditModeUC.disable().enabled).toBe(false);
    expect(EditModeUC.isEnabled()).toBe(false);
  });
});

describe('Scenario: The mode lasts exactly as long as the session', () => {
  it('is off again after the vault is locked', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));

    await Vault.lock();

    expect(EditModeUC.isEnabled()).toBe(false);
  });

  /*
   * The point of the whole feature. Unlocking is what a second person does when
   * they sit down at the machine; inheriting an open edit mode from whoever used
   * it last would mean the passphrase they typed authorised something they never
   * asked for.
   */
  it('does not come back when the vault is unlocked again', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));
    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    expect(EditModeUC.isEnabled()).toBe(false);
  });

  /*
   * A reload is not a new session. The SPA re-submits the passphrase on every
   * page load, because "unlocked" is client state that starts false on mount —
   * so treating a re-unlock as a fresh session turned edit mode off every time
   * the user refreshed the tab, with nothing on screen to explain it.
   */
  it('survives the passphrase being re-submitted on an already-open vault', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));

    expectOk(await Vault.unlock(PASSPHRASE));

    expect(EditModeUC.isEnabled()).toBe(true);
  });

  it('cannot be turned on while the vault is locked', async () => {
    await Vault.lock();

    expectErr(await EditModeUC.enable(PASSPHRASE), 'EDIT_MODE_REQUIRED');
    expect(EditModeUC.isEnabled()).toBe(false);
  });
});

describe('Scenario: Recording new information never needs the mode', () => {
  it('records a hand loan', async () => {
    expectOk(await lend());
  });

  it('records a payment against an existing loan', async () => {
    const loanId = expectOk(await lend());

    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2025-06-01',
        amount: inr('10000'),
        mode: 'BANK_TRANSFER',
      }),
    );
  });

  it('opens a chit and records an instalment against it', async () => {
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
  });

  it('records a trade', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-05-01',
        symbol: 'INFY',
        quantity: '10',
        pricePerUnit: inr('1500'),
      }),
    );
  });

  it('saves a withdrawal schedule under a label nothing uses yet', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'brand new', rows: [{ month: 1, amount: inr('350000') }] }),
    );
  });
});

describe('Scenario: Changing an existing record is refused while the mode is off', () => {
  it('refuses a loan edit', async () => {
    const loanId = expectOk(await lend());

    expectErr(await LoanUC.edit(loanId, { principalAmount: '999' }), 'EDIT_MODE_REQUIRED');
  });

  it('refuses closing and reopening a loan', async () => {
    const loanId = expectOk(await lend());

    expectErr(await LoanUC.close(loanId, '2026-01-01'), 'EDIT_MODE_REQUIRED');
    expectErr(await LoanUC.reopen(loanId), 'EDIT_MODE_REQUIRED');
  });

  it('refuses a chit edit', async () => {
    const chitId = expectOk(await openChit());

    expectErr(await ChitUC.edit(chitId, { label: 'renamed' }), 'EDIT_MODE_REQUIRED');
  });

  it('refuses a chit status change in either direction', async () => {
    const chitId = expectOk(await openChit());

    expectErr(
      await ChitUC.withdraw(chitId, { date: '2025-10-01', amount: inr('420000') }),
      'EDIT_MODE_REQUIRED',
    );
    expectErr(await ChitUC.setStatus(chitId, 'ACTIVE'), 'EDIT_MODE_REQUIRED');
  });

  /*
   * The overwrite, not the save. A schedule is shared reference data: replacing
   * its rows revalues every chit pointing at that label at once, which is a
   * change to existing records however much the button says "save".
   */
  it('refuses replacing a schedule that already exists, having allowed its creation', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'shared', rows: [{ month: 1, amount: inr('350000') }] }),
    );

    expectErr(
      await ChitUC.saveSchedule({ label: 'shared', rows: [{ month: 1, amount: inr('999999') }] }),
      'EDIT_MODE_REQUIRED',
    );
  });

  it('refuses replacing an income profile, having allowed the first one', async () => {
    const profile = {
      financialYear: '2025-26',
      assessmentYear: '2026-27',
      grossSalary: inr('1200000'),
      exemptAllowances: inr('0'),
      chapterViaDeductions: inr('0'),
      housePropertyIncome: inr('0'),
      otherSourcesIncome: inr('0'),
      tdsRemitted: inr('0'),
      tcsCollected: inr('0'),
    } as Parameters<typeof saveIncomeProfile>[0];

    expectOk(await saveIncomeProfile(profile));
    expectErr(await saveIncomeProfile(profile), 'EDIT_MODE_REQUIRED');
  });

  it('leaves the record untouched when it refuses', async () => {
    const loanId = expectOk(await lend());

    expectErr(await LoanUC.edit(loanId, { principalAmount: '1' }), 'EDIT_MODE_REQUIRED');

    const register = expectOk(await LoanUC.register({ asOf: '2026-04-01' }));
    expect(register.loans[0]?.principal.amount).toBe('100000');
  });

  it('writes no audit entry for a refused edit', async () => {
    const loanId = expectOk(await lend());
    const before = expectOk(await LoanUC.auditFor(loanId));

    expectErr(await LoanUC.edit(loanId, { notes: 'nope' }), 'EDIT_MODE_REQUIRED');

    expect(expectOk(await LoanUC.auditFor(loanId))).toHaveLength(before.length);
  });
});

describe('Scenario: Deleting is refused while the mode is off', () => {
  it('refuses deleting a loan', async () => {
    const loanId = expectOk(await lend());

    expectErr(await LoanUC.delete(loanId), 'EDIT_MODE_REQUIRED');
    expect(expectOk(await LoanUC.register({ asOf: '2026-04-01' })).loans).toHaveLength(1);
  });

  it('refuses deleting a chit', async () => {
    const chitId = expectOk(await openChit());

    expectErr(await ChitUC.delete(chitId), 'EDIT_MODE_REQUIRED');
    expect(expectOk(await ChitUC.register({ asOf: '2025-12-31' })).chits).toHaveLength(1);
  });

  it('refuses deleting a holding', async () => {
    const trade = expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-05-01',
        symbol: 'INFY',
        quantity: '10',
        pricePerUnit: inr('1500'),
      }),
    );

    expectErr(await LedgerUC.deleteAsset(trade.assetId), 'EDIT_MODE_REQUIRED');
    expect(await LedgerUC.assets()).toHaveLength(1);
  });

  it('refuses deleting a withdrawal schedule', async () => {
    expectOk(
      await ChitUC.saveSchedule({ label: 'doomed', rows: [{ month: 1, amount: inr('350000') }] }),
    );

    expectErr(await ChitUC.deleteSchedule('doomed'), 'EDIT_MODE_REQUIRED');
    expect(expectOk(await ChitUC.schedules())).toHaveLength(1);
  });
});

describe('Scenario: One mode covers every tab', () => {
  /*
   * Enabled ONCE, then a change is made on each tab in turn. A per-screen
   * permission would need turning on repeatedly, and the whole point of the
   * feature is that the user makes this decision once per session.
   */
  it('permits loans, chits, schedules and holdings after a single enable', async () => {
    const loanId = expectOk(await lend());
    const chitId = expectOk(await openChit());
    const trade = expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2025-05-01',
        symbol: 'INFY',
        quantity: '10',
        pricePerUnit: inr('1500'),
      }),
    );
    expectOk(
      await ChitUC.saveSchedule({ label: 'shared', rows: [{ month: 1, amount: inr('350000') }] }),
    );

    expectOk(await EditModeUC.enable(PASSPHRASE));

    expectOk(await LoanUC.edit(loanId, { principalAmount: '150000' }));
    expectOk(await ChitUC.edit(chitId, { label: 'renamed' }));
    expectOk(
      await ChitUC.saveSchedule({ label: 'shared', rows: [{ month: 1, amount: inr('360000') }] }),
    );
    expectOk(await LedgerUC.deleteAsset(trade.assetId));
  });

  it('closes them all again the moment it is turned off', async () => {
    const loanId = expectOk(await lend());
    expectOk(await EditModeUC.enable(PASSPHRASE));
    expectOk(await LoanUC.edit(loanId, { principalAmount: '150000' }));

    EditModeUC.disable();

    expectErr(await LoanUC.edit(loanId, { principalAmount: '200000' }), 'EDIT_MODE_REQUIRED');
  });
});
