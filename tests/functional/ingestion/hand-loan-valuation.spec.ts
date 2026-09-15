/**
 * FUNCTIONAL — two loans to the same borrower must both count.
 *
 * Reported from the running app: a template importing ₹26,00,000 and ₹4,00,000
 * of hand loans showed ₹30,00,000 on the Ledger but only ₹4,00,000 on the
 * Dashboard, and a net worth of ₹5,00,000 instead of ₹31,00,000.
 *
 * Two faults, one visible number:
 *
 *  1. Hand loans were keyed on the BORROWER, so both rows collapsed into one
 *     asset holding two lots but only the first row's loan terms.
 *  2. `ValuationEngine` valued a hand loan from that single `handLoan` block —
 *     "a loan receivable has no lots" — so the second lot was never read.
 *
 * The dangerous part is that nothing looked broken: the total was wrong but
 * plausible, and the Ledger, which sums lots, disagreed with the Dashboard,
 * which did not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportStatementUC, LedgerUC, ValuePortfolioUC, resetPorts } from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { TemplateRegistry } from '@vantagepoint/ingestion';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-08-08T23:59:59.999+05:30';

/** The register header, taken from the template itself so the two cannot drift. */
const HEADER = TemplateRegistry.definitions()
  .find((template) => template.name === 'Custom_HandLoans')!
  .columns.join(',');

/** borrower, notes, loan_date, closed_date, amount, rate, currency — rest blank. */
const loanRow = (name: string, amount: string, rate: string, date: string) =>
  `${name},,${date},,${amount},${rate},INR${','.repeat(18)}`;

async function unlocked(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-loans-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
}

const importCsv = (rows: readonly string[]) =>
  ImportStatementUC.execute({
    file: Buffer.from([HEADER, ...rows].join('\n')),
    fileName: 'loans.csv',
    parser: 'TEMPLATE',
    mode: 'STRICT',
  });

beforeEach(unlocked);
afterEach(async () => {
  await Vault.close();
});

describe('Scenario: Two loans to the same borrower are two receivables', () => {
  const TWO_LOANS = [
    loanRow('Same Person', '2600000', '8', '2026-08-08'),
    loanRow('Same Person', '400000', '9', '2026-08-08'),
  ];

  it('records them as separate assets, each with its own terms', async () => {
    expectOk(await importCsv(TWO_LOANS));

    const assets = await LedgerUC.assets();
    expect(assets).toHaveLength(2);
    // Merged on the borrower, these were one asset carrying one rate — and the
    // 9% loan's interest would have accrued at 8% forever.
    expect(assets.map((asset) => asset.handLoan?.interestRatePct).sort()).toEqual(['8', '9']);
    expect(assets.every((asset) => asset.lots.length === 1)).toBe(true);
  });

  it('counts BOTH principals in net worth', async () => {
    expectOk(await importCsv(TWO_LOANS));

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));
    const handLoans = valuation.byAssetClass['HAND_LOAN'];

    // The reported bug: this was ₹4,00,000.
    expect(handLoans?.amount).toBe('3000000');
    expect(valuation.netWorth.amount).toBe('3000000');
    expect(valuation.positions).toHaveLength(2);
  });

  it('agrees with what the Ledger totals from lots', async () => {
    expectOk(await importCsv(TWO_LOANS));

    const assets = await LedgerUC.assets();
    const ledgerTotal = assets
      .flatMap((asset) => asset.lots)
      .reduce((sum, lot) => sum + Number(lot.costPerUnit.amount) * Number(lot.remainingQuantity), 0);

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));

    // The two screens disagreeing is the symptom a user can actually see; this
    // is the assertion that keeps them in step.
    expect(Number(valuation.byAssetClass['HAND_LOAN']?.amount)).toBe(ledgerTotal);
  });
});

describe('Scenario: A hand loan alongside other assets', () => {
  it('reports the full net worth across asset classes', async () => {
    expectOk(await importCsv([loanRow('Same Person', '2600000', '8', '2026-08-08')]));
    expectOk(
      await ImportStatementUC.execute({
        file: Buffer.from(
          'account_label,as_of_date,balance,currency\nICICI1,2026-08-08,100000,INR\n',
        ),
        fileName: 'cash.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));
    expect(valuation.byAssetClass['BANK_BALANCE']?.amount).toBe('100000');
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('2600000');
    expect(valuation.netWorth.amount).toBe('2700000');
  });
});

describe('Scenario: Re-importing the same loans changes nothing', () => {
  it('keeps the identity stable so no duplicate loan appears', async () => {
    const rows = [
      loanRow('Same Person', '2600000', '8', '2026-08-08'),
      loanRow('Same Person', '400000', '9', '2026-08-08'),
    ];
    expectOk(await importCsv(rows));
    const first = expectOk(await ValuePortfolioUC.execute(AS_OF));

    expectOk(await importCsv(rows));
    const second = expectOk(await ValuePortfolioUC.execute(AS_OF));

    // The loan id is derived from its own terms, not its row number, so a
    // re-export in a different order still resolves to the same asset.
    expect(second.netWorth.amount).toBe(first.netWorth.amount);
    expect(await LedgerUC.assets()).toHaveLength(2);
  });

  it('is order-independent', async () => {
    expectOk(
      await importCsv([
        loanRow('Same Person', '400000', '9', '2026-08-08'),
        loanRow('Same Person', '2600000', '8', '2026-08-08'),
      ]),
    );
    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));
    expect(valuation.netWorth.amount).toBe('3000000');
  });
});

describe('Scenario: Loans to different borrowers stay separate', () => {
  it('never merges two people', async () => {
    expectOk(
      await importCsv([
        loanRow('Person One', '2600000', '8', '2026-08-08'),
        loanRow('Person Two', '400000', '8', '2026-08-08'),
      ]),
    );

    const assets = await LedgerUC.assets();
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((asset) => asset.handLoan?.borrowerRef)).size).toBe(2);

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));
    expect(valuation.netWorth.amount).toBe('3000000');
  });
});
