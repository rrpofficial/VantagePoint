/**
 * US-8.3 — Asset and liability repositories.
 *
 * The point of these tests is the ROUND TRIP, not the insert. A repository that
 * writes without error but reads back a lossy Asset is worse than one that
 * fails, because the loss surfaces as an understated cost basis months later.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRepository, LiabilityRepository, Vault } from '@vantagepoint/persistence';
import type { Asset, Liability } from '@vantagepoint/core-domain';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-repo-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
});

const inr = (amount: string) => ({ amount, currency: 'INR' as const });
const usd = (amount: string) => ({ amount, currency: 'USD' as const });

const plainAsset: Asset = {
  assetId: 'ast_domestic_equity_0001',
  assetClass: 'DOMESTIC_EQUITY',
  jurisdiction: 'DOMESTIC',
  currency: 'INR',
  symbol: 'TCS',
  isin: 'INE467B01029',
  lots: [
    {
      lotId: 'lot_0001',
      acquisitionDate: '2025-01-01',
      settlementDate: '2025-01-03',
      quantity: '10',
      remainingQuantity: '10',
      costPerUnit: inr('1000.25'),
      fees: inr('12.50'),
      stt: inr('1.00'),
      otherCharges: inr('0'),
    },
  ],
  incomeEvents: [],
  corporateActions: [],
};

describe('US-8.3 Scenario: An asset survives a save and reload unchanged', () => {
  it('round-trips a plain domestic holding', async () => {
    expectOk(await AssetRepository.save(plainAsset));
    expect(await AssetRepository.findById(plainAsset.assetId)).toEqual(plainAsset);
  });

  it('round-trips dual FX rates with independent provenance (ADR-003)', async () => {
    const foreign: Asset = {
      assetId: 'ast_foreign_equity_0001',
      assetClass: 'FOREIGN_EQUITY',
      jurisdiction: 'FOREIGN',
      currency: 'USD',
      symbol: 'AAPL',
      lots: [
        {
          lotId: 'lot_f_0001',
          acquisitionDate: '2025-06-02',
          settlementDate: '2025-06-04',
          quantity: '5',
          remainingQuantity: '5',
          costPerUnit: usd('190.10'),
          fees: usd('1.00'),
          stt: usd('0'),
          otherCharges: usd('0'),
          fx: {
            valuationRate: '83.12',
            taxRate: '82.90',
            valuationRateSource: 'SBI_ITBR',
            // Deliberately different from the valuation source: one column cannot
            // express this, which is why migration 2 added a second.
            taxRateSource: 'RBI_REFERENCE',
            isFallback: true,
            fallbackNote: 'no ITBR published for the tax reference date',
          },
        },
      ],
      incomeEvents: [],
      corporateActions: [],
    };

    expectOk(await AssetRepository.save(foreign));
    const reloaded = await AssetRepository.findById(foreign.assetId);
    expect(reloaded).toEqual(foreign);
    expect(reloaded?.lots[0]?.fx?.taxRateSource).toBe('RBI_REFERENCE');
    expect(reloaded?.lots[0]?.fx?.valuationRateSource).toBe('SBI_ITBR');
  });

  it('round-trips income events and corporate actions', async () => {
    const withHistory: Asset = {
      ...plainAsset,
      assetId: 'ast_domestic_equity_0002',
      incomeEvents: [
        {
          eventId: 'inc_0001',
          assetId: 'ast_domestic_equity_0002',
          kind: 'DIVIDEND_DOMESTIC',
          date: '2025-07-15',
          grossAmount: inr('1200'),
          taxWithheld: inr('120'),
          netAmount: inr('1080'),
          eligibleForForeignTaxCredit: false,
        },
      ],
      corporateActions: [
        {
          actionId: 'ca_0001',
          assetId: 'ast_domestic_equity_0002',
          kind: 'SPLIT',
          recordDate: '2025-09-01',
          ratio: { from: '1', to: '5' },
        },
      ],
    };

    expectOk(await AssetRepository.save(withHistory));
    expect(await AssetRepository.findById(withHistory.assetId)).toEqual(withHistory);
  });

  it('round-trips a hand loan with its repayments', async () => {
    const loan: Asset = {
      assetId: 'ast_hand_loan_0001',
      assetClass: 'HAND_LOAN',
      jurisdiction: 'DOMESTIC',
      currency: 'INR',
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      liquidity: 'ILLIQUID',
      handLoan: {
        assetId: 'ast_hand_loan_0001',
        borrowerRef: 'brw_9f2c',
        principal: inr('5000000'),
        interestRatePct: '8',
        interestBasis: 'SIMPLE',
        startDate: '2025-04-01',
        repayments: [
          {
            date: '2025-10-01',
            principal: inr('500000'),
            paymentId: 'ast_hand_loan_0001_rep_0000',
          },
        ],
        interestPayments: [],
      },
    };

    expectOk(await AssetRepository.save(loan));
    expect(await AssetRepository.findById(loan.assetId)).toEqual(loan);
  });

  it('round-trips the register fields: borrower name, notes, closing date', async () => {
    const loan: Asset = {
      assetId: 'ast_hand_loan_0002',
      assetClass: 'HAND_LOAN',
      jurisdiction: 'DOMESTIC',
      currency: 'INR',
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      liquidity: 'ILLIQUID',
      handLoan: {
        assetId: 'ast_hand_loan_0002',
        borrowerRef: 'brw_9f2c',
        // Held only here, in the encrypted database. Exports carry the ref.
        borrowerName: 'Rajesh Sharma',
        notes: 'Lent for a house deposit; repaying after the sale completes.',
        closedDate: '2026-03-31',
        principal: inr('5000000'),
        interestRatePct: '8',
        interestBasis: 'SIMPLE',
        startDate: '2025-04-01',
        repayments: [
          {
            date: '2025-10-01',
            principal: inr('500000'),
            paymentId: 'rep_a',
            mode: 'BANK_TRANSFER',
            notes: 'NEFT, partial',
          },
        ],
        interestPayments: [
          { paymentId: 'int_a', date: '2025-07-01', amount: inr('100000'), mode: 'UPI' },
          {
            paymentId: 'int_b',
            date: '2025-10-01',
            amount: inr('100000'),
            mode: 'CASH',
            notes: 'Handed over in person',
          },
        ],
      },
    };

    expectOk(await AssetRepository.save(loan));
    expect(await AssetRepository.findById(loan.assetId)).toEqual(loan);
  });

  it('keeps interest payments distinct from principal repayments', async () => {
    const loan: Asset = {
      assetId: 'ast_hand_loan_0003',
      assetClass: 'HAND_LOAN',
      jurisdiction: 'DOMESTIC',
      currency: 'INR',
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      liquidity: 'ILLIQUID',
      handLoan: {
        assetId: 'ast_hand_loan_0003',
        borrowerRef: 'brw_x',
        principal: inr('1000000'),
        interestRatePct: '12',
        interestBasis: 'SIMPLE',
        startDate: '2025-04-01',
        repayments: [],
        interestPayments: [
          { paymentId: 'int_1', date: '2025-07-01', amount: inr('30000'), mode: 'UPI' },
        ],
      },
    };

    expectOk(await AssetRepository.save(loan));
    const reloaded = await AssetRepository.findById(loan.assetId);

    // Stored in separate tables so nothing can sum them together — an interest
    // payment counted as repayment would silently write off principal.
    expect(reloaded?.handLoan?.repayments).toHaveLength(0);
    expect(reloaded?.handLoan?.interestPayments).toHaveLength(1);
  });
});

describe('US-8.3 Scenario: Re-saving an asset replaces its children', () => {
  it('does not leave a superseded lot behind', async () => {
    expectOk(await AssetRepository.save(plainAsset));

    const withFewerLots: Asset = { ...plainAsset, lots: [] };
    expectOk(await AssetRepository.save(withFewerLots));

    const reloaded = await AssetRepository.findById(plainAsset.assetId);
    // A diffing implementation would report 1 here, and the stale lot would
    // inflate the cost basis of a position the user believes they closed.
    expect(reloaded?.lots).toHaveLength(0);
  });
});

describe('US-8.3 Scenario: A locked vault yields no ledger data', () => {
  it('returns an empty ledger rather than throwing', async () => {
    expectOk(await AssetRepository.save(plainAsset));
    await Vault.lock();

    expect(await AssetRepository.all()).toEqual([]);
    expect(await AssetRepository.findById(plainAsset.assetId)).toBeUndefined();
    expect(await LiabilityRepository.all()).toEqual([]);
  });

  it('refuses a write', async () => {
    await Vault.lock();
    const result = await AssetRepository.save(plainAsset);
    expect(result.ok).toBe(false);
  });
});

describe('US-8.3 Scenario: Liabilities round-trip', () => {
  it('saves and reloads a home loan', async () => {
    const liability: Liability = {
      liabilityId: 'lia_0001',
      kind: 'HOME_LOAN',
      principalOutstanding: inr('3750000.55'),
      interestRatePct: '8.65',
      asOf: '2026-03-31',
    };
    expectOk(await LiabilityRepository.save(liability));
    expect(await LiabilityRepository.all()).toEqual([liability]);
  });

  it('upserts rather than duplicating on re-save', async () => {
    const liability: Liability = {
      liabilityId: 'lia_0002',
      kind: 'PERSONAL_LOAN',
      principalOutstanding: inr('100000'),
      interestRatePct: '11',
      asOf: '2026-03-31',
    };
    expectOk(await LiabilityRepository.save(liability));
    expectOk(await LiabilityRepository.save({ ...liability, principalOutstanding: inr('90000') }));

    const all = await LiabilityRepository.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.principalOutstanding.amount).toBe('90000');
  });
});

describe('US-8.3 Scenario: Money never round-trips through a float', () => {
  it('preserves a decimal string exactly (ADR-002)', async () => {
    const exact = '1234567.891234567890123';
    expectOk(
      await AssetRepository.save({
        ...plainAsset,
        assetId: 'ast_precision',
        lots: [{ ...plainAsset.lots[0]!, costPerUnit: inr(exact) }],
      }),
    );
    const reloaded = await AssetRepository.findById('ast_precision');
    expect(reloaded?.lots[0]?.costPerUnit.amount).toBe(exact);
  });
});
