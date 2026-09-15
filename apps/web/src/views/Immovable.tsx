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
import { PropertyForm } from './PropertyForm.js';

const humanise = (value: string) =>
  value.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Every duty on a lot, from the deed's own breakdown where one was recorded. */
function totalTax(lot: LedgerAsset['lots'][number]): number {
  const property = lot.property;
  if (property === undefined) {
    // Pre-migration lots have no breakdown. fees + otherCharges is what the old
    // importer wrote, and it is the whole of what was charged.
    return Number(lot.fees?.amount ?? 0) + Number(lot.otherCharges?.amount ?? 0);
  }
  return (
    Number(property.stampDuty.amount) +
    Number(property.registrationFee.amount) +
    Number(property.gst.amount) +
    Number(property.otherTaxes.amount)
  );
}

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

/**
 * Recording a property is a figure-changing write, so it is gated on edit mode
 * exactly as deleting one is. Disabled rather than hidden: a control that
 * vanishes leaves the user hunting for a feature they were told exists, where a
 * disabled one with a reason sends them to Settings.
 */
function AddPropertyButton({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pt-button-inline"
      onClick={onClick}
      disabled={!enabled}
      title={enabled ? undefined : 'Enable edit mode in Settings to record a property'}
      data-testid="add-property"
    >
      Add property or transaction
    </button>
  );
}

export function Immovable() {
  const editMode = useEditMode();
  const [ledger, setLedger] = useState<LedgerData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

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
          No property recorded. Add one here — a purchase or a sale, with its area, rate and each
          duty — or import a filled-in <code>Custom_RealEstate</code> template.
        </p>
        <div className="pt-actions">
          <AddPropertyButton
            enabled={editMode.enabled}
            onClick={() => {
              setAdding(true);
            }}
          />
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
        {adding && (
          <PropertyForm
            onSaved={() => void load()}
            onClose={() => {
              setAdding(false);
            }}
          />
        )}
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
            <AddPropertyButton
              enabled={editMode.enabled}
              onClick={() => {
                setAdding((open) => !open);
              }}
            />
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
        {adding && (
          <PropertyForm
            onSaved={() => void load()}
            onClose={() => {
              setAdding(false);
            }}
          />
        )}
      </Card>

      <Card title="Properties">
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="immovable-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Type</th>
                <th scope="col">Where</th>
                <th scope="col" className="pt-align-end">Area</th>
                <th scope="col">Acquired</th>
                <th scope="col" className="pt-align-end">Cost paid</th>
                {/* Shown only where one was recorded, and never summed above. */}
                <th scope="col" className="pt-align-end">Current value</th>
                {editMode.enabled && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {properties.map((asset) => {
                const isOpen = expanded === asset.assetId;
                const property = asset.property;
                // The property block is authoritative for the name; `symbol` is
                // where the old importer parked it and is the fallback.
                const name = property?.propertyName ?? asset.symbol ?? asset.folioRef ?? asset.assetId;
                const acquired = asset.lots[0]?.acquisitionDate ?? '—';
                const where = [property?.location?.city, property?.location?.state]
                  .filter((part) => part !== undefined && part.length > 0)
                  .join(', ');

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
                    <td>{property === undefined ? '—' : humanise(property.kind)}</td>
                    <td>{where.length === 0 ? '—' : where}</td>
                    <td className="pt-align-end">
                      {property?.area === undefined
                        ? '—'
                        : `${property.area.value} ${humanise(property.area.unit)}`}
                    </td>
                    <td>{acquired}</td>
                    <td className="pt-align-end">
                      <Amount
                        value={{ amount: String(acquisitionCost(asset)), currency: asset.currency }}
                      />
                    </td>
                    <td className="pt-align-end">
                      {property?.currentValue === undefined ? (
                        '—'
                      ) : (
                        /* The basis and date travel WITH the figure. A bare
                           number here would read as a measured value. */
                        <span title={`${humanise(property.currentValue.basis)}, ${property.currentValue.asOf}`}>
                          <Amount value={property.currentValue.amount} />
                        </span>
                      )}
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
                      <td colSpan={editMode.enabled ? 8 : 7}>
                        {/*
                          The duties are the part a purchase price alone omits,
                          and they are deductible cost. This read `lot.stt` as
                          "Stamp duty" — a field nothing ever sets for property,
                          because STT is a SECURITIES transaction tax — so every
                          property showed ₹0 duty while the real figure sat under
                          "Registration & other". It now reads the deed's own
                          breakdown.
                        */}
                        <table className="pt-table pt-table--nested">
                          <thead>
                            <tr>
                              <th scope="col">Date</th>
                              <th scope="col" className="pt-align-end">Area</th>
                              <th scope="col" className="pt-align-end">Rate</th>
                              <th scope="col" className="pt-align-end">Price</th>
                              <th scope="col" className="pt-align-end">Stamp duty</th>
                              <th scope="col" className="pt-align-end">Registration</th>
                              <th scope="col" className="pt-align-end">GST</th>
                              <th scope="col" className="pt-align-end">Other tax</th>
                              <th scope="col" className="pt-align-end">Total tax</th>
                            </tr>
                          </thead>
                          <tbody>
                            {asset.lots.map((lot) => {
                              const detail = lot.property;
                              const zero = { amount: '0', currency: asset.currency };
                              return (
                                <tr key={lot.lotId}>
                                  <td>{lot.acquisitionDate}</td>
                                  <td className="pt-align-end">
                                    {detail?.area === undefined
                                      ? '—'
                                      : `${detail.area.value} ${humanise(detail.area.unit)}`}
                                  </td>
                                  <td className="pt-align-end">
                                    {detail?.pricePerAreaUnit === undefined ? (
                                      '—'
                                    ) : (
                                      <Amount value={detail.pricePerAreaUnit} />
                                    )}
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount
                                      value={
                                        detail?.consideration ?? {
                                          amount: String(
                                            Number(lot.quantity) * Number(lot.costPerUnit.amount),
                                          ),
                                          currency: lot.costPerUnit.currency,
                                        }
                                      }
                                    />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={detail?.stampDuty ?? zero} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={detail?.registrationFee ?? zero} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={detail?.gst ?? zero} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={detail?.otherTaxes ?? zero} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount
                                      value={{
                                        amount: String(totalTax(lot)),
                                        currency: asset.currency,
                                      }}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
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
