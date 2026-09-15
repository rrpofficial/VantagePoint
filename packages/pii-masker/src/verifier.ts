/**
 * Fail-closed egress verification (US-7.4, ADR-007).
 *
 * Runs on the POST-mask payload, immediately before dispatch. Any residual PII
 * aborts the call — there is no warn-and-continue path, because a masker that
 * "mostly" works is indistinguishable from one that does not.
 *
 * ⚠ **Known limit, stated rather than glossed:** this catches anything with a
 * SHAPE — PAN, Aadhaar, demat IDs, contacts, transaction IDs — and it re-runs the
 * name detector to catch a pipeline that forgot to mask. It CANNOT catch a name
 * the detector never recognised, because names have no shape. The plan's original
 * risk mitigation (R5) claimed this guard was the backstop for NER false
 * negatives; that claim was wrong and is corrected in the plan.
 */
import { Err, Ok, PiiLeakError, type Result } from '@vantagepoint/shared-kernel';
import { detect } from './regex-rules.js';
import { detectPersonNames } from './ner.js';
import type { PiiKind } from './types.js';

/**
 * Redaction tokens are removed before scanning. They are proper-noun shaped, so
 * leaving them in makes the guard flag its own output and refuse every correctly
 * masked payload — failing closed on nothing at all.
 */
const REDACTION_TOKEN_PATTERN = /\[REDACTED_[A-Z_]+(?:_\d+)?\]/g;

export function scan(payload: string): readonly PiiKind[] {
  const withoutTokens = payload.replace(REDACTION_TOKEN_PATTERN, ' ');
  const kinds = new Set<PiiKind>();
  for (const entity of detect(withoutTokens)) kinds.add(entity.kind);
  // Independent re-detection: catches a payload that skipped the name pass.
  for (const entity of detectPersonNames(withoutTokens)) kinds.add(entity.kind);
  return [...kinds];
}

export function assertClean(payload: string): Result<void> {
  const found = scan(payload);
  if (found.length === 0) return Ok(undefined);

  // Reports the KIND only. Echoing the offending value into an error message
  // would leak the very thing being guarded, into a log that is usually kept.
  return Err(
    new PiiLeakError(
      `outbound payload still contains ${found.join(', ')} — dispatch aborted`,
      found.join(','),
    ),
  );
}
