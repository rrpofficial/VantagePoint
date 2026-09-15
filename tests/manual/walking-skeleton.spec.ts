/**
 * Walking skeleton — drives every implemented package in one pass, on real data,
 * against a real encrypted database on disk.
 *
 * Not part of the acceptance suite; it exists to answer "does any of this
 * actually work yet?" without an application to click through.
 *
 *   npx vitest run tests/manual/walking-skeleton.spec.ts
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Money } from '@porttrack/shared-kernel';
import {
  AccrualEngine,
  AssetRegistry,
  FifoAllocator,
  LotBook,
  ValuationEngine,
  taxCharacterFor,
} from '@porttrack/core-domain';
import { DualRateConverter } from '@porttrack/fx-itbr';
import { CompliancePolicy, DeltaEngine, ReturnsCalculator, SnapshotFactory } from '@porttrack/snapshot';
import { MigrationRunner, Vault } from '@porttrack/persistence';
import { RegexRules } from '@porttrack/pii-masker';
import { createEgressGateway, createLogger } from '@porttrack/platform';
import {
  aForeignAsset,
  aHandLoan,
  aHandLoanAsset,
  anAsset,
  expectOk,
  inr,
  seedStandardRates,
  stubFx,
  stubPrices,
  usd,
} from '@porttrack/test-kit';

const log: string[] = [];
const say = (line: string) => log.push(line);

describe('portTrack walking skeleton', () => {
  it('runs the whole implemented stack end to end', async () => {
    /* 1 ─ encrypted vault on real disk ------------------------------------ */
    const dataDir = mkdtempSync(join(tmpdir(), 'porttrack-demo-'));
    expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
    const handle = expectOk(await Vault.unlock('correct horse battery staple'));
    const dbBytes = statSync(join(dataDir, 'vault.db')).size;
    const raw = readFileSync(join(dataDir, 'vault.db'), 'latin1');
    say(`VAULT      opened at ${dataDir}/vault.db (${String(dbBytes)} bytes)`);
    say(`           schema v${String(handle.schemaVersion)}, cipher AES-256-CBC+HMAC`);
    say(`           plaintext "hand_loans" present in file? ${String(raw.includes('hand_loans'))}`);
    say(`           starts with "SQLite format 3"?          ${String(raw.startsWith('SQLite format 3'))}`);
    expect(await MigrationRunner.currentVersion()).toBeGreaterThan(0);

    /* 2 ─ ledger: lots + FIFO -------------------------------------------- */
    const tcs = expectOk(AssetRegistry.register({ assetClass: 'DOMESTIC_EQUITY', currency: 'INR' }));
    const buy = expectOk(
      LotBook.recordAcquisition({
        assetClass: 'DOMESTIC_EQUITY',
        tradeDate: '2025-06-10',
        quantity: '100',
        pricePerUnit: inr('3850.00'),
        fees: inr('20.00'),
        stt: inr('385.00'),
        otherCharges: inr('5.50'),
      }),
    );
    say(`LEDGER     ${tcs.assetId} (${tcs.jurisdiction})`);
    say(`           100 TCS @ ₹3,850 → cost basis ₹${LotBook.totalCostBasis(buy).amount}`);

    const { allocations, updatedLots } = expectOk(FifoAllocator.allocate([buy], '40'));
    say(`FIFO       sold 40 → consumed lot ${allocations[0]?.lotId ?? ''}, ${updatedLots[0]?.remainingQuantity ?? ''} left`);

    /* 3 ─ dual-rate FX (ADR-003) ------------------------------------------ */
    seedStandardRates();
    const rates = expectOk(DualRateConverter.ratesFor('USD', '2026-02-15'));
    const converted = DualRateConverter.convert(usd('7200.00'), rates);
    say(`FX         $7,200 on 2026-02-15`);
    say(`           valuation @ ${rates.valuationRate} (${rates.valuationRateSource}) → ₹${converted.valuationInr.amount}`);
    say(`           taxable   @ ${rates.taxRate} (Rule 115, prior month-end)  → ₹${converted.taxableInr.amount}`);
    say(`           divergence ₹${Money.subtract(converted.valuationInr, converted.taxableInr).amount}`);

    /* 4 ─ accruals + mutual fund character -------------------------------- */
    const loan = aHandLoan();
    say(`ACCRUAL    ₹50,00,000 hand loan @8% → interest to 2026-03-31 ₹${AccrualEngine.handLoanAccruedInterest(loan, '2026-03-31').amount}`);
    say(`           gratuity, 12 yrs @ ₹2,00,000/mo → ₹${AccrualEngine.gratuity({ lastDrawnMonthly: inr('200000'), completedYears: 12 }).amount}`);
    say(`TAXCHAR    ARBITRAGE fund → ${taxCharacterFor('ARBITRAGE')} (not DEBT_ORIENTED)`);

    /* 5 ─ valuation at two points in time --------------------------------- */
    const assets = [anAsset({ assetId: 'ast_tcs' }), aForeignAsset(), aHandLoanAsset(loan)];
    const opening = ValuationEngine.value({
      assets,
      liabilities: [],
      asOf: '2025-03-31T23:59:59.999+05:30',
      prices: stubPrices({ TCS: inr('3850'), AAPL: usd('200') }),
      fx: stubFx({ USD: '80' }),
    });
    const closing = ValuationEngine.value({
      assets,
      liabilities: [],
      asOf: '2026-03-31T23:59:59.999+05:30',
      prices: stubPrices({ TCS: inr('4400'), AAPL: usd('240') }),
      fx: stubFx({ USD: '85' }),
    });
    say(`VALUATION  2025-03-31 net worth ₹${opening.netWorth.amount}`);
    say(`           2026-03-31 net worth ₹${closing.netWorth.amount}`);

    /* 6 ─ frozen compliance snapshot -------------------------------------- */
    const due = CompliancePolicy.dueSnapshots('2026-04-01T00:05:00.000+05:30', []);
    say(`SCHEDULER  due on 2026-04-01 → ${due.map((d) => d.snapshotId).join(', ') || '(none)'}`);

    const frozen = expectOk(
      SnapshotFactory.build({
        spec: due[0] ?? {
          snapshotId: 'DOM_31MAR2026',
          kind: 'DOMESTIC_COMPLIANCE',
          scope: 'DOMESTIC',
          asOf: '2026-03-31T23:59:59.999+05:30',
        },
        valuation: closing,
        createdAt: '2026-04-01T00:05:00.000+05:30',
      }),
    );
    say(`SNAPSHOT   ${frozen.snapshotId} frozen, ${String(frozen.positions.length)} domestic positions`);
    say(`           ${frozen.contentHash}`);
    say(`           immutable? ${String(SnapshotFactory.isImmutable(frozen))}`);

    /* 7 ─ variance with price/currency attribution ------------------------ */
    const report = DeltaEngine.compare(opening, closing);
    const aapl = report.positions.find((p) => p.assetId === 'ast_foreign_equity_0001');
    say(`VARIANCE   net worth ${report.netWorthDelta.amount} (${Number(report.netWorthDeltaPct).toFixed(2)}%)`);
    say(`           AAPL delta ₹${aapl?.valueDelta.amount ?? ''}`);
    say(`             ├─ price effect    ₹${aapl?.priceEffect?.amount ?? 'n/a'}`);
    say(`             └─ currency effect ₹${aapl?.currencyEffect?.amount ?? 'n/a'}`);

    const xirr = expectOk(
      ReturnsCalculator.xirr([
        { date: '2023-04-01', amount: inr('-100000') },
        { date: '2024-04-01', amount: inr('-50000') },
        { date: '2026-04-01', amount: inr('200000') },
      ]),
    );
    say(`RETURNS    XIRR ${xirr}%   CAGR ${ReturnsCalculator.cagr(inr('100000'), inr('200000'), '3')}%`);

    /* 8 ─ privacy: masking, PII-safe logging, default-deny egress ---------- */
    say(`PII        ${RegexRules.mask('PAN ABCDE1234F, DPID 1208160000123456').masked}`);

    const sink: string[] = [];
    createLogger({ sink: { write: (r) => void sink.push(r.message) }, now: () => '2026-08-03T00:00:00.000+05:30' })
      .info('processing PAN ABCDE1234F');
    say(`LOGGING    ${sink[0] ?? ''}`);

    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => Promise.resolve('should not happen'),
      now: () => '2026-08-03T00:00:00.000+05:30',
    });
    const blocked = await gateway.dispatch({ url: 'https://sbi.example/rates', purpose: 'FX_RATE' });
    say(`EGRESS     outbound blocked? ${String(!blocked.ok)}  audited? ${String(gateway.auditLog().length === 1)}`);

    /* 9 ─ persistence survives a lock/unlock cycle ------------------------ */
    await Vault.close();
    expectOk(await Vault.open({ dataDir, fileName: 'vault.db' }));
    const reopened = expectOk(await Vault.unlock('correct horse battery staple'));
    say(`REOPEN     vault unlocked again, schema v${String(reopened.schemaVersion)}`);
    const wrong = await Vault.unlock('wrong passphrase');
    say(`           wrong passphrase rejected? ${String(!wrong.ok)}`);
    await Vault.close();

     
    console.log(`\n${log.join('\n')}\n`);
    expect(log.length).toBeGreaterThan(20);
  });
});
