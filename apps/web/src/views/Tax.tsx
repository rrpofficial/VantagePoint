/**
 * Tax — advance tax instalments, regime comparison and the income behind them.
 *
 * Every figure here carries the provisional banner. The rule set this build
 * ships is unverified, and a tax number that cannot be filed must never look
 * like one that can.
 *
 * The "no income recorded" state is shown explicitly beside any nil figure:
 * ₹0 payable computed from a missing Form 16 is not the same answer as ₹0
 * payable computed from a real one, and the user is the only one who can tell
 * the difference.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type AdvanceTaxInstallment,
  type RegimeComparison,
} from '../api.js';
import { Amount, Card, Chip, ProvisionalBanner } from '../components/primitives.js';
import { EditModeHint, useEditMode } from '../edit-mode.js';
import { financialYearLabel, usePeriods } from '../usePeriods.js';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

const INCOME_FIELDS = [
  ['grossSalary', 'Gross salary'],
  ['exemptAllowances', 'Exempt allowances'],
  ['chapterViaDeductions', 'Chapter VI-A deductions'],
  ['housePropertyIncome', 'House property income'],
  ['otherSourcesIncome', 'Other sources income'],
  ['tdsRemitted', 'TDS already remitted'],
] as const;

export function Tax() {
  const editMode = useEditMode();
  const periods = usePeriods();
  // Empty until the server says what year it is, then defaulted to the current
  // one. Hardcoding a starting year meant the picker silently went stale every
  // April, offering a year the user had already finished filing for.
  const [financialYear, setFinancialYear] = useState<string>('');
  const [quarter, setQuarter] = useState<string>('Q1');
  const [installment, setInstallment] = useState<AdvanceTaxInstallment | undefined>();
  const [regimes, setRegimes] = useState<RegimeComparison | undefined>();
  const [hasProfile, setHasProfile] = useState(false);
  const [income, setIncome] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const loadProfile = useCallback(async (): Promise<void> => {
    const result = await api.incomeProfile();
    if (result.ok) setHasProfile(result.value.present);
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (periods !== undefined && financialYear === '') {
      setFinancialYear(periods.defaultFinancialYear);
    }
  }, [periods, financialYear]);

  const compute = useCallback(async (): Promise<void> => {
    setError(undefined);
    const [advance, comparison] = await Promise.all([
      api.advanceTax(financialYear, quarter),
      api.regimes(financialYear),
    ]);

    if (advance.ok) setInstallment(advance.value);
    else {
      setInstallment(undefined);
      setError(advance.error.message);
    }
    if (comparison.ok) {
      setRegimes(comparison.value);
      setHasProfile(comparison.value.hasIncomeProfile);
    }
  }, [financialYear, quarter]);

  const selectedYear = periods?.financialYears.find(
    (option) => option.financialYear === financialYear,
  );

  const saveIncome = useCallback(async (): Promise<void> => {
    setError(undefined);
    const zero = { amount: '0', currency: 'INR' };
    const money = (key: string) => ({ amount: income[key] ?? '0', currency: 'INR' });

    const result = await api.saveIncomeProfile({
      financialYear,
      // FY + 1, from the server. Repeating the FY here labelled the profile with
      // the wrong assessment year, which is what a return is actually filed under.
      assessmentYear: selectedYear?.assessmentYear ?? financialYear,
      grossSalary: money('grossSalary'),
      exemptAllowances: money('exemptAllowances'),
      chapterViaDeductions: money('chapterViaDeductions'),
      housePropertyIncome: money('housePropertyIncome'),
      otherSourcesIncome: money('otherSourcesIncome'),
      tdsRemitted: money('tdsRemitted'),
      tcsCollected: zero,
    });

    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSaved(true);
    setHasProfile(true);
    await compute();
  }, [financialYear, selectedYear, income, compute]);

  function onSubmitIncome(event: SyntheticEvent): void {
    event.preventDefault();
    void saveIncome();
  }

  return (
    <div className="pt-stack">
      <Card
        title="Advance tax"
        action={
          <button type="button" className="pt-button-inline" onClick={() => void compute()}>
            Compute advance tax
          </button>
        }
      >
        <ProvisionalBanner />

        <div className="pt-controls">
          <label htmlFor="fy">Financial year</label>
          <select
            id="fy"
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

          <label htmlFor="quarter">Instalment</label>
          <select
            id="quarter"
            value={quarter}
            onChange={(event) => {
              setQuarter(event.target.value);
            }}
          >
            {QUARTERS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {selectedYear !== undefined && periods !== undefined && (
          <p className="pt-muted" data-testid="selected-period">
            FY {selectedYear.financialYear} is assessed in{' '}
            <strong>AY {selectedYear.assessmentYear}</strong>
            {selectedYear.isCurrent ? ' — the current financial year.' : '.'}
            {!selectedYear.rulesAvailable && (
              <>
                {' '}
                No rate set has been loaded for FY {selectedYear.financialYear}, so nothing can be
                computed for it — rates are never carried over from an adjacent year.
              </>
            )}
            {!selectedYear.isCurrent &&
              periods.currentFinancialYear !== periods.defaultFinancialYear && (
                <>
                  {' '}
                  The current year, FY {periods.currentFinancialYear}, has no rates yet, so this
                  opens on the most recent year that can be computed.
                </>
              )}
          </p>
        )}

        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}

        {installment !== undefined && (
          <>
            {!hasProfile && (
              <p className="pt-muted" data-testid="no-income-profile">
                No income has been recorded for {financialYear}, so this is computed from zero
                income. Enter your income below for a figure that means something.
              </p>
            )}
            <p className="pt-display pt-numeric" data-testid="advance-tax-payable">
              {new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: 'INR',
                maximumFractionDigits: 0,
              }).format(Number(installment.netPayable.amount))}
            </p>
            <dl className="pt-stats">
              <div>
                <dt>Due by</dt>
                <dd>{installment.dueDate}</dd>
              </div>
              <div>
                <dt>Cumulative</dt>
                <dd className="pt-numeric">{installment.cumulativePercentage}%</dd>
              </div>
              <div>
                <dt>Total liability</dt>
                <dd>
                  <Amount value={installment.totalLiability} />
                </dd>
              </div>
              <div>
                <dt>TDS credit</dt>
                <dd>
                  <Amount value={installment.tdsCredit} />
                </dd>
              </div>
            </dl>
          </>
        )}
      </Card>

      {regimes !== undefined && (
        <Card title="Regime comparison" action={<Chip>{regimes.recommended} regime</Chip>}>
          <ProvisionalBanner />
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="regime-table">
              <thead>
                <tr>
                  <th scope="col">Regime</th>
                  <th scope="col" className="pt-align-end">
                    Total income
                  </th>
                  <th scope="col" className="pt-align-end">
                    Base tax
                  </th>
                  <th scope="col" className="pt-align-end">
                    Surcharge
                  </th>
                  <th scope="col" className="pt-align-end">
                    Cess
                  </th>
                  <th scope="col" className="pt-align-end">
                    Liability
                  </th>
                </tr>
              </thead>
              <tbody>
                {[regimes.old, regimes.new].map((computation) => (
                  <tr key={computation.regime}>
                    <td>{computation.regime.toLowerCase()}</td>
                    <td className="pt-align-end">
                      <Amount value={computation.totalIncome} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.baseTax} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.surcharge} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.cess} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.totalLiability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {regimes.deductionsForgone.length > 0 && (
            <p className="pt-muted">
              Forgone under the new regime: {regimes.deductionsForgone.join(', ')}.
            </p>
          )}
        </Card>
      )}

      <Card title="Income for the year" action={hasProfile ? <Chip>Recorded</Chip> : undefined}>
        <p className="pt-muted">
          Stored in your encrypted vault, never sent anywhere. Salary is as sensitive as holdings,
          and it is cleared from memory when the vault locks.
        </p>
        <form onSubmit={onSubmitIncome} className="pt-form pt-form--grid">
          {INCOME_FIELDS.map(([key, fieldLabel]) => (
            <div key={key}>
              <label htmlFor={key}>{fieldLabel}</label>
              <input
                id={key}
                type="text"
                inputMode="decimal"
                value={income[key] ?? ''}
                placeholder="0"
                onChange={(event) => {
                  setSaved(false);
                  setIncome((current) => ({ ...current, [key]: event.target.value }));
                }}
              />
            </div>
          ))}
          <button type="submit" disabled={hasProfile && !editMode.enabled}>
            Save income
          </button>
          {/*
            Entering a profile for the first time is an addition and stays open.
            REPLACING one is not: every advance-tax figure on this screen is
            computed from it, and they all move silently when it changes.
          */}
          {hasProfile && !editMode.enabled && (
            <EditModeHint action="replace the income already recorded for this year" />
          )}
          {saved && (
            <p className="pt-muted" role="status">
              Saved.
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}
