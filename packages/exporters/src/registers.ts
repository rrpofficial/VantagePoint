/**
 * What each register looks like as a table (Phase 7, §7.2).
 *
 * Columns and rows only. Every mechanism — quoting, pagination, the generated-on
 * stamp, the totals rule — lives in `table.ts`, so a register added later is a
 * column list rather than another PDF writer.
 *
 * ## Masking is a parameter, never a default that leaks
 *
 * A borrower's name and a property's street address are in the vault in the
 * clear and are replaced by `brw_…` / `addr_…` in anything that leaves (ADR-013).
 * An export is a file the user will email, so `includePii` is an explicit choice
 * made at export time and the file SAYS which way it was made — a recipient must
 * be able to tell a masked extract from a full one without being told.
 */
import { Money, type Money as MoneyValue } from '@porttrack/shared-kernel';
import type {
  AcquisitionLot,
  Asset,
  BalanceView,
  ChitTotals,
  ChitView,
  ExitTransaction,
  ImmovableProperty,
} from '@porttrack/core-domain';
import { totalOutlayOf, totalTaxOf } from '@porttrack/core-domain';
import type { ExportColumn, ExportTable } from './table.js';

export interface ExportOptions {
  /** Names and addresses in the clear. Off unless the caller asks. */
  readonly includePii: boolean;
  readonly generatedOn: string;
  /** Describes the filter the screen had on, so the file matches what was seen. */
  readonly filterNote?: string;
}

/** The line every export carries, so the reader knows what they are holding. */
export function piiNote(includePii: boolean): string {
  return includePii
    ? 'Contains names and addresses in full. Treat this file as confidential.'
    : 'Names and addresses are replaced by opaque references. Re-export with names included if the recipient needs them.';
}

const notesFor = (options: ExportOptions, extra: readonly string[] = []): readonly string[] => [
  ...(options.filterNote === undefined ? [] : [options.filterNote]),
  ...extra,
  piiNote(options.includePii),
];

/** Money to the byte: the decimal string the domain produced, never a float. */
const amount = (money: MoneyValue | undefined): string => money?.amount ?? '';

/* -------------------------------------------------------------------- chits */

const CHIT_COLUMNS: readonly ExportColumn[] = [
  { label: 'Chit', width: 110 },
  { label: 'Organisation', width: 110 },
  { label: 'Status', width: 70 },
  { label: 'Start', width: 62 },
  { label: 'End', width: 62 },
  { label: 'Months', width: 44, numeric: true },
  { label: 'Paid', width: 42, numeric: true },
  { label: 'Target', width: 78, numeric: true },
  { label: 'Paid to date', width: 78, numeric: true },
  { label: 'Carrying value', width: 82, numeric: true },
  { label: 'Agreed withdrawal', width: 88, numeric: true },
];

export function chitTable(
  chits: readonly ChitView[],
  totals: ChitTotals,
  options: ExportOptions,
): ExportTable {
  return {
    title: 'portTrack — Chit fund register',
    columns: CHIT_COLUMNS,
    notes: notesFor(options, [
      'Carrying value is contributions at cost, and nil once the pot is drawn — the drawn amount is then cash in a bank account and is counted there.',
    ]),
    rows: chits.map((chit) => [
      chit.label,
      chit.org,
      chit.status,
      chit.startDate,
      chit.endDate,
      String(chit.durationMonths),
      String(chit.emiCount),
      amount(chit.targetAmount),
      amount(chit.paidToDate),
      amount(chit.carryingValue),
      // Absent where no schedule covers the chit. Never interpolated, so a blank
      // here means "not agreed", not "zero".
      amount(chit.expectedWithdrawal),
    ]),
    totals: [
      [
        'TOTAL',
        `${String(totals.chitCount)} chit(s)`,
        `${String(totals.activeCount)} active`,
        '',
        '',
        '',
        '',
        amount(totals.totalTarget),
        amount(totals.totalPaid),
        amount(totals.activeCarryingValue),
        amount(totals.totalWithdrawn),
      ],
    ],
  };
}

/* --------------------------------------------------------------- holdings */

const HOLDING_COLUMNS: readonly ExportColumn[] = [
  { label: 'Asset', width: 120 },
  { label: 'Class', width: 110 },
  { label: 'Currency', width: 52 },
  { label: 'Quantity', width: 74, numeric: true },
  { label: 'Cost basis', width: 86, numeric: true },
  { label: 'Lots', width: 40, numeric: true },
];

const LOT_COLUMNS: readonly ExportColumn[] = [
  { label: 'Asset', width: 96 },
  { label: 'Lot', width: 96 },
  { label: 'Acquired', width: 60 },
  { label: 'Quantity', width: 62, numeric: true },
  { label: 'Remaining', width: 62, numeric: true },
  { label: 'Cost / unit', width: 70, numeric: true },
  { label: 'Fees', width: 52, numeric: true },
  { label: 'STT', width: 46, numeric: true },
  { label: 'Other charges', width: 66, numeric: true },
  { label: 'FX rate used', width: 62, numeric: true },
  { label: 'Award', width: 60 },
];

const DISPOSAL_COLUMNS: readonly ExportColumn[] = [
  { label: 'Asset', width: 100 },
  { label: 'Sold', width: 62 },
  { label: 'Quantity', width: 66, numeric: true },
  { label: 'Price / unit', width: 74, numeric: true },
  { label: 'Fees', width: 56, numeric: true },
  { label: 'STT', width: 50, numeric: true },
  { label: 'Proceeds (tax) INR', width: 92, numeric: true },
  { label: 'Cost basis (tax) INR', width: 96, numeric: true },
  { label: 'Taxable gain INR', width: 92, numeric: true },
  { label: 'Kind', width: 66 },
];

const labelOf = (asset: Asset): string =>
  asset.symbol ?? asset.isin ?? asset.property?.propertyName ?? asset.assetId;

const heldQuantity = (asset: Asset): string =>
  asset.lots
    .reduce((sum, lot) => sum + Number(lot.remainingQuantity), 0)
    // Only for display of a COUNT; every money figure stays a decimal string.
    .toString();

const lotCost = (lot: AcquisitionLot): MoneyValue =>
  Money.sum(
    [
      Money.multiply(lot.costPerUnit, lot.quantity),
      lot.fees,
      lot.stt,
      lot.otherCharges,
    ],
    lot.costPerUnit.currency,
  );

/**
 * Three tables, not one.
 *
 * A holdings summary without lots cannot support a capital-gains conversation,
 * which is most of why a holdings export exists; and disposals are a different
 * shape again. Each is a table so a spreadsheet can take them apart.
 */
export function holdingTables(
  assets: readonly Asset[],
  exits: readonly ExitTransaction[],
  options: ExportOptions & { financialYearNote?: string },
): readonly ExportTable[] {
  const summary: ExportTable = {
    title: 'portTrack — Holdings',
    columns: HOLDING_COLUMNS,
    notes: notesFor(options, [
      'Cost basis is acquisition cost including charges — not market value.',
    ]),
    rows: assets.map((asset) => [
      labelOf(asset),
      asset.assetClass,
      asset.currency,
      heldQuantity(asset),
      amount(
        Money.sum(
          asset.lots.map(lotCost),
          asset.currency,
        ),
      ),
      String(asset.lots.length),
    ]),
  };

  const lots: ExportTable = {
    title: 'portTrack — Acquisition lots',
    columns: LOT_COLUMNS,
    notes: notesFor(options, [
      'The rate column is the VALUATION rate used on the trade date, not the Rule 115 rate a capital gain is charged at (ADR-003).',
    ]),
    rows: assets.flatMap((asset) =>
      asset.lots.map((lot) => [
        labelOf(asset),
        lot.lotId,
        lot.acquisitionDate,
        lot.quantity,
        lot.remainingQuantity,
        amount(lot.costPerUnit),
        amount(lot.fees),
        amount(lot.stt),
        amount(lot.otherCharges),
        lot.fx?.valuationRate ?? '',
        lot.equityAward?.kind ?? '',
      ]),
    ),
  };

  const disposals: ExportTable = {
    title: 'portTrack — Disposals',
    columns: DISPOSAL_COLUMNS,
    notes: notesFor(options, [
      ...(options.financialYearNote === undefined ? [] : [options.financialYearNote]),
      'A blank rupee column is a disposal whose Rule 115 month-end rate could not be resolved. It is NOT zero, and the gain is not stated.',
    ]),
    rows: exits.map((exit) => {
      const asset = assets.find((candidate) => candidate.assetId === exit.assetId);
      return [
        asset === undefined ? exit.assetId : labelOf(asset),
        exit.exitDate,
        exit.quantity,
        amount(exit.pricePerUnit),
        amount(exit.fees),
        amount(exit.stt),
        amount(exit.proceedsTaxInr),
        amount(exit.costBasisTaxInr),
        amount(exit.taxableGainInr),
        exit.disposalKind ?? 'SALE',
      ];
    }),
  };

  return [summary, lots, disposals];
}

/* --------------------------------------------------------------- property */

const PROPERTY_COLUMNS: readonly ExportColumn[] = [
  { label: 'Property', width: 110 },
  { label: 'Type', width: 74 },
  { label: 'Location', width: 120 },
  { label: 'Area', width: 66, numeric: true },
  { label: 'Unit', width: 56 },
  { label: 'Acquired', width: 60 },
  { label: 'Rate / unit', width: 70, numeric: true },
  { label: 'Consideration', width: 84, numeric: true },
  { label: 'Stamp duty', width: 70, numeric: true },
  { label: 'Registration', width: 70, numeric: true },
  { label: 'GST', width: 56, numeric: true },
];

const PROPERTY_VALUE_COLUMNS: readonly ExportColumn[] = [
  { label: 'Property', width: 140 },
  { label: 'Total tax', width: 90, numeric: true },
  { label: 'Total outlay', width: 90, numeric: true },
  { label: 'Current value', width: 90, numeric: true },
  { label: 'Valued on', width: 74 },
  { label: 'Basis', width: 120 },
];

/** ADR-013: the street address only leaves when the user asks for it. */
const locationOf = (property: ImmovableProperty | undefined, includePii: boolean): string => {
  const location = property?.location;
  if (location === undefined) return '';
  const city = [location.city, location.state].filter(Boolean).join(', ');
  if (!includePii) return city.length > 0 ? `${location.addressRef} (${city})` : location.addressRef;
  return [location.address, city, location.pincode].filter(Boolean).join(', ');
};

export function propertyTables(
  assets: readonly Asset[],
  options: ExportOptions,
): readonly ExportTable[] {
  const rows = assets.flatMap((asset) =>
    asset.lots.map((lot) => {
      const txn = lot.property;
      return [
        asset.property?.propertyName ?? labelOf(asset),
        asset.property?.kind ?? '',
        locationOf(asset.property, options.includePii),
        txn?.area?.value ?? asset.property?.area?.value ?? '',
        txn?.area?.unit ?? asset.property?.area?.unit ?? '',
        lot.acquisitionDate,
        amount(txn?.pricePerAreaUnit),
        amount(txn?.consideration),
        amount(txn?.stampDuty),
        amount(txn?.registrationFee),
        amount(txn?.gst),
      ];
    }),
  );

  const valueRows = assets.map((asset) => {
    const txn = asset.lots[0]?.property;
    return [
      asset.property?.propertyName ?? labelOf(asset),
      txn === undefined ? '' : amount(totalTaxOf(txn)),
      txn === undefined ? '' : amount(totalOutlayOf(txn)),
      amount(asset.property?.currentValue?.amount),
      asset.property?.currentValue?.asOf ?? '',
      // Never shown without its basis and date — a value with neither is the
      // figure the schema keeps out of a total.
      asset.property?.currentValue?.basis ?? '',
    ];
  });

  return [
    {
      title: 'portTrack — Immovable property',
      columns: PROPERTY_COLUMNS,
      notes: notesFor(options, ['One row per transaction, so a sale appears beside its purchase.']),
      rows,
    },
    {
      title: 'portTrack — Property duty and current value',
      columns: PROPERTY_VALUE_COLUMNS,
      notes: notesFor(options, [
        'Current value is optional, never summed into net worth, and is stated only with the basis and date that qualify it.',
      ]),
      rows: valueRows,
    },
  ];
}

/* --------------------------------------------------------------- balances */

const BALANCE_COLUMNS: readonly ExportColumn[] = [
  { label: 'Account', width: 130 },
  { label: 'Institution', width: 110 },
  { label: 'Kind', width: 96 },
  { label: 'From', width: 62 },
  { label: 'Rate', width: 46, numeric: true },
  { label: 'Contributed', width: 84, numeric: true },
  { label: 'Interest', width: 80, numeric: true },
  { label: 'Value', width: 86, numeric: true },
  { label: 'Status', width: 60 },
];

export function balanceTable(
  views: readonly BalanceView[],
  options: ExportOptions,
): ExportTable {
  return {
    title: 'portTrack — Deposits, retirement and cash',
    columns: BALANCE_COLUMNS,
    notes: notesFor(options, [
      'A blank rate means none was recorded, so the balance is carried flat rather than grown from an assumed one.',
    ]),
    rows: views.map((view) => [
      view.account.label,
      view.account.institutionName ?? '',
      view.account.kind,
      view.account.openedOn,
      view.account.annualRatePct ?? '',
      amount(view.contributed),
      amount(view.accruedInterest),
      amount(view.value),
      view.closed ? 'Closed' : view.matured ? 'Matured' : 'Open',
    ]),
  };
}
