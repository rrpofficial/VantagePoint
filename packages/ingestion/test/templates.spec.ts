/**
 * US-4.6 — standardised CSV templates, as a working import path.
 *
 * The previous coverage asserted `rows.length > 0` under the title "parses
 * borrower details, principal, interest rate and start date" — none of which it
 * checked. It passed against a parser that turned every template row into a
 * generic BUY with quantity 1 and discarded which template it had read, so a
 * hand loan and a bank balance were indistinguishable and neither could become
 * the asset it was.
 */
import { describe, it, expect } from 'vitest';
import { LedgerProjector, TemplateRegistry, TemplateParser, Pipeline } from '@porttrack/ingestion';
import { expectOk } from '@porttrack/test-kit';

/** The full register header, exactly as the generated template emits it. */
const HAND_LOAN_HEADER = TemplateRegistry.definitions()
  .find((template) => template.name === 'Custom_HandLoans')!
  .columns.join(',');

/** Only the leading fact columns are filled; the rest are blank, as a sheet may be. */
const handLoanRow = (cells: string) => `${cells}${','.repeat(17)}`;

/**
 * A CSV row built BY COLUMN NAME from the live template definition.
 *
 * Typing a row positionally couples the test to a column order that changes
 * whenever a template gains a field — and a shifted row fails as "no asset",
 * which looks like a projector bug rather than a stale fixture.
 */
function rowFor(templateName: string, values: Readonly<Record<string, string>>): string {
  const template = TemplateRegistry.definitions().find((entry) => entry.name === templateName);
  if (template === undefined) throw new Error(`no template named ${templateName}`);

  const unknown = Object.keys(values).filter((key) => !template.columns.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${templateName} has no column(s): ${unknown.join(', ')}`);
  }

  return template.columns.map((column) => values[column] ?? '').join(',');
}

const HAND_LOANS = [
  HAND_LOAN_HEADER,
  handLoanRow('Rajesh Sharma,,2025-04-01,,5000000,8.0,INR'),
  handLoanRow('Priya Menon,,2025-07-15,,1200000,9.5,INR'),
].join('\n');

const REAL_ESTATE = [
  'property_name,purchase_date,purchase_price,stamp_duty,registration_fee,currency',
  'Whitefield flat,2024-06-10,9500000,570000,30000,INR',
].join('\n');

const CASH = ['account_label,as_of_date,balance,currency', 'Salary account,2026-03-31,412500,INR'].join(
  '\n',
);

describe('US-4.6 Scenario: A template is identified by its header', () => {
  it('recognises each template from its columns alone', () => {
    for (const template of TemplateRegistry.definitions()) {
      const csv = TemplateRegistry.generate(template.name);
      expect(TemplateRegistry.detect(csv)?.name).toBe(template.name);
    }
  });

  it('refuses a header that matches no template, naming what it saw', () => {
    const result = TemplateParser.parse('alpha,beta,gamma\n1,2,3\n', 'mystery.csv');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEMPLATE_HEADER_MISMATCH');
      expect(result.error.message).toContain('alpha');
    }
  });

  it('does not match a template with an extra column', () => {
    // A subset match would silently ignore whatever the user added.
    const csv = `${HAND_LOAN_HEADER},guarantor_name\n`;
    expect(TemplateRegistry.detect(csv)).toBeUndefined();
  });
});

describe('US-4.6 Scenario: Naming the template buys a better error', () => {
  const CASH = 'account_label,as_of_date,balance,currency\nSavings,2026-03-31,50000,INR\n';

  it('imports normally when the declared template matches', async () => {
    const report = expectOk(
      await Pipeline.ingest({
        file: Buffer.from(CASH),
        fileName: 'cash.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
        templateName: 'Custom_Cash',
      }),
    );
    expect(report.created).toBe(1);
  });

  it('names the exact columns at fault instead of "matches no template"', async () => {
    const missingBalance = 'account_label,as_of_date,currency\nSavings,2026-03-31,INR\n';
    const result = await Pipeline.ingest({
      file: Buffer.from(missingBalance),
      fileName: 'cash.csv',
      parser: 'TEMPLATE',
      mode: 'STRICT',
      templateName: 'Custom_Cash',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Actionable for someone editing a spreadsheet, which "no template
      // matches this header" is not.
      expect(result.error.message).toContain('balance');
      expect(result.error.message).toContain('Custom_Cash');
    }
  });

  it('refuses a file uploaded under the wrong template', async () => {
    // Without the declaration this imports cleanly — as a bank balance, which
    // is the wrong asset class and therefore the wrong tax treatment.
    const result = await Pipeline.ingest({
      file: Buffer.from(CASH),
      fileName: 'cash.csv',
      parser: 'TEMPLATE',
      mode: 'STRICT',
      templateName: 'Custom_HandLoans',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TEMPLATE_HEADER_MISMATCH');
  });

  it('still detects from the header when no template is declared', async () => {
    const report = expectOk(
      await Pipeline.ingest({
        file: Buffer.from(CASH),
        fileName: 'cash.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      }),
    );
    expect(report.created).toBe(1);
  });

  it('rejects a template name it does not know', async () => {
    const result = await Pipeline.ingest({
      file: Buffer.from(CASH),
      fileName: 'cash.csv',
      parser: 'TEMPLATE',
      mode: 'STRICT',
      templateName: 'Custom_Invented',
    });
    expect(result.ok).toBe(false);
  });
});

describe('US-4.6 Scenario: A downloaded template can be filled in and imported unchanged', () => {
  it('keeps its guidance comments out of the data', () => {
    const csv = TemplateRegistry.generate('Custom_Cash');
    expect(csv).toContain('# portTrack template: Custom_Cash');

    const filled = `${csv}Salary account,2026-03-31,412500,INR\n`;
    const rows = expectOk(TemplateParser.parse(filled, 'cash.csv'));
    // Six comment lines and one data row: exactly one transaction, not seven.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.assetClass).toBe('BANK_BALANCE');
  });
});

describe('US-4.6 Scenario: Each template maps to its real asset class and fields', () => {
  it('parses borrower details, principal, interest rate and start date', () => {
    const rows = expectOk(TemplateParser.parse(HAND_LOANS, 'hand-loans.csv'));
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first?.assetClass).toBe('HAND_LOAN');
    expect(first?.pricePerUnit.amount).toBe('5000000');
    expect(first?.handLoan?.interestRatePct).toBe('8.0');
    expect(first?.handLoan?.interestBasis).toBe('SIMPLE');
    expect(first?.handLoan?.startDate).toBe('2025-04-01');
  });

  it('identifies the loan by an opaque reference, never by the name', () => {
    const rows = expectOk(TemplateParser.parse(HAND_LOANS, 'hand-loans.csv'));

    /*
     * The name IS carried now — the register is filtered and sorted by it, and a
     * list of `brw_85e56cdc` is unusable. What must not happen is the name
     * becoming the asset's identity: `symbol` feeds the asset id, which appears
     * in snapshots and exports, so it stays the hash.
     */
    expect(rows[0]?.symbol).toMatch(/^brw_[0-9a-f]{16}$/);
    expect(rows[0]?.handLoan?.borrowerRef).toMatch(/^brw_[0-9a-f]{16}$/);
    expect(rows[0]?.handLoan?.borrowerName).toBe('Rajesh Sharma');
  });

  it('derives one reference per person, so their loans do not split', () => {
    const rows = expectOk(
      TemplateParser.parse(
        [
          HAND_LOAN_HEADER,
          handLoanRow('Rajesh Sharma,,2025-04-01,,5000000,8.0,INR'),
          handLoanRow('Rajesh Sharma,,2025-09-01,,1000000,8.0,INR'),
        ].join('\n'),
        'hand-loans.csv',
      ),
    );
    expect(rows[0]?.handLoan?.borrowerRef).toBe(rows[1]?.handLoan?.borrowerRef);
  });

  it('reads the loan history a spreadsheet keeps in fixed payment columns', () => {
    const csv = [
      HAND_LOAN_HEADER,
      // borrower, notes, loan_date, closed, amount, rate, currency, status,
      // then two principal repayments and four interest payments.
      'Rajesh Sharma,House deposit,2025-04-01,,1200000,12,INR,Partially Repaid,' +
        '600000,2025-10-01,,,' +
        '36000,2025-07-01,36000,2025-10-01,,,,,' +
        ',,,,',
    ].join('\n');

    const rows = expectOk(TemplateParser.parse(csv, 'loans.csv'));
    const loan = rows[0]?.handLoan;

    expect(loan?.notes).toBe('House deposit');
    expect(loan?.principalRepayments).toHaveLength(1);
    expect(loan?.principalRepayments[0]?.amount.amount).toBe('600000');
    expect(loan?.interestPayments).toHaveLength(2);
    // A blank pair is skipped, not read as a zero payment.
    expect(loan?.interestPayments.map((p) => p.date)).toEqual(['2025-07-01', '2025-10-01']);
  });

  it('reconstructs the repayment behind a bare "Repaid" status', () => {
    // The sheet records the word but not the amount or date; without this the
    // loan would show its full principal outstanding, contradicting its own row.
    const csv = [
      HAND_LOAN_HEADER,
      handLoanRow('Anil Kumar,,2025-01-01,2025-07-01,400000,12,INR,Repaid'),
    ].join('\n');

    const rows = expectOk(TemplateParser.parse(csv, 'loans.csv'));
    expect(rows[0]?.handLoan?.declaredStatus).toBe('REPAID');
    expect(rows[0]?.handLoan?.closedDate).toBe('2025-07-01');
  });

  it('adds stamp duty and registration to the cost of a property', () => {
    const rows = expectOk(TemplateParser.parse(REAL_ESTATE, 'property.csv'));
    expect(rows[0]?.assetClass).toBe('REAL_ESTATE');
    expect(rows[0]?.pricePerUnit.amount).toBe('9500000');
    expect(rows[0]?.otherCharges?.amount).toBe('570000');
    expect(rows[0]?.fees?.amount).toBe('30000');
  });

  it('reads a cash balance as a bank balance', () => {
    const rows = expectOk(TemplateParser.parse(CASH, 'cash.csv'));
    expect(rows[0]?.assetClass).toBe('BANK_BALANCE');
    expect(rows[0]?.pricePerUnit.amount).toBe('412500');
  });

  it('honours the currency column', () => {
    const csv = 'account_label,as_of_date,balance,currency\nUS savings,2026-03-31,5000,USD\n';
    const rows = expectOk(TemplateParser.parse(csv, 'cash.csv'));
    expect(rows[0]?.pricePerUnit.currency).toBe('USD');
  });
});

describe('US-4.6 Scenario: A bad cell is reported with its row and column', () => {
  it('rejects an unrecognised status without losing the good rows', async () => {
    const csv = [
      HAND_LOAN_HEADER,
      handLoanRow('Good Borrower,,2025-04-01,,100000,8,INR,Active'),
      handLoanRow('Bad Borrower,,2025-04-01,,100000,8,INR,Someday'),
    ].join('\n');

    const report = expectOk(
      await Pipeline.ingest({
        file: Buffer.from(csv),
        fileName: 'loans.csv',
        parser: 'TEMPLATE',
        mode: 'LENIENT',
      }),
    );

    expect(report.rejected).toBe(1);
    expect(report.errors[0]?.column).toBe('status');
    expect(report.errors[0]?.expectedFormat).toContain('Active');
    expect(report.created).toBe(1);
  });

  it('rejects a payment amount with no date rather than guessing when it landed', async () => {
    // A payment placed on the wrong date changes the interest, so a missing date
    // is refused rather than defaulted to the loan date.
    const csv = [
      HAND_LOAN_HEADER,
      handLoanRow('A Borrower,,2025-04-01,,100000,8,INR,Active,,,,,25000'),
    ].join('\n');

    const report = expectOk(
      await Pipeline.ingest({
        file: Buffer.from(csv),
        fileName: 'loans.csv',
        parser: 'TEMPLATE',
        mode: 'LENIENT',
      }),
    );
    expect(report.rejected).toBe(1);
    expect(report.errors[0]?.column).toBe('date_1');
  });

  it('is atomic in STRICT mode', async () => {
    const csv = [
      'account_label,as_of_date,balance,currency',
      'Good,2026-03-31,1000,INR',
      'Bad,not-a-date,1000,INR',
    ].join('\n');

    const report = expectOk(
      await Pipeline.ingest({
        file: Buffer.from(csv),
        fileName: 'cash.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      }),
    );
    expect(report.committed).toBe(false);
    expect(report.created).toBe(0);
  });
});

describe('US-4.6 Scenario: Template rows become the right assets on the ledger', () => {
  it('builds a hand loan carrying its terms', () => {
    const rows = expectOk(TemplateParser.parse(HAND_LOANS, 'hand-loans.csv'));
    const projected = expectOk(LedgerProjector.project({ transactions: rows, parser: 'TEMPLATE' }));

    expect(projected.unapplied).toHaveLength(0);
    expect(projected.assets).toHaveLength(2);

    const loan = projected.assets[0];
    expect(loan?.assetClass).toBe('HAND_LOAN');
    expect(loan?.jurisdiction).toBe('DOMESTIC');
    expect(loan?.handLoan?.principal.amount).toBe('5000000');
    expect(loan?.handLoan?.interestBasis).toBe('SIMPLE');
    expect(loan?.handLoan?.startDate).toBe('2025-04-01');
  });

  it('builds a property whose cost includes duty and registration', () => {
    const rows = expectOk(TemplateParser.parse(REAL_ESTATE, 'property.csv'));
    const projected = expectOk(LedgerProjector.project({ transactions: rows, parser: 'TEMPLATE' }));

    const lot = projected.assets[0]?.lots[0];
    expect(projected.assets[0]?.assetClass).toBe('REAL_ESTATE');
    expect(lot?.otherCharges.amount).toBe('570000');
    expect(lot?.fees.amount).toBe('30000');
  });

  it('places each template on the ledger rather than rejecting it', () => {
    // The regression that prompted this: every TEMPLATE row came back unapplied
    // because the parser could not say what asset class it held.
    for (const template of TemplateRegistry.definitions()) {
      const header = TemplateRegistry.generate(template.name);
      const sample: Readonly<Record<string, string>> = {
        Custom_HandLoans: handLoanRow('A Borrower,,2025-04-01,,100000,8,INR,Active'),
        /*
         * Built from the template's own columns rather than typed positionally.
         * Custom_RealEstate has grown twice, and each time a hand-written row
         * silently shifted every value one column left — the failure that
         * produces is "no asset", which reads as a projector bug.
         */
        Custom_RealEstate: rowFor('Custom_RealEstate', {
          property_name: 'A flat',
          property_type: 'FLAT',
          transaction_type: 'BUY',
          purchase_date: '2024-06-10',
          area: '1450',
          area_unit: 'SQ_FT',
          purchase_price: '9500000',
          stamp_duty: '570000',
          registration_fee: '30000',
          city: 'Bengaluru',
          state: 'Karnataka',
          currency: 'INR',
        }),
        Custom_Cash: 'An account,2026-03-31,412500,INR',
        /*
         * By column name too: this template carries ten optional columns, and a
         * positional row would shift the moment one is added — which shows up as
         * "no asset", the same misleading failure the property row produces.
         */
        Custom_Balances: rowFor('Custom_Balances', {
          asset_class: 'FIXED_DEPOSIT',
          account_label: 'HDFC FD 7.1%',
          institution: 'HDFC Bank',
          balance: '500000',
          true_as_at: '2025-04-01',
          currency: 'INR',
          interest_rate_pct: '7.1',
          compounding: 'QUARTERLY',
        }),
        Custom_ChitFunds: 'A chit,2025-04-01,10000,24,INR',
        Custom_UnlistedShares: 'A company,2025-01-15,1000,250,INR',
        Custom_GenericBroker: '2025-01-01,ACME,INE000000001,buy,10,100,INR',
      };

      const rows = expectOk(
        TemplateParser.parse(`${header}${sample[template.name] ?? ''}\n`, `${template.name}.csv`),
      );
      const projected = expectOk(
        LedgerProjector.project({ transactions: rows, parser: 'TEMPLATE' }),
      );

      expect(projected.unapplied, `${template.name} produced unapplied rows`).toHaveLength(0);
      expect(projected.assets, `${template.name} produced no asset`).toHaveLength(1);
      expect(projected.assets[0]?.assetClass).toBe(template.assetClass);
    }
  });
});
