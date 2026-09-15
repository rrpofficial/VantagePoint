/**
 * The Assets landing screen.
 *
 * Exists so the grouping level is not dead weight. A tab that only forwards to
 * Equity would cost a click and return nothing; this answers the question the
 * grouping itself implies — how is what I own split across the five kinds?
 *
 * Every figure is the SERVER's. The split is `bucketOf` (ADR-016: equity versus
 * debt turns on tax character, not asset class), and the valuation is the same
 * one the Dashboard shows, so the two screens cannot disagree about net worth.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AssetBucket,
  type ChitRegister,
  type HoldingsReconciliation,
  type Ledger,
  type LoanRegister,
} from '../api.js';
import { Amount, Card } from '../components/primitives.js';
import { navigateToAsset, type AssetTab } from '../router.js';

interface BucketLine {
  readonly tab: AssetTab;
  readonly label: string;
  readonly count: number;
  /** Market value where priced, cost where not. */
  readonly value: number;
  /** How much of `value` is cost basis because no price exists. */
  readonly atCost: number;
  /** Holdings left out entirely: foreign, and no exchange rate held. */
  readonly unconverted: number;
  readonly hint: string;
}

export function AssetsOverview() {
  const [lines, setLines] = useState<readonly BucketLine[] | undefined>();
  const [reconciliation, setReconciliation] = useState<HoldingsReconciliation | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const [ledger, loans, chits, recon] = await Promise.all([
      api.ledger(),
      api.loans(),
      api.chits(),
      api.reconciliation(),
    ]);
    if (!ledger.ok) {
      setError(ledger.error.message);
      return;
    }
    setError(undefined);
    if (recon.ok) setReconciliation(recon.value);
    setLines(summarise(ledger.value, loans.ok ? loans.value : undefined, chits.ok ? chits.value : undefined));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== undefined) {
    return (
      <Card title="Assets">
        <p className="pt-error" role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (lines === undefined) {
    return (
      <Card title="Assets">
        <p className="pt-muted">Loading…</p>
      </Card>
    );
  }

  const total = lines.reduce((sum, line) => sum + line.value, 0);
  const atCost = lines.reduce((sum, line) => sum + line.atCost, 0);
  const unconverted = lines.reduce((sum, line) => sum + line.unconverted, 0);

  return (
    <div className="pt-stack">
      {/*
        Above the figures, not below them. Everything on this screen is derived
        from the ledger, so when history is missing every number here is
        internally consistent and short — the warning has to reach the reader
        before the totals do, or it explains a discrepancy they have already
        stopped questioning.
      */}
      {reconciliation !== undefined &&
        !reconciliation.noStatementLoaded &&
        reconciliation.discrepancies.length > 0 && (
          <Card title="Your broker and this ledger disagree">
            <p className="pt-callout pt-callout--warn" role="status" data-testid="reconciliation-warning">
              <strong>
                {reconciliation.discrepancies.length} holding
                {reconciliation.discrepancies.length === 1 ? '' : 's'} carry more units here than
                your statement says you hold
              </strong>{' '}
              — {reconciliation.unaccountedUnits} units in total. That is almost always disposals
              that were never imported: a sale from a year whose statement you have not loaded, or
              one made outside the plan account. Until it is resolved these holdings are overstated,
              and so is any gain computed from them.
            </p>
            <div className="pt-table-scroll">
              <table className="pt-table" data-testid="reconciliation-table">
                <thead>
                  <tr>
                    <th scope="col">Acquired</th>
                    <th scope="col">Asset</th>
                    <th scope="col" className="pt-align-end">Your statement</th>
                    <th scope="col" className="pt-align-end">This ledger</th>
                    <th scope="col" className="pt-align-end">Unaccounted</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.discrepancies.map((row) => (
                    <tr key={row.lotId}>
                      <td>{row.acquisitionDate}</td>
                      <td>{row.symbol ?? row.assetId}</td>
                      <td className="pt-align-end pt-numeric">{row.stated}</td>
                      <td className="pt-align-end pt-numeric">{row.computed}</td>
                      <td className="pt-align-end pt-numeric">{row.difference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      <Card title="What you own">
        <p className="pt-muted">
          Split by what each holding <strong>is</strong>. A fund appears under Equity or Non-Equity
          according to its scheme — equity-oriented and debt-oriented funds share an asset class and
          are taxed differently, so the split follows the tax character rather than the label.
        </p>
        <p className="pt-display pt-numeric" data-testid="assets-total">
          {formatInr(total)}
        </p>
        {/*
          Says which figure this actually is. Everything here used to be cost
          basis under a heading that read "value" — the number nobody would have
          questioned, and the one most likely to be acted on.
        */}
        <p className="pt-muted" data-testid="assets-basis">
          Across all five, before liabilities. Priced holdings are at{' '}
          <strong>market value</strong>; everything else — property, unlisted shares, loans and
          chits — is carried at <strong>cost</strong>, which for those is the only honest figure.
          {atCost > 0 && <> {formatInr(atCost)} of this total is at cost.</>}
          {unconverted > 0 && (
            <>
              {' '}
              <strong>
                {unconverted} foreign holding{unconverted === 1 ? ' is' : 's are'} excluded
              </strong>{' '}
              — no exchange rate is held for {unconverted === 1 ? 'it' : 'them'}, and adding a
              foreign amount into a rupee total would be worse than leaving it out.
            </>
          )}{' '}
          Net worth is on the Dashboard.
        </p>
      </Card>

      <Card title="By kind">
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="assets-breakdown">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col" className="pt-align-end">Holdings</th>
                <th scope="col" className="pt-align-end">Value</th>
                <th scope="col" className="pt-align-end">Share</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.tab}>
                  <td>
                    <button
                      type="button"
                      className="pt-link pt-link--inline"
                      data-testid={`assets-goto-${line.tab.toLowerCase()}`}
                      onClick={() => {
                        navigateToAsset(line.tab);
                      }}
                    >
                      {line.label}
                    </button>
                    <div className="pt-tile__hint">{line.hint}</div>
                  </td>
                  <td className="pt-align-end pt-numeric">{line.count}</td>
                  <td className="pt-align-end">
                    <Amount value={{ amount: String(line.value), currency: 'INR' }} />
                  </td>
                  <td className="pt-align-end pt-numeric">
                    {total === 0 ? '—' : `${((line.value / total) * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const formatInr = (value: number) => INR.format(value);

/**
 * Cost of what is still held, in RUPEES.
 *
 * Reads `costBasisInr`, which the server computes — it used to sum
 * `costPerUnit` across every lot regardless of currency and label the result
 * `₹`, so a $88,711 foreign holding was added straight into a rupee total as
 * though a dollar were a rupee.
 *
 * A holding whose rupee value could not be established is EXCLUDED and counted
 * separately, rather than folded in at its face value in another currency.
 */
function carriedValue(
  assets: Ledger['assets'],
  bucket: AssetBucket,
): { value: number; atCost: number; unconverted: number } {
  let value = 0;
  let atCost = 0;
  let unconverted = 0;

  for (const asset of assets.filter((candidate) => candidate.bucket === bucket)) {
    /*
     * Market value where one is known, cost where it is not — and the two are
     * counted separately so the screen can say how much of the total is which.
     * A flat and an unlisted holding have no price and never will; carrying them
     * at cost is correct, and silently blending them into a figure called
     * "market value" would not be.
     */
    if (asset.marketValueInr !== undefined) {
      value += Number(asset.marketValueInr.amount);
      continue;
    }
    if (asset.costBasisInr === undefined) {
      // Neither priced nor convertible: excluded entirely rather than added in
      // a foreign currency.
      if (Number(asset.costBasis.amount) > 0) unconverted++;
      continue;
    }
    value += Number(asset.costBasisInr.amount);
    atCost += Number(asset.costBasisInr.amount);
  }

  return { value, atCost, unconverted };
}

const countIn = (assets: Ledger['assets'], bucket: AssetBucket) =>
  assets.filter((asset) => asset.bucket === bucket).length;

function summarise(
  ledger: Ledger,
  loans: LoanRegister | undefined,
  chits: ChitRegister | undefined,
): readonly BucketLine[] {
  return [
    {
      tab: 'Equity',
      label: 'Equity',
      count: countIn(ledger.assets, 'EQUITY'),
      ...carriedValue(ledger.assets, 'EQUITY'),
      hint: 'Listed and unlisted shares, equity funds and ETFs, RSUs and ESPP',
    },
    {
      tab: 'Non-Equity',
      label: 'Non-equity',
      count: countIn(ledger.assets, 'NON_EQUITY'),
      ...carriedValue(ledger.assets, 'NON_EQUITY'),
      hint: 'Deposits, retirement schemes, bullion, crypto, cash and debt funds',
    },
    {
      tab: 'Immovable',
      label: 'Immovable property',
      count: countIn(ledger.assets, 'IMMOVABLE'),
      ...carriedValue(ledger.assets, 'IMMOVABLE'),
      hint: 'Carried at what was paid, including stamp duty and registration',
    },
    {
      tab: 'Loans',
      label: 'Loans receivable',
      count: loans?.loans.length ?? 0,
      // The register's own total, computed server-side: summing decimal strings
      // in the browser reintroduces the drift ADR-002 exists to prevent.
      value: Number(loans?.totals.totalOutstanding.amount ?? 0),
      atCost: Number(loans?.totals.totalOutstanding.amount ?? 0),
      unconverted: 0,
      hint: 'Money lent to people, at principal outstanding',
    },
    {
      tab: 'Chits',
      label: 'Chit funds',
      count: chits?.chits.length ?? 0,
      // Active chits only. A drawn chit's money is cash in a bank account and is
      // counted there; carrying it here too would count it twice.
      value: Number(chits?.totals.activeCarryingValue.amount ?? 0),
      atCost: Number(chits?.totals.activeCarryingValue.amount ?? 0),
      unconverted: 0,
      hint: 'Carried at instalments paid in, not at the pot’s face value',
    },
  ];
}
