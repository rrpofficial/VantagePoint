/**
 * ingestion — the pipeline and every statement parser. Pure: parsers take bytes
 * or text and return data; nothing here touches the filesystem or the network.
 */
import { parseCams } from './cams.js';
import {
  compareRealisedGains,
  parseEtrade,
  parseVested,
  parseZerodhaTradebook,
} from './brokers.js';
import {
  detectTemplate,
  generateTemplate,
  listTemplates,
  parseTemplate,
  templateDefinitions,
  validateHeaders,
} from './templates.js';
import { parseEtradeGainsLosses } from './etrade-gl.js';
import { parseEtradeHoldings } from './etrade-holdings.js';
import { naturalKey, partition } from './duplicates.js';
import { ingest } from './pipeline.js';
import { ledgerNaturalKeys, projectToLedger } from './ledger.js';

export * from './types.js';
export type { LedgerProjection, UnappliedTransaction } from './ledger.js';
export { TEMPLATES, type TemplateDefinition } from './templates.js';
export type { ParseOutcome } from './brokers.js';

/** US-4.1 — parse → validate → stage → reconcile → commit. */
export const Pipeline = { ingest };

/** US-4.1 — parsed rows become holdings, lots and income events. */
export const LedgerProjector = { project: projectToLedger, naturalKeys: ledgerNaturalKeys };
export { ledgerNaturalKeys } from './ledger.js';

/** US-4.2 — CAMS / KFintech consolidated account statements. */
export const CamsCasParser = { parse: parseCams };

/** US-4.3 — Zerodha tradebook and tax P&L. */
export const ZerodhaTradebookParser = {
  parse: (csv: string, fileName: string) => {
    const parsed = parseZerodhaTradebook(csv, fileName);
    return parsed.ok ? { ok: true as const, value: parsed.value.transactions } : parsed;
  },
};
export const ZerodhaTaxPnlParser = ZerodhaTradebookParser;
export const ReconciliationExceptions = { compareRealisedGains };

/** US-4.4 — Vested account activity. */
export const VestedParser = {
  parse: (csv: string, fileName: string) => {
    const parsed = parseVested(csv, fileName);
    return parsed.ok ? { ok: true as const, value: parsed.value.transactions } : parsed;
  },
};

/** US-4.5 — E*TRADE transaction history. */
export const EtradeParser = {
  parse: (csv: string, fileName: string) => {
    const parsed = parseEtrade(csv, fileName);
    return parsed.ok ? { ok: true as const, value: parsed.value.transactions } : parsed;
  },
};

/**
 * US-4.5b — E*TRADE Gains & Losses (Expanded).
 *
 * Each row is a closed round trip, so one row yields TWO transactions: the
 * acquisition and the disposal that ended it. That is what lets each leg be
 * converted at its own Rule 115 basis month.
 */
export const EtradeGainsLossesParser = {
  parse: (csv: string, fileName: string) => {
    const parsed = parseEtradeGainsLosses(csv, fileName);
    return parsed.ok ? { ok: true as const, value: parsed.value.transactions } : parsed;
  },
  /**
   * The full outcome, transactions AND row errors.
   *
   * Exposed alongside the narrowed `parse` because this format rejects by row as
   * a matter of course — 47 columns, hand-exportable, one unparseable date in an
   * otherwise good file — so a caller that can only see the transactions cannot
   * tell a clean import from one that dropped a disposal.
   */
  parseWithErrors: parseEtradeGainsLosses,
};

/**
 * US-4.5d — E*TRADE "By Status → Sellable": the tranches still held.
 *
 * The other half of the G&L export. Together they account for a grant in full:
 * one states what was disposed of, the other what remains, and they merge on the
 * same grant-and-tranche identity rather than duplicating.
 */
export const EtradeHoldingsParser = {
  parse: (csv: string, fileName: string) => {
    const parsed = parseEtradeHoldings(csv, fileName);
    return parsed.ok ? { ok: true as const, value: parsed.value.transactions } : parsed;
  },
  parseWithErrors: parseEtradeHoldings,
};

/** US-4.6 — standardised CSV templates. */
export const TemplateParser = { parse: parseTemplate };
export const TemplateRegistry = {
  list: listTemplates,
  /** Full definitions — name, columns, asset class and guidance — for the UI. */
  definitions: templateDefinitions,
  generate: generateTemplate,
  detect: detectTemplate,
  validateHeaders,
};

/** US-4.7 — idempotent re-import. */
export const DuplicateDetector = { naturalKey, partition };

/**
 * Opaque references for PII (FR-7.2). Exported so every caller derives a
 * borrower's reference identically — two different hashes for one person would
 * split their loans across two identities in the register.
 */
export { accountRef, borrowerRef, folioRef } from './provenance.js';
