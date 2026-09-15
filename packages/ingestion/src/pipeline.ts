/**
 * Ingestion pipeline (US-4.1): parse → validate → stage → reconcile → commit.
 *
 * Strict mode is atomic — one bad row and NOTHING is committed. That is the right
 * default for a tax record: a half-imported tradebook produces a portfolio that
 * looks complete and silently understates a capital gain. Lenient mode exists for
 * the case where the user has seen the rejections and wants the rest anyway, and
 * it still reports every rejected row rather than dropping it quietly.
 */
import { Err, Ok, UnsupportedAssetClassError, type Result } from '@porttrack/shared-kernel';
import { parseCams } from './cams.js';
import { parseEtrade, parseVested, parseZerodhaTradebook, type ParseOutcome } from './brokers.js';
import { parseEtradeGainsLosses } from './etrade-gl.js';
import { parseEtradeHoldings } from './etrade-holdings.js';
import { parseTemplateFile } from './templates.js';
import { partition } from './duplicates.js';
import type { ImportReport, IngestInput } from './types.js';

async function runParser(input: IngestInput): Promise<Result<ParseOutcome>> {
  const text = Buffer.from(input.file).toString('utf8');

  switch (input.parser) {
    case 'ZERODHA_TRADEBOOK':
    case 'ZERODHA_TAX_PNL':
      return parseZerodhaTradebook(text, input.fileName);
    case 'VESTED':
      return parseVested(text, input.fileName);
    case 'ETRADE':
      return parseEtrade(text, input.fileName);
    case 'ETRADE_GL':
      return parseEtradeGainsLosses(text, input.fileName);
    case 'ETRADE_HOLDINGS':
      return parseEtradeHoldings(text, input.fileName);
    case 'TEMPLATE': {
      const parsed = parseTemplateFile(text, input.fileName, input.templateName);
      // Row errors are carried through, not swallowed: a template is hand-edited,
      // so a typo in one row is the normal case and the user needs to see which.
      return parsed.ok
        ? Ok({ transactions: parsed.value.transactions, errors: parsed.value.errors })
        : parsed;
    }
    case 'CAMS': {
      const parsed = await parseCams({ pdf: input.file, password: input.password ?? '' });
      return parsed.ok ? Ok({ transactions: parsed.value, errors: [] }) : parsed;
    }
    case 'MANUAL':
      // A hand-typed trade has no file to parse. It reaches the ledger through
      // TradeUC, which builds the transaction directly and hands it to the same
      // projection this pipeline feeds.
      return Err(
        new UnsupportedAssetClassError('a manual trade is not imported from a file'),
      );
  }
}

export async function ingest(input: IngestInput): Promise<Result<ImportReport>> {
  const parsed = await runParser(input);
  if (!parsed.ok) return parsed;

  const { transactions, errors } = parsed.value;

  if (input.mode === 'STRICT' && errors.length > 0) {
    // Nothing staged, nothing committed — the caller sees every problem at once.
    return Ok({
      created: 0,
      duplicates: 0,
      rejected: errors.length,
      errors,
      committed: false,
    });
  }

  const { fresh, duplicates } = partition(transactions, input.existingKeys ?? []);

  return Ok({
    created: fresh.length,
    duplicates: duplicates.length,
    rejected: errors.length,
    errors,
    committed: true,
    transactions: fresh,
  });
}
