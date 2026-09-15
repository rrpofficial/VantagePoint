/**
 * exporters — one CSV and PDF surface for every register (Phase 7).
 *
 * Pure. No I/O, no clock: the generated-on stamp arrives as an argument, so an
 * export is reproducible and a test can assert its bytes.
 *
 * Two constraints are structural rather than stylistic:
 *
 *  - **ADR-002.** No `Number()` and no arithmetic on an amount anywhere in this
 *    package. A cell is the decimal string the domain produced, carried to the
 *    byte. A CSV cell that round-tripped through a float is a corrupted figure
 *    that still looks fine.
 *  - **ADR-010.** Nothing here reaches the network, and nothing may acquire a
 *    dependency that could. The PDF writer is 200 lines of hand-written PDF 1.4
 *    precisely so the package has no supply chain.
 */
export {
  csvCell,
  toCsv,
  toMultiCsv,
  toPdf,
  type ExportColumn,
  type ExportTable,
} from './table.js';

export {
  balanceTable,
  chitTable,
  holdingTables,
  piiNote,
  propertyTables,
  type ExportOptions,
} from './registers.js';
