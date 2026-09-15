/**
 * Immovable property.
 *
 * Its own section rather than a row in a holdings table, for the reason Loans and
 * Chits got theirs: the shape is different. Property has no lots, no quantity and
 * no cost per unit — rendering it through the instrument table produces a row
 * reading `1 lot · 1 held · ₹0` under a raw asset id, every column meaningless and
 * the one figure that matters absent. Schedule AL treats it as a separate head
 * (`IMMOVABLE_PROPERTY`) for the same reason.
 *
 * What it is carried at is the ACQUISITION cost, not a market estimate. A
 * valuation nobody performed is not an asset figure, and Schedule AL asks for
 * cost — so this reports what was paid, including the stamp duty and registration
 * that a purchase price alone omits.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type Ledger as LedgerData, type LedgerAsset } from '../api.js';
import { Amount, Card, Chip, GoToImport } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { useEditMode } from '../edit-mode.js';
import { navigate } from '../router.js';

/** Total paid for a property: every lot's cost plus the charges on it. */
function acquisitionCost(asset: LedgerAsset): number {
  return asset.lots.reduce(
    (sum, lot) =>
      sum +
      Number(lot.quantity) * Number(lot.costPerUnit.amount) +
      Number(lot.fees?.amount ?? 0) +
      Number(lot.stt?.amount ?? 0) +
      Number(lot.otherCharges?.amount ?? 0),
    0,
  );
}

export function Immovable() {
  const editMode = useEditMode();
  const [ledger, setLedger] = useState<LedgerData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const result = await api.ledger();
    if (result.ok) {
      setLedger(result.value);
      setError(undefined);
    } else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== undefined) {
    return (
      <Card title="Immovable property">
        <p className="pt-error" role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (ledger === undefined) {
    return (
      <Card title="Immovable property">
        <p className="pt-muted">Loading…</p>
      </Card>
    );
  }

  const properties = ledger.assets.filter((asset) => asset.bucket === 'IMMOVABLE');
  const total = properties.reduce((sum, asset) => sum + acquisitionCost(asset), 0);

  if (properties.length === 0) {
    return (
      <Card title="Immovable property">
        <p className="pt-muted" data-testid="immovable-empty">
          No property recorded. Property is entered from a filled-in{' '}
          <code>Custom_RealEstate</code> template rather than a trade form — there is no quantity
          or price per unit to type.
        </p>
        <div className="pt-actions">
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              navigate('Import');
            }}
          >
            Go to Import
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="pt-stack">
      <Card
        title="Immovable property"
        action={
          <div className="pt-actions pt-actions--inline">
            <Chip>{`${String(properties.length)} propert${properties.length === 1 ? 'y' : 'ies'}`}</Chip>
            <GoToImport testId="go-to-import-immovable" />
          </div>
        }
      >
        <p className="pt-muted">
          Carried at what was <strong>paid</strong> — purchase price plus stamp duty and
          registration — not at a market estimate. Schedule AL asks for cost, and a valuation
          nobody performed is not an asset figure.
        </p>
        <dl className="pt-stats">
          <div>
            <dt>Total acquisition cost</dt>
            <dd data-testid="immovable-total">
              <Amount value={{ amount: String(total), currency: 'INR' }} />
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="Properties">
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="immovable-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Acquired</th>
                <th scope="col" className="pt-align-end">Cost paid</th>
                {editMode.enabled && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {properties.map((asset) => {
                const isOpen = expanded === asset.assetId;
                const name = asset.symbol ?? asset.folioRef ?? asset.assetId;
                const acquired = asset.lots[0]?.acquisitionDate ?? '—';

                return [
                  <tr key={asset.assetId}>
                    <td>
                      <button
                        type="button"
                        className="pt-link pt-link--inline"
                        aria-expanded={isOpen}
                        onClick={() => {
                          setExpanded(isOpen ? undefined : asset.assetId);
                        }}
                      >
                        {name}
                      </button>
                    </td>
                    <td>{acquired}</td>
                    <td className="pt-align-end">
                      <Amount
                        value={{ amount: String(acquisitionCost(asset)), currency: asset.currency }}
                      />
                    </td>
                    {editMode.enabled && (
                      <td>
                        <DeleteControl
                          label="Delete"
                          describes={`${name} and everything recorded against it`}
                          testId={`delete-asset-${asset.assetId}`}
                          onDelete={() => api.deleteAsset(asset.assetId)}
                          onDeleted={() => void load()}
                        />
                      </td>
                    )}
                  </tr>,
                  isOpen ? (
                    <tr key={`${asset.assetId}-detail`} className="pt-table__detail">
                      <td colSpan={editMode.enabled ? 4 : 3}>
                        {/* Broken out because the charges are the part a purchase
                            price alone omits, and they are deductible cost. */}
                        <table className="pt-table pt-table--nested">
                          <thead>
                            <tr>
                              <th scope="col">Acquired</th>
                              <th scope="col" className="pt-align-end">Purchase price</th>
                              <th scope="col" className="pt-align-end">Stamp duty</th>
                              <th scope="col" className="pt-align-end">Registration &amp; other</th>
                            </tr>
                          </thead>
                          <tbody>
                            {asset.lots.map((lot) => (
                              <tr key={lot.lotId}>
                                <td>{lot.acquisitionDate}</td>
                                <td className="pt-align-end">
                                  <Amount
                                    value={{
                                      amount: String(
                                        Number(lot.quantity) * Number(lot.costPerUnit.amount),
                                      ),
                                      currency: lot.costPerUnit.currency,
                                    }}
                                  />
                                </td>
                                <td className="pt-align-end">
                                  <Amount value={lot.stt ?? { amount: '0', currency: asset.currency }} />
                                </td>
                                <td className="pt-align-end">
                                  <Amount
                                    value={{
                                      amount: String(
                                        Number(lot.fees?.amount ?? 0) +
                                          Number(lot.otherCharges?.amount ?? 0),
                                      ),
                                      currency: asset.currency,
                                    }}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
