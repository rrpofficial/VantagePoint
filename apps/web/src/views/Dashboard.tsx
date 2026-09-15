/**
 * Dashboard — net worth, allocation and the entry points to everything else.
 * Renders what the API computed; no figure on this screen is derived here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Amount, Card, ProvisionalBanner } from '../components/primitives.js';
import { navigate } from '../router.js';
import { usePeriods } from '../usePeriods.js';
import { api, type LedgerLiability, type Valuation } from '../api.js';

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function Dashboard({
  valuation,
  valuedAt,
  valuing,
  valuationError,
  onRefresh,
}: {
  valuation: Valuation | undefined;
  /*
   * `| undefined` explicitly, not just optional. Under
   * `exactOptionalPropertyTypes` the two differ: `valuedAt?: string` means the
   * prop may be ABSENT, while the caller passes a variable that is present and
   * holds undefined until the first valuation returns.
   */
  valuedAt?: string | undefined;
  valuing?: boolean | undefined;
  /**
   * Why the last valuation did not produce a figure. Distinct from `valuation`
   * being undefined because nothing has been fetched yet: the two used to render
   * identically, so a refusal the server had explained in full showed here as
   * "Loading your portfolio…".
   */
  valuationError?: string | undefined;
  onRefresh?: (() => void) | undefined;
}) {
  /*
   * Liabilities moved here when the Ledger was retired and holdings split into
   * Equity, Non-Equity and Immovable. They belong beside net worth rather than
   * in any of those tabs: a liability is not a holding, and it is the figure net
   * worth is reduced BY — which is only legible next to the number it reduces.
   */
  const [liabilities, setLiabilities] = useState<readonly LedgerLiability[]>([]);

  const periods = usePeriods();
  const currentYear = periods?.financialYears.find((option) => option.isCurrent);

  const loadLiabilities = useCallback(async (): Promise<void> => {
    const result = await api.ledger();
    if (result.ok) setLiabilities(result.value.liabilities);
  }, []);

  useEffect(() => {
    void loadLiabilities();
  }, [loadLiabilities]);

  return (
    <div className="pt-grid">
      <Card
        title="Net worth"
        action={
          /*
           * The time it was computed, not a "Live" badge. The badge claimed
           * freshness the screen did not have: the valuation was fetched once
           * at unlock, so a loan recorded afterwards left this at ₹0 while the
           * Ledger showed the money. A visible timestamp makes staleness
           * something the user can see rather than something they discover.
           */
          <button
            type="button"
            className="pt-link pt-link--inline"
            onClick={onRefresh}
            disabled={valuing === true}
            data-testid="revalue"
          >
            {valuing === true ? 'Valuing…' : valuedAt === undefined ? 'Refresh' : `as at ${valuedAt}`}
          </button>
        }
      >
        {valuation === undefined && valuationError !== undefined ? (
          <div className="pt-banner" role="status" data-testid="valuation-error">
            <strong>Net worth could not be computed.</strong> {valuationError}
            {/*
              A missing exchange rate is the common case and is fixable by the
              user, so the fix is one click away rather than something to go
              looking for.
            */}
            {valuationError.includes('/INR') && (
              <>
                {' '}
                <button
                  type="button"
                  className="pt-link pt-link--inline"
                  onClick={() => {
                    navigate('Settings');
                  }}
                >
                  Import the missing rates
                </button>
              </>
            )}
          </div>
        ) : valuation === undefined ? (
          <p className="pt-muted">Loading your portfolio…</p>
        ) : (
          <>
            <p className="pt-display pt-numeric" data-testid="net-worth">
              {INR.format(Number(valuation.netWorth.amount))}
            </p>
            <dl className="pt-stats">
              <div>
                <dt>Gross assets</dt>
                <dd>
                  <Amount value={valuation.grossAssets} />
                </dd>
              </div>
              <div>
                <dt>Liabilities</dt>
                <dd>
                  <Amount value={valuation.totalLiabilities} />
                </dd>
              </div>
              <div>
                <dt>Holdings</dt>
                <dd className="pt-numeric">{valuation.positions.length}</dd>
              </div>
            </dl>
          </>
        )}
      </Card>

      <Card title="Asset allocation">
        <div data-testid="allocation-breakdown">
          {valuation === undefined || Object.keys(valuation.byAssetClass).length === 0 ? (
            <p className="pt-muted">
              No holdings recorded yet. Import a statement to populate your ledger.
            </p>
          ) : (
            <ul className="pt-allocation">
              {Object.entries(valuation.byAssetClass).map(([assetClass, value]) => (
                <li key={assetClass}>
                  <span>{assetClass.replaceAll('_', ' ').toLowerCase()}</span>
                  <Amount value={value} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title="Snapshots"
        action={
          <button
            type="button"
            className="pt-link"
            onClick={() => {
              navigate('Snapshots');
            }}
          >
            Compare
          </button>
        }
      >
        <p className="pt-muted">
          Compliance snapshots freeze on 31 March (domestic) and 31 December (foreign).
        </p>
      </Card>

      <Card title="Advance tax">
        {/*
          The CURRENT year's status, since that is the year this card points at.
          It was hard-coded on, so it warned about provisional rates on a card
          that shows no rate and in years whose rule set might be verified.
        */}
        <ProvisionalBanner status={currentYear?.rulesStatus} note={currentYear?.rulesNote} />
        <p className="pt-muted">
          Quarterly instalments appear in the Tax section once your income for the year is recorded.
        </p>
      </Card>

      {liabilities.length > 0 && (
        <Card title="Liabilities">
          <p className="pt-muted">
            Already deducted from the net worth above. Shown here so the figure it is subtracted
            from is on the same screen.
          </p>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="liabilities-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">As of</th>
                  <th scope="col" className="pt-align-end">Rate</th>
                  <th scope="col" className="pt-align-end">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {liabilities.map((liability) => (
                  <tr key={liability.liabilityId}>
                    <td>{liability.kind.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>{liability.asOf}</td>
                    <td className="pt-align-end pt-numeric">{liability.interestRatePct}%</td>
                    <td className="pt-align-end">
                      <Amount value={liability.principalOutstanding} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
