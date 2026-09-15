/**
 * FUNCTIONAL — importing the SBI TT Buy archive into the vault, and resolving
 * rates back out of it.
 *
 * The scenario that matters is the whole round trip: a rate imported today has
 * to still be there, byte-identical, when a capital gain is computed from it
 * years later. SBI publishes no history, so a rate lost on restart cannot be
 * re-fetched — which is the entire reason the store moved out of memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditModeUC, RatesUC, VaultUC, resetPorts } from '@vantagepoint/app-services';
import { DualRateConverter, Rule115Resolver } from '@vantagepoint/fx-itbr';
import { Vault } from '@vantagepoint/persistence';
import { expectErr, expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const REF = 'sbi-fx-ratekeeper/SBI_REFERENCE_RATES_USD.csv';

const HEADER =
  'DATE,PDF FILE,TT BUY,TT SELL,BILL BUY,BILL SELL,FOREX TRAVEL CARD BUY,FOREX TRAVEL CARD SELL,CN BUY,CN SELL';
const PDF = 'https://github.com/sahilgupta/sbi-fx-ratekeeper/blob/main/pdf_files/2026/3/2026-03-31.pdf';
const row = (stamp: string, ttBuy: string) =>
  `${stamp},${PDF},${ttBuy},96.15,95.23,96.32,95.23,96.32,94.1,96.7`;
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

/** Dates drawn from the real file, so the fixture matches production shape. */
const REAL = csv(
  row('2025-12-31 09:00', '89.47'),
  row('2026-02-27 09:00', '90.56'),
  row('2026-03-31 09:00', '93.15'),
  row('2026-05-30 09:00', '94.6'),
  row('2026-06-29 09:00', '93.95'),
  row('2026-07-31 09:00', '95'),
);

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vantagepoint-rates-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

const importReal = () =>
  RatesUC.importArchive({ csv: REAL, currency: 'USD', documentRef: REF });

describe('Scenario: The archive is imported into the vault', () => {
  it('stores every usable rate', async () => {
    const report = expectOk(await importReal());

    expect(report.parsed).toBe(6);
    expect(report.stored).toBe(6);
    expect(report.earliest).toBe('2025-12-31');
    expect(report.latest).toBe('2026-07-31');
  });

  it('reports coverage the vault now holds', async () => {
    expectOk(await importReal());

    const coverage = expectOk(await RatesUC.coverage());
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.currency).toBe('USD');
    expect(coverage[0]?.source).toBe('SBI_ITBR');
    expect(coverage[0]?.count).toBe(6);
  });

  /** Re-importing a refreshed file must not error — the archive grows daily. */
  it('is idempotent: a second import stores nothing new', async () => {
    expectOk(await importReal());

    const again = expectOk(await importReal());
    expect(again.stored).toBe(0);
    expect(again.alreadyPresent).toBe(6);
  });

  it('adds only the new dates when the archive has been extended', async () => {
    expectOk(await importReal());

    const extended = expectOk(
      await RatesUC.importArchive({
        csv: `${REAL}\n${row('2026-08-31 09:00', '95.4')}`,
        currency: 'USD',
        documentRef: REF,
      }),
    );
    expect(extended.stored).toBe(1);
  });

  /*
   * A rate that disagrees with one already stored is a conflict, not an update.
   * Silently overwriting would retroactively change a gain computed from the old
   * value, with nothing to show it had happened.
   */
  it('refuses a file that contradicts a stored rate', async () => {
    expectOk(await importReal());

    expectErr(
      await RatesUC.importArchive({
        csv: csv(row('2026-03-31 09:00', '99.99')),
        currency: 'USD',
        documentRef: REF,
      }),
      'RATE_CONFLICT',
    );
  });

  it('leaves the stored rate untouched when it refuses', async () => {
    expectOk(await importReal());
    await RatesUC.importArchive({
      csv: csv(row('2026-03-31 09:00', '99.99')),
      currency: 'USD',
      documentRef: REF,
    });

    const explained = expectOk(RatesUC.explain('USD', '2026-04-13'));
    expect(explained.rule115.rate).toBe('93.15');
  });
});

describe('Scenario: Rates outlive the session that imported them', () => {
  /*
   * The whole reason migration v8 exists. The store was a process-level Map, so
   * every rate died on restart — survivable for a display figure, fatal for a
   * tax one, because SBI cannot supply a 2020 rate on request in 2026.
   */
  it('survives a lock and reload', async () => {
    expectOk(await importReal());

    await VaultUC.lock();
    expectOk(await Vault.unlock(PASSPHRASE));
    expectOk(await VaultUC.unlock(PASSPHRASE));

    const coverage = expectOk(await RatesUC.coverage());
    expect(coverage[0]?.count).toBe(6);
  });

  it('resolves nothing while the vault is locked, rather than throwing', async () => {
    expectOk(await importReal());
    await VaultUC.lock();

    expectErr(RatesUC.explain('USD', '2026-04-13'), 'VAULT_STATE');
  });
});

describe('Scenario: Both conversion bases are shown, never silently chosen', () => {
  /*
   * ADR-003 and risk R4. Rule 115 names the last day of the month preceding the
   * transfer; an RSU's cost basis uses the rate on the day it vested, because the
   * perquisite was taxed in rupees at that rate. The two differ and the correct
   * one is contested, so the app reports both and records which was applied.
   */
  it('reports the transaction-date rate and the Rule 115 rate side by side', async () => {
    expectOk(await importReal());

    const explained = expectOk(RatesUC.explain('USD', '2026-04-13'));

    expect(explained.rule115.date).toBe('2026-03-31');
    expect(explained.rule115.rate).toBe('93.15');
    // No card on 13 April in this fixture, so the chain walks back — and says so.
    expect(explained.transactionDate.isFallback).toBe(true);
  });

  it('walks back over a month-end SBI did not publish', async () => {
    expectOk(await importReal());

    // 31 May 2026 was a Sunday; the last published card was the 30th.
    const explained = expectOk(RatesUC.explain('USD', '2026-06-22'));
    expect(explained.rule115.date).toBe('2026-05-30');
    expect(explained.rule115.rate).toBe('94.6');
  });

  it('converts a USD amount through the stored rate', async () => {
    expectOk(await importReal());

    const rates = expectOk(DualRateConverter.ratesFor('USD', '2026-08-28'));
    const converted = DualRateConverter.convert({ amount: '1000', currency: 'USD' }, rates);

    // Rule 115 basis for an August transfer is 31 July: 1000 x 95.
    expect(converted.taxableInr.amount).toBe('95000');
  });

  it('names 31 July as the basis date for an August transfer', () => {
    expect(Rule115Resolver.basisDateFor('2026-08-28')).toBe('2026-07-31');
  });
});

describe('Scenario: Gaps and revisions are surfaced, not hidden', () => {
  it('reports a day SBI published no TT buy rate', async () => {
    const report = expectOk(
      await RatesUC.importArchive({
        csv: csv(row('2020-01-04 09:00', '0.00'), row('2020-01-06 09:00', '71.65')),
        currency: 'USD',
        documentRef: REF,
      }),
    );

    expect(report.skipped.map((day) => day.date)).toEqual(['2020-01-04']);
    expect(report.stored).toBe(1);
  });

  it('reports a day SBI republished at a different rate', async () => {
    const report = expectOk(
      await RatesUC.importArchive({
        csv: csv(row('2024-06-04 11:30', '83.05'), row('2024-06-04 16:00', '83.15')),
        currency: 'USD',
        documentRef: REF,
      }),
    );

    expect(report.revisions).toHaveLength(1);
    expect(report.revisions[0]?.ratesDiffer).toBe(true);
  });
});

describe('Scenario: Writing rates is a protected operation', () => {
  /*
   * Gated unlike other imports. Every other import adds records you can see and
   * correct; this one writes the denominators every foreign figure is computed
   * through, where a wrong value is invisible in the output.
   */
  it('refuses an archive import while edit mode is off', async () => {
    EditModeUC.disable();

    expectErr(await importReal(), 'EDIT_MODE_REQUIRED');
  });

  it('refuses a hand-entered rate while edit mode is off', () => {
    EditModeUC.disable();

    expectErr(
      RatesUC.record({ currency: 'USD', date: '2026-06-30', rate: '94.10', documentRef: 'SBI card' }),
      'EDIT_MODE_REQUIRED',
    );
  });

  /** A hand-entered rate is the likeliest to arrive with no stated source. */
  it('refuses a hand-entered rate with no provenance', () => {
    expectErr(
      RatesUC.record({ currency: 'USD', date: '2026-06-30', rate: '94.10', documentRef: '   ' }),
      'VAULT_STATE',
    );
  });

  it('accepts a hand-entered rate for a date no archive covers', async () => {
    expectOk(await importReal());

    expectOk(
      RatesUC.record({
        currency: 'USD',
        date: '2026-09-30',
        rate: '95.80',
        documentRef: 'SBI card 2026-09-30, downloaded from sbi.co.in',
      }),
    );

    const explained = expectOk(RatesUC.explain('USD', '2026-10-15'));
    expect(explained.rule115.rate).toBe('95.80');
  });
});
