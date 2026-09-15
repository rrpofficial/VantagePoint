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
  IncomeUC,
  LiabilityUC,
  PropertyUC,
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
  type RecordIncomeInput,
  type RecordBorrowedLoanInput,
  type RecordBorrowedPaymentInput,
  type BorrowedQuery,
  type DerivedOtherSources,
  type RecordPropertyInput,
  type RecordPropertyResult,
  type PropertyAdvisory,
  type RecordTradeInput,
  type RecordTradeResult,
  type TemplateSummary,
} from './use-cases.js';

export {
  EditModeUC,
  requireEditMode,
  resetEditMode,
  type EditModeState,
} from './edit-mode.js';

export { BackupUC, type BackupArchive, type RestoreReport } from './backup-uc.js';

export {
  ExportUC,
  type ExportedFile,
  type ExportRegister,
  type ExportRequest,
} from './export-uc.js';

export {
  BalanceUC,
  type BalanceRegister,
  type BalanceTotals,
} from './balance-uc.js';

export {
  ForeignDisclosureUC,
  MarksUC,
  type FaReadiness,
  type HoldingReadiness,
  type RecordForeignAccountInput,
  type RecordForeignDetailInput,
} from './foreign-disclosure-uc.js';
export {
  BALANCE_CLASSES,
  accountRefOf,
  balanceAssetIdOf,
  buildBalanceEntry,
  type BalanceClassOption,
  type RecordBalanceInput,
} from './balance-entry.js';

export {
  DEFAULT_INCOME_INCLUSIONS,
  IncomeInclusionsUC,
  enabledInclusionLabels,
  incomeInclusionsOf,
  loadIncomeInclusions,
  resetIncomeInclusions,
  saveIncomeInclusions,
  type IncomeInclusions,
} from './income-inclusions.js';

export {
  RatesUC,
  type ImportRatesInput,
  type ImportRatesReport,
  type RateCoverage,
} from './rates.js';

export {
  stampForeignRates,
  type RateStampResult,
  type UnpricedLeg,
} from './foreign-rates.js';

export { useVaultRateStore, useMemoryRateStore, vaultRateStore } from './vault-rate-store.js';
export { vaultFxSource } from './fx-source.js';

export {
  configure,
  currentPorts,
  resetPorts,
  type AppContext,
  type AssetSource,
  type LiabilitySource,
  type Ports,
} from './context.js';
