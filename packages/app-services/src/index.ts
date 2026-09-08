/**
 * app-services — use-case orchestration. The only layer `apps/*` may call.
 *
 * Composition, not computation: each use case wires pure engines to persistence
 * and returns. Any business rule appearing here belongs in a domain package.
 */
export {
  AuditUC,
  ChitUC,
  CompareSnapshotsUC,
  ComputeAdvanceTaxUC,
  GenerateComplianceUC,
  GenerateSnapshotUC,
  ImportStatementUC,
  LedgerUC,
  ListSnapshotsUC,
  LoanUC,
  MANUAL_TRADE_CLASSES,
  ReferenceUC,
  TemplateUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  setIncomeProfile,
  saveIncomeProfile,
  loadIncomeProfile,
  hasIncomeProfile,
  incomeProfileOf,
  recordLogLine,
  clearApplicationLog,
  type CalendarYearOption,
  type ChitQuery,
  type EditChitInput,
  type FinancialYearOption,
  type OpenChitInput,
  type RecordChitEmiInput,
  type DuplicateLoanMatch,
  type GenerateComplianceUCOps,
  type LoanQuery,
  type Periods,
  type ManualTradeClass,
  type RecordLoanInput,
  type RecordPaymentInput,
  type RecordTradeInput,
  type RecordTradeResult,
  type TemplateSummary,
} from './use-cases.js';

export {
  configure,
  currentPorts,
  resetPorts,
  type AppContext,
  type AssetSource,
  type LiabilitySource,
  type Ports,
} from './context.js';
