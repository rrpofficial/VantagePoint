/**
 * Recording a property purchase or sale by hand.
 *
 * A deed is not a contract note, and the form says so: it asks for area and a
 * rate, and for each duty by name, rather than for "quantity", "price" and an
 * undifferentiated "charges". The server turns those into the canonical lot
 * fields — see `propertyChargesOf` — so nothing here decides which column stamp
 * duty belongs in.
 *
 * Money fields are posted as TYPED TEXT. The server parses Indian digit grouping,
 * and `1,00,00,000` is exactly how someone reads a figure off a sale deed;
 * pre-parsing it in the browser would be a second parser to keep in step.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type AreaUnit,
  type PropertyAdvisory,
  type PropertyKind,
  type RecordPropertyBody,
  type ValuationBasis,
} from '../api.js';

const VALUATION_BASES: readonly { value: ValuationBasis; label: string }[] = [
  { value: 'CIRCLE_RATE', label: 'Circle / guideline rate' },
  { value: 'REGISTERED_VALUER', label: 'Registered valuer’s report' },
  { value: 'RECENT_COMPARABLE', label: 'Recent comparable sale' },
  { value: 'BROKER_ESTIMATE', label: 'Broker estimate' },
  { value: 'OWNER_ESTIMATE', label: 'Own estimate' },
];

const humanise = (value: string) =>
  value.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Only fields the user actually filled in are sent; blanks stay absent. */
const filled = (value: string): string | undefined =>
  value.trim().length === 0 ? undefined : value.trim();

export function PropertyForm({
  onSaved,
  onClose,
}: {
  onSaved: () => void;
  onClose: () => void;
}) {
  const [reference, setReference] = useState<{
    kinds: readonly PropertyKind[];
    areaUnits: readonly AreaUnit[];
  }>();

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [transactionDate, setTransactionDate] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [kind, setKind] = useState<PropertyKind>('FLAT');

  const [consideration, setConsideration] = useState('');
  const [areaValue, setAreaValue] = useState('');
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('SQ_FT');
  const [pricePerAreaUnit, setPricePerAreaUnit] = useState('');

  const [stampDuty, setStampDuty] = useState('');
  const [registrationFee, setRegistrationFee] = useState('');
  const [gst, setGst] = useState('');
  const [otherTaxes, setOtherTaxes] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [stampDutyValue, setStampDutyValue] = useState('');

  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [pincode, setPincode] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [surveyNumber, setSurveyNumber] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [notes, setNotes] = useState('');

  const [valueAmount, setValueAmount] = useState('');
  const [valueAsOf, setValueAsOf] = useState('');
  const [valueBasis, setValueBasis] = useState<ValuationBasis>('CIRCLE_RATE');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [advisories, setAdvisories] = useState<readonly PropertyAdvisory[]>([]);
  /** Set when the server says this looks like an entry already on the ledger. */
  const [duplicate, setDuplicate] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      const result = await api.propertyReference();
      if (result.ok) setReference(result.value);
    })();
  }, []);

  const submit = useCallback(
    async (confirmDuplicate: boolean): Promise<void> => {
      setBusy(true);
      setError(undefined);
      setAdvisories([]);

      const body: RecordPropertyBody = {
        side,
        transactionDate,
        propertyName: propertyName.trim(),
        kind,
        consideration: consideration.trim(),
        // Area is sent only when BOTH halves are present: the server refuses a
        // measurement with no unit, which is the right refusal but a confusing
        // one to hit by leaving a default select in place.
        ...(filled(areaValue) === undefined
          ? {}
          : { areaValue: areaValue.trim(), areaUnit }),
        ...(filled(pricePerAreaUnit) === undefined
          ? {}
          : { pricePerAreaUnit: pricePerAreaUnit.trim() }),
        ...(filled(stampDuty) === undefined ? {} : { stampDuty: stampDuty.trim() }),
        ...(filled(registrationFee) === undefined
          ? {}
          : { registrationFee: registrationFee.trim() }),
        ...(filled(gst) === undefined ? {} : { gst: gst.trim() }),
        ...(filled(otherTaxes) === undefined ? {} : { otherTaxes: otherTaxes.trim() }),
        ...(filled(brokerage) === undefined ? {} : { brokerage: brokerage.trim() }),
        ...(filled(stampDutyValue) === undefined
          ? {}
          : { stampDutyValue: stampDutyValue.trim() }),
        ...(filled(address) === undefined ? {} : { address: address.trim() }),
        ...(filled(city) === undefined ? {} : { city: city.trim() }),
        ...(filled(state) === undefined ? {} : { state: state.trim() }),
        ...(filled(pincode) === undefined ? {} : { pincode: pincode.trim() }),
        ...(filled(registrationNumber) === undefined
          ? {}
          : { registrationNumber: registrationNumber.trim() }),
        ...(filled(surveyNumber) === undefined ? {} : { surveyNumber: surveyNumber.trim() }),
        ...(filled(documentRef) === undefined ? {} : { documentRef: documentRef.trim() }),
        ...(filled(notes) === undefined ? {} : { notes: notes.trim() }),
        // An amount with no date is not a valuation, so both are required
        // together — the server enforces it and the form does not send half.
        ...(filled(valueAmount) === undefined || filled(valueAsOf) === undefined
          ? {}
          : {
              currentValue: {
                amount: valueAmount.trim(),
                asOf: valueAsOf,
                basis: valueBasis,
              },
            }),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      };

      const result = await api.recordProperty(body);
      setBusy(false);

      if (!result.ok) {
        if (result.error.code === 'DUPLICATE_TRADE') {
          setDuplicate(result.error.message);
          return;
        }
        setError(result.error.message);
        return;
      }

      /*
       * Advisories are not errors and do not close the form. A stamp-duty
       * shortfall is a tax exposure the user should read, and closing over it
       * would make the one message that matters the one they never see.
       */
      if (result.value.advisories.length > 0) {
        setAdvisories(result.value.advisories);
        setDuplicate(undefined);
        onSaved();
        return;
      }

      onSaved();
      onClose();
    },
    [
      side, transactionDate, propertyName, kind, consideration, areaValue, areaUnit,
      pricePerAreaUnit, stampDuty, registrationFee, gst, otherTaxes, brokerage,
      stampDutyValue, address, city, state, pincode, registrationNumber, surveyNumber,
      documentRef, notes, valueAmount, valueAsOf, valueBasis, onSaved, onClose,
    ],
  );

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit(false);
  }

  return (
    <form className="vp-form vp-form--grid" onSubmit={onSubmit} data-testid="property-form">
      <label htmlFor="prop-side">Transaction</label>
      <select
        id="prop-side"
        value={side}
        onChange={(event) => {
          setSide(event.target.value === 'SELL' ? 'SELL' : 'BUY');
        }}
      >
        <option value="BUY">Purchase</option>
        <option value="SELL">Sale</option>
      </select>

      <label htmlFor="prop-date">Date</label>
      <input
        id="prop-date"
        type="date"
        value={transactionDate}
        onChange={(event) => {
          setTransactionDate(event.target.value);
        }}
        required
      />

      <label htmlFor="prop-name">Property name</label>
      <input
        id="prop-name"
        value={propertyName}
        onChange={(event) => {
          setPropertyName(event.target.value);
        }}
        placeholder="e.g. Green Acres, Flat 402"
        required
      />

      <label htmlFor="prop-kind">Type</label>
      <select
        id="prop-kind"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value);
        }}
      >
        {(reference?.kinds ?? [kind]).map((option) => (
          <option key={option} value={option}>
            {humanise(option)}
          </option>
        ))}
      </select>

      <label htmlFor="prop-area">Area</label>
      <div className="vp-field-row">
        <input
          id="prop-area"
          value={areaValue}
          onChange={(event) => {
            setAreaValue(event.target.value);
          }}
          placeholder="e.g. 1450"
          inputMode="decimal"
        />
        <select
          value={areaUnit}
          aria-label="Area unit"
          onChange={(event) => {
            setAreaUnit(event.target.value);
          }}
        >
          {(reference?.areaUnits ?? [areaUnit]).map((unit) => (
            <option key={unit} value={unit}>
              {humanise(unit)}
            </option>
          ))}
        </select>
      </div>

      <label htmlFor="prop-rate">Rate per unit area</label>
      <input
        id="prop-rate"
        value={pricePerAreaUnit}
        onChange={(event) => {
          setPricePerAreaUnit(event.target.value);
        }}
        placeholder="optional — e.g. 8,500"
        inputMode="decimal"
      />

      <label htmlFor="prop-consideration">Total price</label>
      <input
        id="prop-consideration"
        value={consideration}
        onChange={(event) => {
          setConsideration(event.target.value);
        }}
        placeholder="e.g. 1,23,25,000"
        inputMode="decimal"
        required
      />

      <label htmlFor="prop-stamp">Stamp duty</label>
      <input
        id="prop-stamp"
        value={stampDuty}
        onChange={(event) => {
          setStampDuty(event.target.value);
        }}
        inputMode="decimal"
      />

      <label htmlFor="prop-reg">Registration fee</label>
      <input
        id="prop-reg"
        value={registrationFee}
        onChange={(event) => {
          setRegistrationFee(event.target.value);
        }}
        inputMode="decimal"
      />

      <label htmlFor="prop-gst">GST</label>
      <input
        id="prop-gst"
        value={gst}
        onChange={(event) => {
          setGst(event.target.value);
        }}
        placeholder="under-construction purchases only"
        inputMode="decimal"
      />

      <label htmlFor="prop-other-tax">Other taxes &amp; cess</label>
      <input
        id="prop-other-tax"
        value={otherTaxes}
        onChange={(event) => {
          setOtherTaxes(event.target.value);
        }}
        placeholder="LBT, cess, TDS u/s 194-IA"
        inputMode="decimal"
      />

      <label htmlFor="prop-brokerage">Brokerage</label>
      <input
        id="prop-brokerage"
        value={brokerage}
        onChange={(event) => {
          setBrokerage(event.target.value);
        }}
        inputMode="decimal"
      />

      <label htmlFor="prop-sdv">Stamp duty value</label>
      <input
        id="prop-sdv"
        value={stampDutyValue}
        onChange={(event) => {
          setStampDutyValue(event.target.value);
        }}
        placeholder="the sub-registrar’s assessed value, if different"
        inputMode="decimal"
      />

      <label htmlFor="prop-address">Address</label>
      <input
        id="prop-address"
        value={address}
        onChange={(event) => {
          setAddress(event.target.value);
        }}
        placeholder="held only in your vault"
      />

      <label htmlFor="prop-city">City</label>
      <input
        id="prop-city"
        value={city}
        onChange={(event) => {
          setCity(event.target.value);
        }}
      />

      <label htmlFor="prop-state">State</label>
      <input
        id="prop-state"
        value={state}
        onChange={(event) => {
          setState(event.target.value);
        }}
      />

      <label htmlFor="prop-pin">PIN code</label>
      <input
        id="prop-pin"
        value={pincode}
        onChange={(event) => {
          setPincode(event.target.value);
        }}
        inputMode="numeric"
      />

      <label htmlFor="prop-regno">Registration number</label>
      <input
        id="prop-regno"
        value={registrationNumber}
        onChange={(event) => {
          setRegistrationNumber(event.target.value);
        }}
      />

      <label htmlFor="prop-survey">Survey / khata number</label>
      <input
        id="prop-survey"
        value={surveyNumber}
        onChange={(event) => {
          setSurveyNumber(event.target.value);
        }}
      />

      <label htmlFor="prop-doc">Document reference</label>
      <input
        id="prop-doc"
        value={documentRef}
        onChange={(event) => {
          setDocumentRef(event.target.value);
        }}
      />

      <label htmlFor="prop-value">Current value</label>
      <input
        id="prop-value"
        value={valueAmount}
        onChange={(event) => {
          setValueAmount(event.target.value);
        }}
        placeholder="optional — not used for net worth"
        inputMode="decimal"
      />

      <label htmlFor="prop-value-date">Valued on</label>
      <input
        id="prop-value-date"
        type="date"
        value={valueAsOf}
        onChange={(event) => {
          setValueAsOf(event.target.value);
        }}
      />

      <label htmlFor="prop-value-basis">Valuation basis</label>
      <select
        id="prop-value-basis"
        value={valueBasis}
        onChange={(event) => {
          setValueBasis(event.target.value as ValuationBasis);
        }}
      >
        {VALUATION_BASES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <label htmlFor="prop-notes">Notes</label>
      <textarea
        id="prop-notes"
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
        rows={2}
      />

      <div className="vp-form__wide">
        <p className="vp-muted">
          The property is carried at what was <strong>paid</strong> — price plus stamp duty,
          registration and other duties. A current value, if you record one, is shown beside that
          cost and is never added to net worth: Schedule AL asks for cost.
        </p>
      </div>

      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : side === 'BUY' ? 'Record purchase' : 'Record sale'}
      </button>

      {duplicate !== undefined && (
        <div className="vp-form__wide">
          <p className="vp-error" role="alert" data-testid="property-duplicate">
            {duplicate}
          </p>
          <button
            type="button"
            className="vp-button-inline"
            disabled={busy}
            onClick={() => {
              void submit(true);
            }}
          >
            Record it anyway
          </button>
        </div>
      )}

      {advisories.length > 0 && (
        <div className="vp-form__wide">
          {advisories.map((advisory) => (
            <p key={advisory.code} className="vp-banner" role="status">
              {advisory.message}
            </p>
          ))}
          <button
            type="button"
            className="vp-button-inline"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      )}

      {error !== undefined && (
        <p className="vp-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
