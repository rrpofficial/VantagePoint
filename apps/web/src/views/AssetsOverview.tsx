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
import { api, type AssetBucket, type LoanRegister, type ChitRegister, type Ledger } from '../api.js';
import { Amount, Card } from '../components/primitives.js';
import { navigateToAsset, type AssetTab } from '../router.js';

interface BucketLine {
  readonly tab: AssetTab;
  readonly label: string;
  readonly count: number;
  readonly value: number;
  readonly hint: string;
}

export function AssetsOverview() {
  const [lines, setLines] = useState<readonly BucketLine[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const [ledger, loans, chits] = await Promise.all([api.ledger(), api.loans(), api.chits()]);
    if (!ledger.ok) {
      setError(ledger.error.message);
      return;
    }
    setError(undefined);
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

  return (
    <div className="pt-stack">
      <Card title="What you own">
        <p className="pt-muted">
          Split by what each holding <strong>is</strong>. A fund appears under Equity or Non-Equity
          according to its scheme — equity-oriented and debt-oriented funds share an asset class and
          are taxed differently, so the split follows the tax character rather than the label.
        </p>
        <p className="pt-display pt-numeric" data-testid="assets-total">
          {formatInr(total)}
        </p>
        <p className="pt-muted">
          Carried value across all five, before liabilities. Net worth is on the Dashboard.
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

/** Cost of what is still held: remaining units, plus the charges on them. */
function carriedValue(assets: Ledger['assets'], bucket: AssetBucket): number {
  return assets
    .filter((asset) => asset.bucket === bucket)
    .reduce(
      (sum, asset) =>
        sum +
        asset.lots.reduce(
          (lotSum, lot) =>
            lotSum +
            Number(lot.remainingQuantity) * Number(lot.costPerUnit.amount) +
            Number(lot.fees?.amount ?? 0) +
            Number(lot.stt?.amount ?? 0) +
            Number(lot.otherCharges?.amount ?? 0),
          0,
        ),
      0,
    );
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
      value: carriedValue(ledger.assets, 'EQUITY'),
      hint: 'Listed and unlisted shares, equity funds and ETFs, RSUs and ESPP',
    },
    {
      tab: 'Non-Equity',
      label: 'Non-equity',
      count: countIn(ledger.assets, 'NON_EQUITY'),
      value: carriedValue(ledger.assets, 'NON_EQUITY'),
      hint: 'Deposits, retirement schemes, bullion, crypto, cash and debt funds',
    },
    {
      tab: 'Immovable',
      label: 'Immovable property',
      count: countIn(ledger.assets, 'IMMOVABLE'),
      value: carriedValue(ledger.assets, 'IMMOVABLE'),
      hint: 'Carried at what was paid, including stamp duty and registration',
    },
    {
      tab: 'Loans',
      label: 'Loans receivable',
      count: loans?.loans.length ?? 0,
      // The register's own total, computed server-side: summing decimal strings
      // in the browser reintroduces the drift ADR-002 exists to prevent.
      value: Number(loans?.totals.totalOutstanding.amount ?? 0),
      hint: 'Money lent to people, at principal outstanding',
    },
    {
      tab: 'Chits',
      label: 'Chit funds',
      count: chits?.chits.length ?? 0,
      // Active chits only. A drawn chit's money is cash in a bank account and is
      // counted there; carrying it here too would count it twice.
      value: Number(chits?.totals.activeCarryingValue.amount ?? 0),
      hint: 'Carried at instalments paid in, not at the pot’s face value',
    },
  ];
}
