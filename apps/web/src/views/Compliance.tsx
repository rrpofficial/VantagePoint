/**
 * Compliance — Schedule FA and Schedule AL.
 *
 * Two distinctions are stated on screen because both are easy to get backwards
 * and expensive to get wrong: Schedule FA runs on the CALENDAR year, and
 * Schedule AL reports COST of acquisition rather than market value.
 *
 * Where a schedule cannot be produced, the reason is shown rather than an empty
 * table. An empty Schedule FA and an unavailable one look identical otherwise,
 * and under the Black Money Act an omitted foreign asset is treated far more
 * harshly than an understated domestic one.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type FaReadiness,
  type ForeignAccount,
  type ScheduleAl,
  type ScheduleAlSection,
  type ScheduleFa,
} from '../api.js';
import { Amount, Card, Chip } from '../components/primitives.js';
import { calendarYearLabel, financialYearLabel, usePeriods } from '../usePeriods.js';


/**
 * What Schedule FA needs that the ledger cannot supply (Phase 6).
 *
 * Table A3 refuses unless it has a complete daily price and rate series AND the
 * entity detail the schedule states. Refusing is correct — a peak taken from a
 * closing value understates a foreign disclosure, which is the expensive
 * direction under the Black Money Act — but a refusal the user cannot act on is
 * a wall. This card is the list of what to fix, per holding.
 */
function ForeignInputs({ calendarYear }: { calendarYear: number }) {
  const [readiness, setReadiness] = useState<FaReadiness | undefined>();
  const [accounts, setAccounts] = useState<readonly ForeignAccount[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [addingAccount, setAddingAccount] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (calendarYear === 0) return;
    const [ready, list] = await Promise.all([
      api.faReadiness(calendarYear),
      api.foreignAccounts(calendarYear),
    ]);
    if (ready.ok) setReadiness(ready.value);
    else setError(ready.error.message);
    if (list.ok) setAccounts(list.value.accounts);
  }, [calendarYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = useCallback(async (): Promise<void> => {
    setError(undefined);
    const result = await api.syncMarks();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setStatus(
      `Folded ${String(result.value.currencyMarks)} exchange rates and ` +
        `${String(result.value.assetMarks)} prices into the daily series.`,
    );
    await load();
  }, [load]);

  return (
    <Card
      title="Foreign disclosure inputs"
      action={
        <Chip>
          {readiness === undefined ? 'Loading' : readiness.ready ? 'Ready' : 'Incomplete'}
        </Chip>
      }
    >
      <p className="pt-muted">
        Table A3 reports the <strong>highest</strong> value each foreign holding reached during the
        calendar year, not its closing value. That needs a price and an exchange rate for every day
        it was held. portTrack has no market feed — the container has no route out — so the series
        is built from the statements you import and the rates already loaded, and anything missing
        is listed below rather than filled in with a guess.
      </p>

      <div className="pt-actions">
        <button
          type="button"
          className="pt-button-inline"
          data-testid="sync-marks"
          onClick={() => void sync()}
        >
          Rebuild the daily series from imported data
        </button>
      </div>

      {status !== undefined && (
        <p className="pt-banner" role="status" data-testid="marks-status">
          {status}
        </p>
      )}
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}

      <h3 className="pt-subhead">Holdings</h3>
      {readiness !== undefined && readiness.holdings.length === 0 ? (
        <p className="pt-muted">No foreign holdings, so Table A3 has nothing to report.</p>
      ) : (
        <ul className="pt-log" data-testid="fa-readiness">
          {(readiness?.holdings ?? []).map((holding) => (
            <li key={holding.assetId}>
              <strong>{holding.label}</strong> ({holding.currency}){' '}
              {holding.ready ? (
                <Chip>Ready</Chip>
              ) : (
                <>
                  <Chip>Incomplete</Chip>
                  <ul>
                    {holding.blockers.map((blocker, index) => (
                      <li key={index} className="pt-muted">
                        {blocker}
                      </li>
                    ))}
                  </ul>
                  {!holding.hasEntityDetail && (
                    <button
                      type="button"
                      className="pt-button-inline"
                      data-testid="add-entity-detail"
                      onClick={() => {
                        setEditing(editing === holding.assetId ? undefined : holding.assetId);
                      }}
                    >
                      Record the entity detail
                    </button>
                  )}
                </>
              )}
              {editing === holding.assetId && (
                <EntityDetailForm
                  assetId={holding.assetId}
                  onSaved={() => {
                    setEditing(undefined);
                    void load();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="pt-subhead">Foreign bank and custodial accounts</h3>
      <p className="pt-muted">
        Table D discloses these separately from holdings. The <strong>peak balance</strong> is read
        off your own statements — it is not derived from the closing balance, for the same reason a
        peak holding value is not.
      </p>
      {accounts.length === 0 ? (
        <p className="pt-muted" data-testid="no-foreign-accounts">
          None recorded for {calendarYear}.
        </p>
      ) : (
        <ul className="pt-log">
          {accounts.map((account) => (
            <li key={account.accountId}>
              {account.institutionName} · {account.countryCode} · peak{' '}
              <Amount value={account.peakBalance} /> · closing{' '}
              <Amount value={account.closingBalance} />
            </li>
          ))}
        </ul>
      )}
      <div className="pt-actions">
        <button
          type="button"
          className="pt-button-inline"
          data-testid="add-foreign-account"
          onClick={() => {
            setAddingAccount((open) => !open);
          }}
        >
          {addingAccount ? 'Close' : 'Add an account'}
        </button>
      </div>
      {addingAccount && (
        <ForeignAccountForm
          calendarYear={calendarYear}
          onSaved={() => {
            setAddingAccount(false);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function EntityDetailForm({ assetId, onSaved }: { assetId: string; onSaved: () => void }) {
  const [countryCode, setCountryCode] = useState('');
  const [entityName, setEntityName] = useState('');
  const [entityAddress, setEntityAddress] = useState('');
  const [natureOfEntity, setNatureOfEntity] = useState('Listed company');
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setError(undefined);
    const result = await api.recordForeignDetail({
      assetId,
      countryCode: countryCode.trim(),
      entityName: entityName.trim(),
      entityAddress: entityAddress.trim(),
      natureOfEntity: natureOfEntity.trim(),
    });
    if (result.ok) onSaved();
    else setError(result.error.message);
  }, [assetId, countryCode, entityName, entityAddress, natureOfEntity, onSaved]);

  return (
    <div className="pt-form pt-form--grid" data-testid="entity-detail-form">
      <label htmlFor={`country-${assetId}`}>Country code</label>
      <input
        id={`country-${assetId}`}
        value={countryCode}
        placeholder="e.g. US — where the ENTITY is, not the currency"
        onChange={(event) => {
          setCountryCode(event.target.value);
        }}
      />
      <label htmlFor={`entity-${assetId}`}>Entity name</label>
      <input
        id={`entity-${assetId}`}
        value={entityName}
        onChange={(event) => {
          setEntityName(event.target.value);
        }}
      />
      <label htmlFor={`address-${assetId}`}>Entity address</label>
      <input
        id={`address-${assetId}`}
        value={entityAddress}
        onChange={(event) => {
          setEntityAddress(event.target.value);
        }}
      />
      <label htmlFor={`nature-${assetId}`}>Nature of entity</label>
      <input
        id={`nature-${assetId}`}
        value={natureOfEntity}
        onChange={(event) => {
          setNatureOfEntity(event.target.value);
        }}
      />
      <div className="pt-actions pt-form__full">
        <button type="button" onClick={() => void submit()} data-testid="save-entity-detail">
          Save
        </button>
      </div>
      <p className="pt-muted pt-form__full">
        A USD-denominated fund is routinely domiciled outside the United States, so the country is
        recorded rather than inferred from the currency — a wrong country is a defect in the
        disclosure.
      </p>
      {error !== undefined && (
        <p className="pt-error pt-form__full" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ForeignAccountForm({
  calendarYear,
  onSaved,
}: {
  calendarYear: number;
  onSaved: () => void;
}) {
  const [countryCode, setCountryCode] = useState('');
  const [institutionName, setInstitutionName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountOpenDate, setAccountOpenDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [peakBalance, setPeakBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setError(undefined);
    const result = await api.recordForeignAccount({
      countryCode: countryCode.trim(),
      institutionName: institutionName.trim(),
      accountNumber: accountNumber.trim(),
      accountOpenDate,
      currency,
      peakBalance: peakBalance.trim(),
      closingBalance: closingBalance.trim(),
      calendarYear,
    });
    if (result.ok) onSaved();
    else setError(result.error.message);
  }, [
    countryCode,
    institutionName,
    accountNumber,
    accountOpenDate,
    currency,
    peakBalance,
    closingBalance,
    calendarYear,
    onSaved,
  ]);

  return (
    <div className="pt-form pt-form--grid" data-testid="foreign-account-form">
      <label htmlFor="fa-country">Country code</label>
      <input
        id="fa-country"
        value={countryCode}
        onChange={(event) => {
          setCountryCode(event.target.value);
        }}
      />
      <label htmlFor="fa-institution">Institution</label>
      <input
        id="fa-institution"
        value={institutionName}
        onChange={(event) => {
          setInstitutionName(event.target.value);
        }}
      />
      <label htmlFor="fa-account">Account number</label>
      <input
        id="fa-account"
        value={accountNumber}
        placeholder="stays in your vault; the disclosure carries a masked reference"
        onChange={(event) => {
          setAccountNumber(event.target.value);
        }}
      />
      <label htmlFor="fa-opened">Opened on</label>
      <input
        id="fa-opened"
        type="date"
        value={accountOpenDate}
        onChange={(event) => {
          setAccountOpenDate(event.target.value);
        }}
      />
      <label htmlFor="fa-currency">Currency</label>
      <input
        id="fa-currency"
        value={currency}
        onChange={(event) => {
          setCurrency(event.target.value.toUpperCase());
        }}
      />
      <label htmlFor="fa-peak">Peak balance in {calendarYear}</label>
      <input
        id="fa-peak"
        value={peakBalance}
        inputMode="decimal"
        onChange={(event) => {
          setPeakBalance(event.target.value);
        }}
      />
      <label htmlFor="fa-closing">Balance on 31 December</label>
      <input
        id="fa-closing"
        value={closingBalance}
        inputMode="decimal"
        onChange={(event) => {
          setClosingBalance(event.target.value);
        }}
      />
      <div className="pt-actions pt-form__full">
        <button type="button" onClick={() => void submit()} data-testid="save-foreign-account">
          Save
        </button>
      </div>
      {error !== undefined && (
        <p className="pt-error pt-form__full" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AlSection({ section }: { section: ScheduleAlSection }) {
  if (section.items.length === 0) return null;
  return (
    <>
      <tr className="pt-table__group">
        <th scope="rowgroup" colSpan={2}>
          {section.head}
        </th>
      </tr>
      {section.items.map((item, index) => (
        <tr key={`${section.head}-${String(index)}`}>
          <td>{item.description}</td>
          <td className="pt-align-end">
            <Amount value={item.costOfAcquisition} />
          </td>
        </tr>
      ))}
      <tr className="pt-table__total">
        <td>Total</td>
        <td className="pt-align-end">
          <Amount value={section.total} />
        </td>
      </tr>
    </>
  );
}

export function Compliance() {
  const periods = usePeriods();
  const [calendarYear, setCalendarYear] = useState(0);
  const [financialYear, setFinancialYear] = useState<string>('');
  const [fa, setFa] = useState<ScheduleFa | undefined>();
  const [al, setAl] = useState<ScheduleAl | undefined>();
  const [faError, setFaError] = useState<string | undefined>();
  const [alError, setAlError] = useState<string | undefined>();

  useEffect(() => {
    if (periods === undefined) return;
    // The current period is always OFFERED in the list — a user looking for
    // "this year" must find it. It is not the default, because a schedule is
    // filed for a period that has closed: Schedule FA reports the 31-December
    // position, which a running year has not reached.
    if (calendarYear === 0) setCalendarYear(periods.defaultCalendarYear);
    if (financialYear === '') setFinancialYear(periods.defaultFinancialYear);
  }, [periods, calendarYear, financialYear]);

  const selectedCalendarYear = periods?.calendarYears.find(
    (option) => option.calendarYear === calendarYear,
  );
  const selectedFinancialYear = periods?.financialYears.find(
    (option) => option.financialYear === financialYear,
  );

  const loadFa = useCallback(async (): Promise<void> => {
    setFaError(undefined);
    const result = await api.scheduleFa(calendarYear);
    if (result.ok) setFa(result.value);
    else {
      setFa(undefined);
      setFaError(result.error.message);
    }
  }, [calendarYear]);

  const loadAl = useCallback(async (): Promise<void> => {
    setAlError(undefined);
    const result = await api.scheduleAl(financialYear);
    if (result.ok) setAl(result.value);
    else {
      setAl(undefined);
      setAlError(result.error.message);
    }
  }, [financialYear]);

  return (
    <div className="pt-stack">
      <Card
        title="Schedule FA — foreign assets"
        action={
          <button type="button" className="pt-button-inline" onClick={() => void loadFa()}>
            Generate
          </button>
        }
      >
        <p className="pt-muted">
          <strong>Calendar year, not financial year.</strong> Schedule FA discloses 1 January to 31
          December, unlike every other figure in portTrack. It is generated from the frozen
          31-December snapshot, never from live values.
        </p>

        <div className="pt-controls">
          <label htmlFor="cy">Calendar year</label>
          <select
            id="cy"
            value={calendarYear}
            onChange={(event) => {
              setCalendarYear(Number(event.target.value));
            }}
          >
            {(periods?.calendarYears ?? []).map((option) => (
              <option key={option.calendarYear} value={option.calendarYear}>
                {calendarYearLabel(option)}
              </option>
            ))}
          </select>
        </div>

        {selectedCalendarYear?.isComplete === false && (
          <p className="pt-banner" role="status" data-testid="incomplete-calendar-year">
            {selectedCalendarYear.calendarYear} is still running. Schedule FA reports the position at
            31 December, so this year has no closing value until it ends — you would normally file
            for {selectedCalendarYear.calendarYear - 1}.
          </p>
        )}

        {faError !== undefined && (
          <p className="pt-error" role="alert">
            {faError}
          </p>
        )}

        {fa !== undefined && (
          <div data-testid="schedule-fa">
            <h3 className="pt-subhead">Table A3 — foreign equity and units</h3>
            {fa.tableA3Error !== null ? (
              <p className="pt-banner" role="status" data-testid="table-a3-refusal">
                {fa.tableA3Error.message}
              </p>
            ) : fa.tableA3 === null || fa.tableA3.length === 0 ? (
              <p className="pt-muted">
                No foreign equity or units held during {fa.calendarYear}. Nothing to disclose.
              </p>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table" data-testid="table-a3">
                  <thead>
                    <tr>
                      <th scope="col">Country</th>
                      <th scope="col">Entity</th>
                      <th scope="col">Acquired</th>
                      <th scope="col" className="pt-align-end">
                        Initial
                      </th>
                      {/* The column the whole daily series exists for. */}
                      <th scope="col" className="pt-align-end">
                        Peak
                      </th>
                      <th scope="col" className="pt-align-end">
                        Closing
                      </th>
                      <th scope="col" className="pt-align-end">
                        Dividend
                      </th>
                      <th scope="col" className="pt-align-end">
                        Proceeds
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fa.tableA3.map((row, index) => (
                      <tr key={`${row.entityName}-${String(index)}`}>
                        <td>{row.countryCode}</td>
                        <td>{row.entityName}</td>
                        <td className="pt-numeric">{row.acquisitionDate}</td>
                        <td className="pt-align-end">
                          <Amount value={row.initialInvestmentInr} />
                        </td>
                        <td className="pt-align-end">
                          <Amount value={row.peakValueInr} />
                        </td>
                        <td className="pt-align-end">
                          <Amount value={row.closingValueInr} />
                        </td>
                        <td className="pt-align-end">
                          <Amount value={row.grossDividendInr} />
                        </td>
                        <td className="pt-align-end">
                          <Amount value={row.grossProceedsInr} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="pt-subhead">Table D — foreign custodial and bank accounts</h3>
            {fa.tableDError !== null ? (
              <p className="pt-banner" role="status">
                {fa.tableDError.message}
              </p>
            ) : fa.tableD === null || fa.tableD.length === 0 ? (
              <p className="pt-muted">
                No foreign accounts recorded for {fa.calendarYear}. Nothing to disclose.
              </p>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th scope="col">Country</th>
                      <th scope="col">Institution</th>
                      <th scope="col">Account</th>
                      <th scope="col" className="pt-align-end">
                        Peak
                      </th>
                      <th scope="col" className="pt-align-end">
                        Closing
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fa.tableD.map((row) => (
                      <tr key={row.accountRef}>
                        <td>{row.countryCode}</td>
                        <td>{row.institutionName}</td>
                        {/* Masked reference, never the raw account number (FR-7.2). */}
                        <td className="pt-numeric pt-hash">{row.accountRef}</td>
                        <td className="pt-align-end">
                          <Amount value={row.peakBalanceInr} />
                        </td>
                        <td className="pt-align-end">
                          <Amount value={row.closingBalanceInr} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <ForeignInputs calendarYear={calendarYear} />

      <Card
        title="Schedule AL — assets and liabilities"
        action={
          <button type="button" className="pt-button-inline" onClick={() => void loadAl()}>
            Generate
          </button>
        }
      >
        <p className="pt-muted">
          <strong>Cost of acquisition, not market value.</strong> Every other screen shows what a
          holding is worth; this one shows what was paid for it.
        </p>

        <div className="pt-controls">
          <label htmlFor="al-fy">Financial year</label>
          <select
            id="al-fy"
            value={financialYear}
            onChange={(event) => {
              setFinancialYear(event.target.value);
            }}
          >
            {(periods?.financialYears ?? []).map((option) => (
              <option key={option.financialYear} value={option.financialYear}>
                {financialYearLabel(option)}
              </option>
            ))}
          </select>
        </div>

        {selectedFinancialYear !== undefined && (
          <p className="pt-muted" data-testid="al-assessment-year">
            Filed with the return for <strong>AY {selectedFinancialYear.assessmentYear}</strong>,
            reporting the position at 31 March{' '}
            {Number(selectedFinancialYear.financialYear.slice(0, 4)) + 1}.
          </p>
        )}

        {alError !== undefined && (
          <p className="pt-error" role="alert">
            {alError}
          </p>
        )}

        {al !== undefined && (
          <div data-testid="schedule-al">
            {!al.required ? (
              <p className="pt-muted">{al.notRequiredReason}</p>
            ) : (
              <Chip>Required for AY {al.assessmentYear}</Chip>
            )}
            <div className="pt-table-scroll">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="pt-align-end">
                      Cost of acquisition
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    al.immovableProperty,
                    al.financialAssets,
                    al.cashInHand,
                    al.loansAndAdvancesGiven,
                    al.jewellery,
                    al.vehicles,
                    al.liabilities,
                  ].map((section) => (
                    <AlSection key={section.head} section={section} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
