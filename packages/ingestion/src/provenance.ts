/**
 * Provenance and opaque references (US-4.1).
 *
 * Folio and account numbers are PII (FR-7.2). They are therefore never carried
 * through the pipeline in the clear: a parser emits a deterministic opaque
 * reference instead, which is stable enough for duplicate detection while the raw
 * value stays in the encrypted vault. Deriving the reference by hash rather than
 * by masking keeps it collision-free without being reversible from the payload.
 */
import { createHash } from 'node:crypto';
import type { ParserName, Provenance } from './types.js';

export function folioRef(rawFolio: string): string {
  return `folio_${createHash('sha256').update(rawFolio.trim()).digest('hex').slice(0, 16)}`;
}

export function accountRef(rawAccount: string): string {
  return `acct_${createHash('sha256').update(rawAccount.trim()).digest('hex').slice(0, 16)}`;
}

/**
 * A borrower's name is the most identifying field in the whole product — it is a
 * private individual who never consented to being in anyone's dataset. It is
 * hashed at the parser boundary so the raw name exists only in the encrypted
 * vault, never in a payload, a log line or an export.
 */
export function borrowerRef(rawName: string): string {
  return `brw_${createHash('sha256').update(rawName.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

/**
 * A property's street address, hashed at the parser boundary like a borrower's
 * name and for the same reason: it identifies a household that never consented
 * to being in anyone's dataset. The plain address lives only in the encrypted
 * vault; this is what an export or an AI payload carries.
 *
 * Deterministic, so the same address resolves to the same reference across
 * entries rather than fragmenting one property into several.
 */
export function addressRef(rawAddress: string): string {
  return `addr_${createHash('sha256').update(rawAddress.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

export function provenanceFor(
  sourceFile: string,
  sourceRow: number,
  parserName: ParserName,
  importedAt: string,
): Provenance {
  return { sourceFile, sourceRow, parserName, importedAt };
}

/**
 * Import timestamps are derived from the file being imported, not the wall clock:
 * re-importing the same file must produce byte-identical records so duplicate
 * detection and the determinism test both hold.
 */
export function deterministicImportedAt(sourceFile: string): string {
  const digest = createHash('sha256').update(sourceFile).digest('hex').slice(0, 8);
  return `import:${digest}`;
}
