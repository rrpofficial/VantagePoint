/**
 * FUNCTIONAL — which ledger-derived receipts count as taxable income.
 *
 * The property that matters is the DEFAULT, and it is asserted at the use-case
 * layer rather than through the checkbox, for the same reason edit mode is: a
 * browser control that starts unchecked proves nothing about what a second
 * client, a restart, or a restored vault will compute.
 *
 * Hand-loan interest and chit-fund returns are excluded until someone says
 * otherwise. Both are genuinely contested tax positions — receipt versus accrual
 * for the first, capital receipt versus income for the second — and a product
 * that quietly picked one would overstate a liability on a question it was never
 * entitled to answer. So: off on a fresh vault, off after a lock, off after a
 * corrupt settings row, and only ever on by a gated, deliberate act.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INCOME_INCLUSIONS,
  EditModeUC,
  enabledInclusionLabels,
  incomeInclusionsOf,
  loadIncomeInclusions,
  resetIncomeInclusions,
  resetPorts,
  saveIncomeInclusions,
} from '@porttrack/app-services';
import { SettingsRepository, Vault } from '@porttrack/persistence';
import { expectErr, expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-inclusions-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
  resetIncomeInclusions();
  EditModeUC.disable();
});

afterEach(async () => {
  await Vault.close();
  resetIncomeInclusions();
  EditModeUC.disable();
});

describe('Scenario: Nothing extra is taxed until it is asked for', () => {
  it('excludes hand-loan interest, chit returns and sell-to-cover on a fresh vault', () => {
    expect(incomeInclusionsOf()).toEqual({
      handLoanInterest: false,
      chitFundReturns: false,
      sellToCoverGains: false,
    });
  });

  it('exports a default with everything off, so a caller cannot start from "on"', () => {
    expect(DEFAULT_INCOME_INCLUSIONS.handLoanInterest).toBe(false);
    expect(DEFAULT_INCOME_INCLUSIONS.chitFundReturns).toBe(false);
    expect(DEFAULT_INCOME_INCLUSIONS.sellToCoverGains).toBe(false);
  });

  it('describes the default as nothing added, rather than as an empty failure', () => {
    expect(enabledInclusionLabels()).toEqual([]);
  });

  /*
   * The vault holds no settings row at all in this state. Reading the absence
   * must produce the default rather than throw — this runs during unlock, and a
   * throw here would make the vault look unopenable.
   */
  it('reads an absent setting as the default', async () => {
    await loadIncomeInclusions();
    expect(incomeInclusionsOf()).toEqual(DEFAULT_INCOME_INCLUSIONS);
  });
});

describe('Scenario: Turning one on is a deliberate, gated act', () => {
  it('refuses to change the position while edit mode is off', async () => {
    const refused = await saveIncomeInclusions({
      handLoanInterest: true,
      chitFundReturns: false,
      sellToCoverGains: false,
    });

    expectErr(refused, 'EDIT_MODE_REQUIRED');
    // And nothing moved: a refused write must not leave the cache ahead of the vault.
    expect(incomeInclusionsOf().handLoanInterest).toBe(false);
  });

  it('accepts the change once edit mode is on, and says what is included', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));

    expectOk(await saveIncomeInclusions({ handLoanInterest: true, chitFundReturns: false, sellToCoverGains: false }));

    expect(incomeInclusionsOf().handLoanInterest).toBe(true);
    expect(enabledInclusionLabels()).toEqual(['hand-loan interest']);
  });

  it('turns one back off again', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));
    expectOk(await saveIncomeInclusions({ handLoanInterest: true, chitFundReturns: true, sellToCoverGains: false }));
    expect(enabledInclusionLabels()).toHaveLength(2);

    expectOk(await saveIncomeInclusions({ handLoanInterest: false, chitFundReturns: false, sellToCoverGains: false }));
    expect(enabledInclusionLabels()).toEqual([]);
  });
});

describe('Scenario: The position survives a restart, and never leaks across vaults', () => {
  it('reloads what was stored', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));
    expectOk(await saveIncomeInclusions({ handLoanInterest: false, chitFundReturns: true, sellToCoverGains: false }));

    // As a restart would: drop the cache, then rehydrate from the vault.
    resetIncomeInclusions();
    expect(incomeInclusionsOf().chitFundReturns).toBe(false);

    await loadIncomeInclusions();
    expect(incomeInclusionsOf()).toEqual({
      handLoanInterest: false,
      chitFundReturns: true,
      sellToCoverGains: false,
    });
  });

  /*
   * The reset on lock. Inheriting the previous vault's position would apply a
   * tax treatment nobody chose in the vault now open — and it would do so
   * silently, which is the part that makes it dangerous rather than merely wrong.
   */
  it('falls back to the default when the vault is locked', async () => {
    expectOk(await EditModeUC.enable(PASSPHRASE));
    expectOk(await saveIncomeInclusions({ handLoanInterest: true, chitFundReturns: true, sellToCoverGains: false }));

    resetIncomeInclusions();

    expect(incomeInclusionsOf()).toEqual(DEFAULT_INCOME_INCLUSIONS);
  });

  /*
   * A settings row is opaque JSON to the persistence layer, so nothing stops a
   * hand-edited or half-written value reaching this. It must degrade to OFF —
   * the safe direction — instead of throwing out of the unlock path.
   */
  it('reads a corrupt setting as the default rather than throwing', async () => {
    expectOk(
      await SettingsRepository.set('tax.incomeInclusions', '{not json', '2026-09-15T00:00:00Z'),
    );

    await expect(loadIncomeInclusions()).resolves.toBeUndefined();
    expect(incomeInclusionsOf()).toEqual(DEFAULT_INCOME_INCLUSIONS);
  });

  /** A partial row must not let a missing field read as `true`. */
  it('treats a missing field as excluded', async () => {
    expectOk(
      await SettingsRepository.set(
        'tax.incomeInclusions',
        JSON.stringify({ handLoanInterest: true }),
        '2026-09-15T00:00:00Z',
      ),
    );

    await loadIncomeInclusions();

    expect(incomeInclusionsOf()).toEqual({
      handLoanInterest: true,
      chitFundReturns: false,
      sellToCoverGains: false,
    });
  });
});
