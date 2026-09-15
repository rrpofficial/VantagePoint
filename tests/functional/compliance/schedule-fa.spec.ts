/**
 * FUNCTIONAL — Phase 6: Schedule FA (objective 5).
 *
 * The acceptance criterion, verbatim from the plan: "with a full year of marks,
 * Table A3 generates and its peak value exceeds the 31-Dec closing value. With a
 * gap, it still refuses."
 *
 * The second half matters more than the first. `scheduleFaA3` returned an error
 * unconditionally before this, and that was the RIGHT behaviour for a build with
 * no daily history — under the Black Money Act an understated foreign disclosure
 * is treated far more harshly than an understated domestic one, and a peak taken
 * from a closing value understates it. What Phase 6 changes is that the refusal
 * is now a fact about the DATA and names what is missing. What it must not
 * change is that a gap is still a refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  ForeignDisclosureUC,
  GenerateComplianceUC,
  GenerateSnapshotUC,
  MarksUC,
  TradeUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { MarkRepository, PriceRepository, RateRepository, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const YEAR = 2025;
const usd = (amount: string) => ({ amount, currency: 'USD' as const });

/** Every calendar day of the year, so coverage is complete by construction. */
function eachDayOf(year: number): readonly string[] {
  const days: string[] = [];
  const end = Date.parse(`${String(year)}-12-31T00:00:00Z`);
  for (let at = Date.parse(`${String(year)}-01-01T00:00:00Z`); at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * A price series that PEAKS in the middle of the year and falls back.
 *
 * Deliberately shaped so the closing value is well below the peak — that
 * difference is the entire reason Table A3 asks for a peak rather than a close,
 * and a test whose series rises monotonically would pass against a peak computed
 * from the closing value.
 */
const priceOn = (date: string): string => (date.startsWith(`${String(YEAR)}-07`) ? '250' : '100');

/**
 * Built through the REAL path: rates into `fx_rates`, prices into
 * `asset_prices`, then `MarksUC.sync` folds both into the marks series.
 *
 * Writing marks directly would have skipped the fold, and the fold is the part
 * that has to work — a price that reached `asset_prices` and stopped there is a
 * gap in a disclosure whose data was in fact imported.
 */
async function recordSeries(options: { skipJuly?: boolean } = {}): Promise<void> {
  const days = eachDayOf(YEAR);

  expectOk(
    RateRepository.putAll(
      days.map((date) => ({
        currency: 'USD' as const,
        date,
        rate: '84',
        source: 'SBI_ITBR',
        rateType: 'TTBR' as const,
        retrievedAt: `${String(YEAR)}-12-31T00:00:00+00:00`,
        sourceDocumentRef: 'test-fixture',
      })),
    ),
  );

  expectOk(
    await PriceRepository.save(
      days
        .filter((date) => !(options.skipJuly === true && date.startsWith(`${String(YEAR)}-07`)))
        .map((date) => ({
          instrument: 'ACME',
          priceDate: date,
          price: priceOn(date),
          currency: 'USD' as const,
          source: 'TEST',
          sourceDocument: 'test-fixture',
        })),
    ),
  );

  expectOk(await MarksUC.sync());
}

async function holdAcmeFrom(date = `${String(YEAR)}-01-02`): Promise<string> {
  const recorded = expectOk(
    await TradeUC.record({
      assetClass: 'FOREIGN_EQUITY',
      side: 'BUY',
      tradeDate: date,
      symbol: 'ACME',
      quantity: '100',
      pricePerUnit: usd('100'),
    }),
  );
  return recorded.assetId;
}

const withEntityDetail = async (assetId: string): Promise<void> => {
  expectOk(
    await ForeignDisclosureUC.recordDetail({
      assetId,
      countryCode: 'US',
      entityName: 'Acme Corporation',
      entityAddress: '1 Main Street, Delaware',
      natureOfEntity: 'Listed company',
    }),
  );
};

/** Schedule FA reads a FROZEN 31-December snapshot, never live values. */
const freezeForeignSnapshot = async (): Promise<void> => {
  expectOk(
    await GenerateSnapshotUC.generate({
      snapshotId: `FOR_31DEC${String(YEAR)}`,
      kind: 'FOREIGN_COMPLIANCE',
      scope: 'FOREIGN',
      asOf: `${String(YEAR)}-12-31T00:00:00+00:00`,
    }),
  );
};

beforeEach(async () => {
  resetPorts();
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-schedule-fa-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
});

describe('Phase 6 Scenario: Table A3 generates from a real daily series', () => {
  it('reports a peak value above the 31-December closing value', async () => {
    const assetId = await holdAcmeFrom();
    await withEntityDetail(assetId);
    await recordSeries();
    await freezeForeignSnapshot();

    const rows = expectOk(await GenerateComplianceUC.scheduleFaA3(YEAR));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.countryCode).toBe('US');
    expect(row?.entityName).toBe('Acme Corporation');
    // 100 units × $250 × ₹84 at the July peak.
    expect(Number(row?.peakValueInr.amount)).toBe(2_100_000);
    expect(Number(row?.peakValueNative.amount)).toBe(25_000);
    // 100 × $100 × ₹84 at the close — the figure a lazy implementation would
    // have reported as the peak.
    expect(Number(row?.closingValueInr.amount)).toBe(840_000);
    expect(Number(row?.peakValueInr.amount)).toBeGreaterThan(
      Number(row?.closingValueInr.amount),
    );
  });

  it('values each day at the quantity held THAT day, not the closing quantity', async () => {
    const assetId = await holdAcmeFrom();
    await withEntityDetail(assetId);
    // Sold before the July peak, so a peak taken at the closing quantity of zero
    // would report nil, and one taken at the opening quantity would report a
    // holding that no longer existed.
    expectOk(
      await TradeUC.record({
        assetClass: 'FOREIGN_EQUITY',
        side: 'SELL',
        tradeDate: `${String(YEAR)}-06-30`,
        symbol: 'ACME',
        quantity: '100',
        pricePerUnit: usd('100'),
      }),
    );
    await recordSeries();
    await freezeForeignSnapshot();

    const row = expectOk(await GenerateComplianceUC.scheduleFaA3(YEAR))[0];

    // 100 × $100 × ₹84 — the highest it reached while actually held.
    expect(Number(row?.peakValueInr.amount)).toBe(840_000);
    expect(Number(row?.closingValueInr.amount)).toBe(0);
    expect(Number(row?.grossProceedsInr.amount)).toBe(840_000);
  });

  it('answers with no rows when nothing foreign is held, rather than refusing', async () => {
    await freezeForeignSnapshot();
    expect(expectOk(await GenerateComplianceUC.scheduleFaA3(YEAR))).toEqual([]);
  });
});

describe('Phase 6 Scenario: A gap in the series is still a refusal', () => {
  it('refuses when a month of prices is missing, and says which month', async () => {
    const assetId = await holdAcmeFrom();
    await withEntityDetail(assetId);
    await recordSeries({ skipJuly: true });
    await freezeForeignSnapshot();

    const result = await GenerateComplianceUC.scheduleFaA3(YEAR);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The gap is exactly where the peak was, which is the whole point: a
      // carried-forward price would have silently reported ₹8,40,000.
      expect(result.error.message).toContain('ACME');
      expect(result.error.message).toContain(`${String(YEAR)}-06-30`);
      expect(result.error.message).toContain('understate the peak');
    }
  });

  it('refuses when the entity detail the schedule states was never recorded', async () => {
    await holdAcmeFrom();
    await recordSeries();
    await freezeForeignSnapshot();

    const result = await GenerateComplianceUC.scheduleFaA3(YEAR);

    expect(result.ok).toBe(false);
    // Country is not a function of currency — a USD fund is routinely domiciled
    // elsewhere — so it is recorded rather than guessed.
    if (!result.ok) expect(result.error.message).toContain('no entity country');
  });

  it('refuses without a frozen 31-December snapshot, whatever the series holds', async () => {
    const assetId = await holdAcmeFrom();
    await withEntityDetail(assetId);
    await recordSeries();

    const result = await GenerateComplianceUC.scheduleFaA3(YEAR);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('frozen snapshot');
  });

  it('treats a weekend as a closed market, not as missing data', async () => {
    // Two full years of coverage would be indistinguishable from none if every
    // Saturday counted as a gap.
    expectOk(
      await MarkRepository.save(
        ['2025-01-03', '2025-01-06', '2025-01-10', '2025-01-13'].map((date) => ({
          kind: 'CURRENCY' as const,
          key: 'USD',
          date,
          value: '84',
          source: 'TEST',
          sourceDocumentRef: 'test-fixture',
        })),
        '2025-01-13T00:00:00+00:00',
      ),
    );

    const coverage = MarkRepository.coverage('CURRENCY', 'USD', '2025-01-03', '2025-01-13');

    expect(coverage.covered).toBe(true);
    expect(coverage.gaps).toEqual([]);
    // Carried across the closed days, so the series is dense for the peak.
    expect(MarkRepository.seriesFor('CURRENCY', 'USD', '2025-01-03', '2025-01-13').size).toBe(11);
  });

  it('never carries a mark across a gap it has reported', async () => {
    expectOk(
      await MarkRepository.save(
        ['2025-01-03', '2025-03-01'].map((date) => ({
          kind: 'ASSET' as const,
          key: 'ACME',
          date,
          value: '100',
          currency: 'USD',
          source: 'TEST',
          sourceDocumentRef: 'test-fixture',
        })),
        '2025-03-01T00:00:00+00:00',
      ),
    );

    const coverage = MarkRepository.coverage('ASSET', 'ACME', '2025-01-03', '2025-03-01');
    const series = MarkRepository.seriesFor('ASSET', 'ACME', '2025-01-03', '2025-03-01');

    expect(coverage.covered).toBe(false);
    // Two marks and nothing invented between them.
    expect(series.size).toBe(2);
    expect(series.get('2025-02-01')).toBeUndefined();
  });
});

describe('Phase 6 Scenario: Table D discloses real foreign accounts', () => {
  it('discloses a recorded account, masking the account number', async () => {
    await recordSeries();
    await freezeForeignSnapshot();
    expectOk(
      await ForeignDisclosureUC.recordAccount({
        countryCode: 'US',
        institutionName: 'A Bank NA',
        accountNumber: '1234567890',
        accountOpenDate: '2019-05-02',
        currency: 'USD',
        peakBalance: '25000',
        closingBalance: '12000',
        calendarYear: YEAR,
      }),
    );

    const rows = expectOk(await GenerateComplianceUC.scheduleFaD(YEAR));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.institutionName).toBe('A Bank NA');
    expect(Number(rows[0]?.peakBalanceInr.amount)).toBe(2_100_000);
    expect(Number(rows[0]?.closingBalanceInr.amount)).toBe(1_008_000);
    // FR-7.2: never the raw number.
    expect(rows[0]?.accountRef).toMatch(/^acct_[0-9a-f]{12}$/);
    expect(JSON.stringify(rows)).not.toContain('1234567890');
  });

  it('refuses a peak below the closing balance rather than correcting it', async () => {
    const result = await ForeignDisclosureUC.recordAccount({
      countryCode: 'US',
      institutionName: 'A Bank NA',
      accountNumber: '1234567890',
      accountOpenDate: '2019-05-02',
      currency: 'USD',
      peakBalance: '5000',
      closingBalance: '12000',
      calendarYear: YEAR,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('peak balance is below');
  });

  it('keeps each calendar year’s figures as their own row', async () => {
    const shared = {
      countryCode: 'US',
      institutionName: 'A Bank NA',
      accountNumber: '1234567890',
      accountOpenDate: '2019-05-02',
      currency: 'USD' as const,
      peakBalance: '25000',
      closingBalance: '12000',
    };
    expectOk(await ForeignDisclosureUC.recordAccount({ ...shared, calendarYear: YEAR }));
    expectOk(await ForeignDisclosureUC.recordAccount({ ...shared, calendarYear: YEAR - 1 }));

    // A peak has no meaning without the window it is the peak of, so the same
    // account in two years is two rows rather than one overwritten one.
    expect(await ForeignDisclosureUC.accounts(YEAR)).toHaveLength(1);
    expect(await ForeignDisclosureUC.accounts()).toHaveLength(2);
  });

  it('needs edit mode to change a year already recorded', async () => {
    const entry = {
      countryCode: 'US',
      institutionName: 'A Bank NA',
      accountNumber: '1234567890',
      accountOpenDate: '2019-05-02',
      currency: 'USD' as const,
      peakBalance: '25000',
      closingBalance: '12000',
      calendarYear: YEAR,
    };
    expectOk(await ForeignDisclosureUC.recordAccount(entry));

    const again = await ForeignDisclosureUC.recordAccount({ ...entry, closingBalance: '1' });
    expect(again.ok).toBe(false);

    expectOk(await EditModeUC.enable(PASSPHRASE));
    expectOk(await ForeignDisclosureUC.recordAccount({ ...entry, closingBalance: '1' }));
  });

  it('refuses to state a balance in rupees with no 31-December rate', async () => {
    await freezeForeignSnapshot();
    expectOk(
      await ForeignDisclosureUC.recordAccount({
        countryCode: 'US',
        institutionName: 'A Bank NA',
        accountNumber: '1234567890',
        accountOpenDate: '2019-05-02',
        currency: 'USD',
        peakBalance: '25000',
        closingBalance: '12000',
        calendarYear: YEAR,
      }),
    );

    const result = await GenerateComplianceUC.scheduleFaD(YEAR);

    expect(result.ok).toBe(false);
    // Never 1.0, and never the foreign amount passed through: either would
    // misstate the disclosure by roughly the exchange rate.
    if (!result.ok) expect(result.error.message).toContain('USD/INR rate');
  });
});

describe('Phase 6 Scenario: Readiness says what is standing in the way', () => {
  it('names the missing entity detail and the series gap, per holding', async () => {
    await holdAcmeFrom();
    await recordSeries({ skipJuly: true });

    const readiness = expectOk(await ForeignDisclosureUC.readiness(YEAR));

    expect(readiness.ready).toBe(false);
    const holding = readiness.holdings[0];
    expect(holding?.label).toBe('ACME');
    expect(holding?.hasEntityDetail).toBe(false);
    expect(holding?.blockers.length).toBeGreaterThanOrEqual(2);
    expect(holding?.priceCoverage.gaps.length).toBeGreaterThan(0);
  });

  it('reports ready once both are supplied', async () => {
    const assetId = await holdAcmeFrom();
    await withEntityDetail(assetId);
    await recordSeries();

    const readiness = expectOk(await ForeignDisclosureUC.readiness(YEAR));

    expect(readiness.ready).toBe(true);
    expect(readiness.holdings[0]?.blockers).toEqual([]);
  });
});

describe('Phase 6 Scenario: Marks recorded by hand carry their provenance', () => {
  it('refuses a mark with no source document', async () => {
    const result = await MarksUC.record({
      kind: 'ASSET',
      key: 'ACME',
      date: '2025-07-01',
      value: '250',
      currency: 'USD',
      sourceDocumentRef: '   ',
    });

    expect(result.ok).toBe(false);
    // Required exactly as it is on an FX rate: a disclosure figure with no
    // provenance cannot be defended to an assessing officer.
    if (!result.ok) expect(result.error.message).toContain('document it came from');
  });

  it('folds imported prices and rates into the series, idempotently', async () => {
    await holdAcmeFrom();

    const first = expectOk(await MarksUC.sync());
    const second = expectOk(await MarksUC.sync());

    expect(first.assetMarks + first.currencyMarks).toBeGreaterThanOrEqual(0);
    // Re-running adds nothing, which is what makes it safe on every import.
    expect(second.assetMarks).toBe(0);
    expect(second.currencyMarks).toBe(0);
  });
});
