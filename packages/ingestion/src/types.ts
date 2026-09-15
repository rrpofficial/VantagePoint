/** Ingestion types. Types only — no runtime behaviour. */
import type { IsoDate, IsoDateTime, Money, Quantity } from '@porttrack/shared-kernel';
import type {
  EquityAward,
  ImmovableProperty,
  PropertyTransaction,
} from '@porttrack/core-domain';

/**
 * `MANUAL` is not a file format — it is a trade typed into the app by hand.
 *
 * It is a ParserName so that a manual entry travels the SAME projection as an
 * imported one: identical FIFO, identical asset identity, identical disposal
 * handling. A parallel write path for manual trades would be a second engine to
 * keep in step with the first, and the two would drift.
 */
export type ParserName =
  | 'CAMS'
  | 'ZERODHA_TRADEBOOK'
  | 'ZERODHA_TAX_PNL'
  | 'VESTED'
  | 'ETRADE'
  /**
   * E*TRADE Gains & Losses (Expanded) — a different document from `ETRADE`, which
   * reads the transaction history. Separate rather than auto-detected: the two
   * files describe the same account and disagree about what a row means, and
   * picking the wrong reader silently produces a wrong cost basis.
   */
  | 'ETRADE_GL'
  /** E*TRADE "By Status → Sellable": open stock-plan tranches. */
  | 'ETRADE_HOLDINGS'
  | 'TEMPLATE'
  | 'MANUAL';
export type ImportMode = 'STRICT' | 'LENIENT';

export interface RowError {
  readonly row: number;
  readonly column: string;
  readonly value: string;
  readonly reason: string;
  readonly expectedFormat?: string;
}

export interface Provenance {
  readonly sourceFile: string;
  readonly sourceRow: number;
  readonly parserName: ParserName;
  readonly importedAt: IsoDateTime;
}

export interface ParsedLoanPayment {
  readonly date: IsoDate;
  readonly amount: Money;
}

/** Loan terms, present only on a hand-loan row. */
export interface ParsedHandLoan {
  /** Opaque; used for anything that leaves the machine (FR-7.2). */
  readonly borrowerRef: string;
  /** Kept for the register, which is filtered and sorted by it. Vault only. */
  readonly borrowerName: string;
  readonly interestRatePct: string;
  readonly interestBasis: 'SIMPLE' | 'COMPOUND';
  readonly startDate: IsoDate;
  readonly closedDate?: IsoDate;
  readonly notes?: string;
  readonly principalRepayments: readonly ParsedLoanPayment[];
  readonly interestPayments: readonly ParsedLoanPayment[];
  /**
   * The status the SOURCE claimed. Status is derived from repayments, so this is
   * used only to reconstruct a repayment the sheet had no column for: a loan
   * marked Repaid with no repayment rows must still show its principal back.
   */
  readonly declaredStatus?: 'ACTIVE' | 'PARTIALLY_REPAID' | 'REPAID';
}

/**
 * A figure the source stated that the engine computes differently.
 *
 * Neither value is discarded and neither silently wins: a spreadsheet cell can
 * be stale, but it can equally be catching a mistake here, and the only useful
 * thing to do with a disagreement about money is show it to the person who
 * knows which is right.
 */
export interface ReconciliationNote {
  readonly row: number;
  readonly field: string;
  readonly stated: string;
  readonly computed: string;
}

export interface ParsedTransaction {
  readonly kind: 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE' | 'RSU_VEST' | 'ESPP_PURCHASE' | 'REINVESTMENT';
  readonly date: IsoDate;
  readonly symbol?: string;
  readonly isin?: string;
  readonly folioRef?: string;
  readonly schemeName?: string;
  readonly quantity: Quantity;
  readonly pricePerUnit: Money;
  readonly perquisiteValue?: Money;
  /**
   * Set only when the SOURCE FORMAT states it — a portTrack template says which
   * asset class it holds; a broker CSV does not. Left absent rather than guessed,
   * because asset class drives tax treatment and a wrong guess is invisible.
   */
  readonly assetClass?: string;
  readonly fees?: Money;
  readonly otherCharges?: Money;
  readonly handLoan?: ParsedHandLoan;
  /**
   * Grant, tranche and order detail, where the source states them.
   *
   * Carried through the pipeline so the projector can give the lot an identity
   * derived from the GRANT rather than from the file it was read from — which is
   * what lets the same vest, seen in a Gains & Losses export and in a holdings
   * export, resolve to one lot instead of two.
   */
  readonly equityAward?: EquityAward;
  /**
   * True when `quantity` is only PART of the tranche this row belongs to.
   *
   * A Gains & Losses row states the units one sale disposed of, not the size of
   * the vest — and one tranche is routinely sold across several orders, so two
   * such rows describe two slices of one lot. They must therefore SUM.
   *
   * A holdings export states the tranche whole, and is authoritative: once one
   * has been seen, further partial statements of the same tranche add nothing
   * and must not inflate it.
   *
   * Getting this wrong is silent. Taking the largest slice instead of the sum
   * leaves the lot undersized, the second disposal then cannot be matched to it,
   * and it falls back to FIFO against some unrelated tranche — which changes the
   * cost basis and the gain, and only shows up as a figure that differs
   * depending on which file was imported first.
   */
  readonly lotQuantityIsPartial?: boolean;
  /**
   * What the SOURCE claims is still held of this tranche.
   *
   * Set by a holdings export, which states both the tranche's original size and
   * what is left of it. The lot is created at the original size and depleted by
   * the disposals on record; this is the independent figure that depletion is
   * checked against. A disagreement is disposal history that was never imported
   * — the one gap a user cannot otherwise find.
   */
  readonly statedRemainingQuantity?: Quantity;
  /**
   * The market price per unit the SOURCE stated, where it states one.
   *
   * A holdings statement reports what the position is worth today as well as
   * what it cost. Carried through so the import can record it: with no outbound
   * network (ADR-010) this is the only way a market price ever reaches the
   * product, and without it every holding is valued at cost.
   */
  readonly marketPricePerUnit?: Money;
  /**
   * Immovable property detail, where the row describes one.
   *
   * Carried through the pipeline so a manual entry and a template import reach
   * the ledger by the same route. The projector writes it onto the lot or the
   * exit; the canonical money fields on this transaction still decide the cost
   * basis, and `propertyChargesOf` is what keeps the two in step.
   */
  readonly property?: PropertyTransaction;
  /** The property itself, on a row that creates or updates one. */
  readonly propertyDetail?: ImmovableProperty;
  /** Set on a SELL. Flags the block sold on vest day to fund withholding. */
  readonly disposalKind?: 'SALE' | 'SELL_TO_COVER';
  /** The broker's order identifier, where the source states one. */
  readonly orderRef?: string;
  readonly provenance: Provenance;
}

export interface ImportReport {
  readonly created: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly errors: readonly RowError[];
  readonly committed: boolean;
  /** Staged records, present only when the import committed. */
  readonly transactions?: readonly ParsedTransaction[];
  /**
   * Rows that parsed cleanly but could not be placed on the ledger — an
   * account-level fee with no lot to attach to, a sell with no matching holding.
   * Surfaced rather than dropped: a row the user believes was imported and that
   * silently vanished is the worst outcome an import can produce.
   */
  readonly unapplied?: readonly {
    readonly kind: ParsedTransaction['kind'];
    readonly date: IsoDate;
    readonly symbol?: string;
    readonly sourceRow: number;
    readonly reason: string;
  }[];
  /** Stated figures that the engine recomputed differently. Never silent. */
  readonly reconciliation?: readonly ReconciliationNote[];
  /**
   * Foreign records stored WITHOUT an INR value, because no exchange rate could
   * be resolved for their Rule 115 basis date.
   *
   * The rows imported fine; what is missing is their rupee value. Reported
   * rather than approximated — an invented rate produces a tax figure that looks
   * entirely ordinary and is wrong.
   */
  readonly unpriced?: readonly {
    readonly kind: 'LOT' | 'EXIT';
    readonly id: string;
    readonly currency: string;
    readonly onDate: IsoDate;
    readonly reason: string;
  }[];
}

export interface IngestInput {
  readonly file: Uint8Array;
  readonly fileName: string;
  readonly parser: ParserName;
  readonly mode: ImportMode;
  readonly password?: string;
  /**
   * Which portTrack template this is meant to be, when the user chose one.
   *
   * Optional: the template is still identified from its header, so an import
   * works without it. Supplying it turns a generic "matches no template" into a
   * diff naming the exact columns at fault, and catches a file uploaded under
   * the wrong template — which would otherwise import as the wrong asset class.
   */
  readonly templateName?: string;
  /** Natural keys already in the ledger, for duplicate detection (US-4.7). */
  readonly existingKeys?: readonly string[];
}

export type TransactionKind = ParsedTransaction['kind'];

export interface CamsParseInput {
  readonly pdf: Uint8Array;
  readonly password: string;
}
