/**
 * CAMS / KFintech Consolidated Account Statement parser (US-4.2, PRD FR-4 AC).
 *
 * Two constraints shape this:
 *
 *  • **The password is never persisted (NFR-1).** It is used to derive the file
 *    key, then the buffer holding it is overwritten. It never reaches a log, an
 *    error message, or the parse result — the "wrong password" path is tested
 *    precisely because that is where a naive implementation echoes it back.
 *
 *  • **Folio numbers are PII (FR-7.2).** The parser emits an opaque, deterministic
 *    reference rather than the folio itself, so a folio cannot leak through a
 *    payload that was never masked. The raw value belongs in the encrypted vault.
 *
 * Layout handling is intentionally narrow (plan risk R2): a statement whose shape
 * is not recognised is REFUSED, not guessed at. A mis-parsed CAS silently
 * misstates units and NAV, which flows straight into a capital gains figure.
 */
import { Err, Ok, PdfDecryptionError, UnknownCasLayoutError, Money, type Result } from '@vantagepoint/shared-kernel';
import { normaliseDate } from './csv.js';
import { decryptStream, extractText, readEncryptInfo, readStreams } from './pdf/reader.js';
import { verifyUserPassword } from './pdf/standard-security.js';
import { deterministicImportedAt, folioRef, provenanceFor } from './provenance.js';
import type { CamsParseInput, ParsedTransaction, TransactionKind } from './types.js';

/**
 * A statement row: folio, ISIN, scheme, date, transaction, units, NAV.
 * Columns are whitespace-aligned, so the ISIN anchors the match — it is the only
 * field with a rigid shape.
 */
const ROW = /^(\S+)\s+(INF\w+)\s+(.+?)\s{2,}(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s{2,}([\d.]+)\s+([\d.]+)$/;

const KIND: readonly (readonly [RegExp, TransactionKind])[] = [
  [/redemption|redeem/i, 'SELL'],
  [/reinvest/i, 'REINVESTMENT'],
  [/dividend|payout/i, 'DIVIDEND'],
  [/purchase|switch in|sip/i, 'BUY'],
];

function kindOf(label: string): TransactionKind | undefined {
  for (const [pattern, kind] of KIND) if (pattern.test(label)) return kind;
  return undefined;
}

export function parseCams(input: CamsParseInput): Promise<Result<readonly ParsedTransaction[]>> {
  return Promise.resolve(parseCamsSync(input));
}

function parseCamsSync(input: CamsParseInput): Result<readonly ParsedTransaction[]> {
  const pdf = Buffer.from(input.pdf);
  const encryption = readEncryptInfo(pdf);
  if (encryption === undefined) {
    return Err(new UnknownCasLayoutError('statement is not an encrypted PDF in a recognised form'));
  }

  // Held only long enough to derive the key, then overwritten.
  const passwordBuffer = Buffer.from(input.password, 'latin1');
  const { valid, fileKey } = verifyUserPassword(
    input.password,
    encryption.ownerEntry,
    encryption.userEntry,
    encryption.permissions,
    encryption.firstId,
    encryption.keyLength,
  );
  passwordBuffer.fill(0);

  if (!valid) {
    // Deliberately says nothing about the attempted password.
    return Err(new PdfDecryptionError('statement could not be decrypted with the supplied password'));
  }

  const lines = readStreams(pdf).flatMap((stream) => extractText(decryptStream(stream, fileKey)));
  const importedAt = deterministicImportedAt('cams-cas');
  const transactions: ParsedTransaction[] = [];

  for (const [index, line] of lines.entries()) {
    const match = ROW.exec(line.trim());
    if (match === null) continue;

    const [, folio, isin, scheme, rawDate, label, units, nav] = match;
    const date = normaliseDate(rawDate ?? '');
    const kind = kindOf(label ?? '');
    if (date === undefined || kind === undefined) continue;

    transactions.push({
      kind,
      date,
      isin: isin ?? '',
      schemeName: (scheme ?? '').trim(),
      // Opaque by construction: the folio itself never enters the payload.
      folioRef: folioRef(folio ?? ''),
      quantity: units ?? '0',
      pricePerUnit: Money.of(nav ?? '0', 'INR'),
      provenance: provenanceFor('cams-cas', index + 1, 'CAMS', importedAt),
    });
  }

  if (transactions.length === 0) {
    return Err(
      new UnknownCasLayoutError(
        'no statement rows recognised — the layout may have changed; use the CSV template instead',
      ),
    );
  }

  fileKey.fill(0);
  return Ok(transactions);
}
