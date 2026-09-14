/**
 * Error taxonomy. Two rules hold everywhere (DoD D6, D7):
 *  - expected domain failures are returned as `Result`, never thrown;
 *  - no error message, `cause` chain or field ever carries a PII value.
 */

export class NotImplementedError extends Error {
  constructor(
    public readonly storyId: string,
    symbol: string,
  ) {
    super(`${symbol} is not implemented yet (${storyId})`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(storyId: string, symbol: string): never {
  throw new NotImplementedError(storyId, symbol);
}

/** Base class for failures the caller is expected to handle. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
}
export class InvalidQuantityError extends DomainError {
  readonly code = 'INVALID_QUANTITY';
}
export class InsufficientQuantityError extends DomainError {
  readonly code = 'INSUFFICIENT_QUANTITY';
}
export class UnsupportedAssetClassError extends DomainError {
  readonly code = 'UNSUPPORTED_ASSET_CLASS';
}
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}
export class InvalidDateError extends DomainError {
  readonly code = 'INVALID_DATE';
}
export class RateUnavailableError extends DomainError {
  readonly code = 'RATE_UNAVAILABLE';
}
export class RateConflictError extends DomainError {
  readonly code = 'RATE_CONFLICT';
}
export class NotOfficialRateError extends DomainError {
  readonly code = 'NOT_OFFICIAL_RATE';
}
export class SnapshotImmutableError extends DomainError {
  readonly code = 'SNAPSHOT_IMMUTABLE';
}
export class SnapshotDivergenceError extends DomainError {
  readonly code = 'SNAPSHOT_DIVERGENCE';
}
export class FutureSnapshotError extends DomainError {
  readonly code = 'FUTURE_SNAPSHOT';
}
export class XirrNonConvergenceError extends DomainError {
  readonly code = 'XIRR_NON_CONVERGENCE';
}
export class TaxRulesUnavailableError extends DomainError {
  readonly code = 'TAX_RULES_UNAVAILABLE';
}
export class TemplateHeaderMismatchError extends DomainError {
  readonly code = 'TEMPLATE_HEADER_MISMATCH';
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
    readonly unexpected: readonly string[] = [],
  ) {
    super(message);
  }
}
export class PdfDecryptionError extends DomainError {
  readonly code = 'PDF_DECRYPTION_FAILED';
}
export class UnknownCasLayoutError extends DomainError {
  readonly code = 'UNKNOWN_CAS_LAYOUT';
}
export class PiiLeakError extends DomainError {
  readonly code = 'PII_LEAK';
  constructor(
    message: string,
    /** Category of the offending entity. NEVER the entity value itself. */
    readonly entityKind: string,
  ) {
    super(message);
  }
}
/**
 * A new hand loan matches one already on the book. Not a refusal — a question.
 *
 * The matching loan ids travel on the error so the caller can show the lender
 * what they are about to duplicate. Ids only: `loanIds` reaches the HTTP layer,
 * and a borrower's name must not (ADR-013). The names shown alongside are read
 * from the vault by the browser, which already holds them.
 */
export class DuplicateLoanError extends DomainError {
  readonly code = 'DUPLICATE_LOAN';
  constructor(
    message: string,
    readonly loanIds: readonly string[],
  ) {
    super(message);
  }
}
/**
 * A trade matches one already on the ledger. Also a question, not a refusal.
 *
 * Two fills of one order, on one day, at one price is ordinary — and the natural
 * key that makes a re-imported statement idempotent cannot distinguish it from
 * the same trade typed twice.
 */
export class DuplicateTradeError extends DomainError {
  readonly code = 'DUPLICATE_TRADE';
  constructor(
    message: string,
    /** Instrument identifiers, never a folio holder's name. */
    readonly identifiers: readonly string[],
  ) {
    super(message);
  }
}
export class VaultUnlockError extends DomainError {
  readonly code = 'VAULT_UNLOCK_FAILED';
}
/**
 * A change to an existing record, or a deletion, was attempted while edit mode
 * was off.
 *
 * Separate from `VaultStateError` on purpose: an unlocked vault that refuses an
 * edit is a different situation from a locked one, and the caller's remedy
 * differs — the first is fixed by turning edit mode on, the second by unlocking.
 * Collapsing them would have the UI tell a user to unlock a vault that is
 * already open.
 */
export class EditModeRequiredError extends DomainError {
  readonly code = 'EDIT_MODE_REQUIRED';
}
export class VaultStateError extends DomainError {
  readonly code = 'VAULT_STATE';
}
export class MigrationError extends DomainError {
  readonly code = 'MIGRATION_FAILED';
}
export class EgressDeniedError extends DomainError {
  readonly code = 'EGRESS_DENIED';
}
