/**
 * What Schedule FA must say that a holding cannot (Phase 6, objective 5).
 *
 * Table A3 states the entity's country, name, address and nature. None of that
 * is derivable from a position: **country is not a function of currency** — a
 * USD-denominated fund is routinely domiciled in Ireland — and a wrong country
 * on a foreign disclosure is a defect in the disclosure, not a cosmetic one.
 *
 * So it is recorded, and A3 refuses for any foreign holding with no row here.
 * Refusing is the same call `scheduleFaA3` already made about peak value, for
 * the same reason.
 *
 * Table D's accounts are the other half: they were not modelled at all, so a
 * real foreign bank account read as "nothing to disclose".
 */
import { Err, Money, Ok, VaultStateError, type Currency, type IsoDate, type Money as MoneyValue, type Result } from '@porttrack/shared-kernel';
import { Vault } from './vault.js';

export interface ForeignHoldingDetail {
  readonly assetId: string;
  readonly countryCode: string;
  readonly entityName: string;
  readonly entityAddress: string;
  readonly natureOfEntity: string;
  readonly acquisitionDate?: IsoDate;
  readonly notes?: string;
}

export interface ForeignAccount {
  readonly accountId: string;
  readonly countryCode: string;
  readonly institutionName: string;
  /** Raw, and in the encrypted vault only. Masked before it reaches a row. */
  readonly accountNumber: string;
  readonly accountOpenDate: IsoDate;
  readonly currency: Currency;
  readonly peakBalance: MoneyValue;
  readonly closingBalance: MoneyValue;
  /** The calendar year the two balances describe. */
  readonly calendarYear: number;
  readonly status: 'OPEN' | 'CLOSED';
  readonly closedOn?: IsoDate;
  readonly notes?: string;
}

interface DetailRow {
  readonly asset_id: string;
  readonly country_code: string;
  readonly entity_name: string;
  readonly entity_address: string;
  readonly nature_of_entity: string;
  readonly acquisition_date: string | null;
  readonly notes: string | null;
}

interface AccountRow {
  readonly account_id: string;
  readonly country_code: string;
  readonly institution_name: string;
  readonly account_number: string;
  readonly account_open_date: string;
  readonly currency: string;
  readonly peak_balance: string;
  readonly closing_balance: string;
  readonly calendar_year: number;
  readonly status: string;
  readonly closed_on: string | null;
  readonly notes: string | null;
}

const locked = (): Result<never> => Err(new VaultStateError('vault is locked'));

const toDetail = (row: DetailRow): ForeignHoldingDetail => ({
  assetId: row.asset_id,
  countryCode: row.country_code,
  entityName: row.entity_name,
  entityAddress: row.entity_address,
  natureOfEntity: row.nature_of_entity,
  ...(row.acquisition_date === null ? {} : { acquisitionDate: row.acquisition_date }),
  ...(row.notes === null ? {} : { notes: row.notes }),
});

const toAccount = (row: AccountRow): ForeignAccount => ({
  accountId: row.account_id,
  countryCode: row.country_code,
  institutionName: row.institution_name,
  accountNumber: row.account_number,
  accountOpenDate: row.account_open_date,
  currency: row.currency as Currency,
  peakBalance: Money.fromStorage(row.peak_balance, row.currency as Currency),
  closingBalance: Money.fromStorage(row.closing_balance, row.currency as Currency),
  calendarYear: row.calendar_year,
  status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
  ...(row.closed_on === null ? {} : { closedOn: row.closed_on }),
  ...(row.notes === null ? {} : { notes: row.notes }),
});

export const ForeignDisclosureRepository = {
  saveDetail(detail: ForeignHoldingDetail): Promise<Result<void>> {
    if (!Vault.isUnlocked()) return Promise.resolve(locked());
    Vault.connection()
      .prepare(
        `INSERT INTO foreign_holding_disclosures
           (asset_id, country_code, entity_name, entity_address, nature_of_entity,
            acquisition_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           country_code = excluded.country_code,
           entity_name = excluded.entity_name,
           entity_address = excluded.entity_address,
           nature_of_entity = excluded.nature_of_entity,
           acquisition_date = excluded.acquisition_date,
           notes = excluded.notes`,
      )
      .run(
        detail.assetId,
        detail.countryCode,
        detail.entityName,
        detail.entityAddress,
        detail.natureOfEntity,
        detail.acquisitionDate ?? null,
        detail.notes ?? null,
      );
    return Promise.resolve(Ok(undefined));
  },

  details(): Promise<readonly ForeignHoldingDetail[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT * FROM foreign_holding_disclosures ORDER BY asset_id')
      .all() as DetailRow[];
    return Promise.resolve(rows.map(toDetail));
  },

  deleteDetail(assetId: string): Promise<Result<void>> {
    if (!Vault.isUnlocked()) return Promise.resolve(locked());
    Vault.connection()
      .prepare('DELETE FROM foreign_holding_disclosures WHERE asset_id = ?')
      .run(assetId);
    return Promise.resolve(Ok(undefined));
  },

  saveAccount(account: ForeignAccount): Promise<Result<void>> {
    if (!Vault.isUnlocked()) return Promise.resolve(locked());
    Vault.connection()
      .prepare(
        `INSERT INTO foreign_accounts
           (account_id, country_code, institution_name, account_number, account_open_date,
            currency, peak_balance, closing_balance, calendar_year, status, closed_on, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           country_code = excluded.country_code,
           institution_name = excluded.institution_name,
           account_number = excluded.account_number,
           account_open_date = excluded.account_open_date,
           currency = excluded.currency,
           peak_balance = excluded.peak_balance,
           closing_balance = excluded.closing_balance,
           calendar_year = excluded.calendar_year,
           status = excluded.status,
           closed_on = excluded.closed_on,
           notes = excluded.notes`,
      )
      .run(
        account.accountId,
        account.countryCode,
        account.institutionName,
        account.accountNumber,
        account.accountOpenDate,
        account.currency,
        account.peakBalance.amount,
        account.closingBalance.amount,
        account.calendarYear,
        account.status,
        account.closedOn ?? null,
        account.notes ?? null,
      );
    return Promise.resolve(Ok(undefined));
  },

  /** Every account, or only those describing one calendar year. */
  accounts(calendarYear?: number): Promise<readonly ForeignAccount[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const db = Vault.connection();
    const rows = (
      calendarYear === undefined
        ? db.prepare('SELECT * FROM foreign_accounts ORDER BY calendar_year DESC, institution_name')
            .all()
        : db
            .prepare(
              'SELECT * FROM foreign_accounts WHERE calendar_year = ? ORDER BY institution_name',
            )
            .all(calendarYear)
    ) as AccountRow[];
    return Promise.resolve(rows.map(toAccount));
  },

  deleteAccount(accountId: string): Promise<Result<void>> {
    if (!Vault.isUnlocked()) return Promise.resolve(locked());
    Vault.connection().prepare('DELETE FROM foreign_accounts WHERE account_id = ?').run(accountId);
    return Promise.resolve(Ok(undefined));
  },
};
