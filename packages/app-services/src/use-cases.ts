/**
 * Use-case orchestration (US-8.11 and the functional half of EPIC-3/5).
 *
 * Every use case is a thin composition of pure engines plus persistence. No
 * business rule lives here — if a calculation appears in this file it is in the
 * wrong layer, and the API's "thin shell" test exists to keep it that way.
 */
import {
  DuplicateLoanError,
  DuplicateTradeError,
  Err,
  FutureSnapshotError,
  FyCalendar,
  Money,
  Ok,
  VaultStateError,
  type EgressAuditEntry,
  type FinancialYear,
  type IsoDate,
  type IsoDateTime,
  type Money as MoneyValue,
  type Quarter,
  type Result,
} from '@porttrack/shared-kernel';
import { createHash } from 'node:crypto';
import {
  ChitLedger,
  FifoAllocator,
  HandLoanLedger,
  LoanExporter,
  ValuationEngine,
  applyLoanEdit,
  loanDuplicatesOf,
  type Asset,
  type ChitEmiType,
  type ChitFund,
  type ChitRegister,
  type ChitSortKey,
  type ChitStatus,
  type ChitWithdrawalSchedule,
  type ExitTransaction,
  type HandLoan,
  type Liability,
  type LoanAuditAction,
  type LoanAuditEntry,
  type LoanEdit,
  type LoanRegister,
  type LoanSortKey,
  type LoanStatus,
  type PaymentMode,
  type PortfolioValuation,
  type SortDirection,
} from '@porttrack/core-domain';
import { borrowerRef } from '@porttrack/ingestion';
import {
  ScheduleAlGenerator,
  ScheduleFaGenerator,
  type ScheduleAl,
  type ScheduleFaA3Row,
  type ScheduleFaDRow,
} from '@porttrack/compliance';
import {
  CompliancePolicy,
  DeltaEngine,
  SnapshotFactory,
  type Snapshot,
  type SnapshotSpec,
  type VarianceReport,
} from '@porttrack/snapshot';
import {
  AdvanceTaxEngine,
  HniClassifier,
  SlabCalculator,
  TaxRuleTable,
  type AdvanceTaxInstallment,
  type HniClassification,
  type IncomeProfile,
  type RegimeComparison,
} from '@porttrack/tax-engine';
import {
  LedgerProjector,
  ledgerNaturalKeys,
  Pipeline,
  TemplateRegistry,
  type ImportMode,
  type ImportReport,
  type ParserName,
} from '@porttrack/ingestion';
import {
  AssetRepository,
  ChitScheduleRepository,
  ExitRepository,
  LiabilityRepository,
  LoanAuditRepository,
  SettingsRepository,
  SnapshotRepository,
  Vault,
  type SnapshotSummary,
} from '@porttrack/persistence';
import { currentPorts } from './context.js';
import { requireEditMode, resetEditMode } from './edit-mode.js';

/* ------------------------------------------------------------------- vault */

export const VaultUC = {
  async unlock(passphrase: string) {
    const result = await Vault.unlock(passphrase);
    if (!result.ok) return result;
    // Vault-backed state can only be read once the key exists.
    await loadIncomeProfile();
    currentPorts().logger.info('vault unlocked');
    return Ok({ dataDir: '', unlocked: true });
  },
  async lock(): Promise<void> {
    await Vault.lock();
    // Salary is as sensitive as holdings; it must not outlive the session in
    // memory once the vault it came from is closed.
    setIncomeProfile(undefined);
    // The passphrase was entered to open one window on one session. Leaving edit
    // mode on across a lock would hand the next person who unlocks a permission
    // they never asked for.
    resetEditMode();
  },
  /** Exposed so the API can answer readiness without importing persistence. */
  isUnlocked(): boolean {
    return Vault.isUnlocked();
  },
};

const requireUnlocked = (): Result<void> =>
  Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));

/* --------------------------------------------------------------- valuation */

export const ValuePortfolioUC = {
  async execute(asOf: IsoDateTime): Promise<Result<PortfolioValuation>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const ports = currentPorts();
    // Awaited because the production source is the vault; a test fixture that
    // returns a plain array still satisfies this.
    const [assets, liabilities] = await Promise.all([ports.assets(), ports.liabilities()]);

    return Ok(
      ValuationEngine.value({
        assets,
        liabilities,
        asOf,
        ...(ports.prices === undefined ? {} : { prices: ports.prices }),
        ...(ports.fx === undefined ? {} : { fx: ports.fx }),
      }),
    );
  },
};

/* ---------------------------------------------------------------- snapshots */

async function buildSnapshot(spec: SnapshotSpec, createdAt?: IsoDateTime): Promise<Result<Snapshot>> {
  const valuation = await ValuePortfolioUC.execute(spec.asOf);
  if (!valuation.ok) return valuation;

  const built = SnapshotFactory.build({
    spec,
    valuation: valuation.value,
    // A scheduled snapshot is created at the instant the scheduler ran, not at
    // whatever the ambient clock says: the two differ whenever a run is replayed
    // or caught up, and using the clock would reject a legitimate catch-up as
    // "future-dated".
    createdAt: createdAt ?? currentPorts().clock.now(),
  });
  if (!built.ok) return built;

  const persisted = await SnapshotRepository.persistImmutable(built.value);
  return persisted.ok ? Ok(built.value) : persisted;
}

export const GenerateSnapshotUC = {
  async generate(spec: SnapshotSpec): Promise<Result<Snapshot>> {
    // Idempotent: an existing snapshot is returned, never rebuilt (ADR-006).
    const existing = await SnapshotRepository.findById(spec.snapshotId);
    if (existing !== undefined) return Ok(existing);
    return buildSnapshot(spec);
  },

  async runScheduler(now: IsoDateTime, since?: IsoDateTime): Promise<Result<readonly string[]>> {
    const existing = await SnapshotRepository.listIds();
    // `since` is the last successful run, so a user who has not opened the app
    // for months still gets their statutory snapshots (see CompliancePolicy).
    const due = CompliancePolicy.dueSnapshots(now, existing, since === undefined ? {} : { since });

    const created: string[] = [];
    for (const spec of due) {
      const result = await buildSnapshot(spec, now);
      if (!result.ok) return result;
      created.push(result.value.snapshotId);
    }
    return Ok(created);
  },

  async custom(asOf: IsoDate): Promise<Result<Snapshot>> {
    const today = currentPorts().clock.today();
    const guard = SnapshotFactory.assertNotFuture(asOf, today);
    if (!guard.ok) return Err(new FutureSnapshotError(guard.error.message));

    return buildSnapshot({
      snapshotId: `CUSTOM_${asOf}`,
      kind: 'CUSTOM',
      scope: 'ALL',
      asOf: `${asOf}T23:59:59.999+05:30`,
    });
  },
};

export const ListSnapshotsUC = {
  execute(): Promise<readonly SnapshotSummary[]> {
    return SnapshotRepository.list();
  },
};

export const CompareSnapshotsUC = {
  async snapshotToSnapshot(beforeId: string, afterId: string): Promise<Result<VarianceReport>> {
    const before = await SnapshotRepository.findById(beforeId);
    const after = await SnapshotRepository.findById(afterId);
    if (before === undefined || after === undefined) {
      return Err(new VaultStateError('one or both snapshots were not found'));
    }
    return Ok(DeltaEngine.compare(before, after));
  },

  async snapshotToLive(beforeId: string, now: IsoDateTime): Promise<Result<VarianceReport>> {
    const before = await SnapshotRepository.findById(beforeId);
    if (before === undefined) {
      return Err(new VaultStateError(`snapshot ${beforeId} was not found`));
    }
    const live = await ValuePortfolioUC.execute(now);
    if (!live.ok) return live;
    return Ok(DeltaEngine.compare(before, live.value));
  },
};

/* --------------------------------------------------------------------- tax */

/**
 * Income profile for the year. Supplied by Form 16 import or manual entry.
 *
 * Cached in memory and written through to the vault: it is read on every tax
 * computation, and holding it only in memory meant a container restart silently
 * reverted the figure to "zero income" — which reads as an answer, not as a
 * missing input.
 */
const INCOME_PROFILE_KEY = 'tax.incomeProfile';
let incomeProfile: IncomeProfile | undefined;

export function setIncomeProfile(profile: IncomeProfile | undefined): void {
  incomeProfile = profile;
}

/**
 * Persists as well as sets. Async because it writes.
 *
 * Gated only when a profile is already stored, for the same reason the chit
 * schedule is: entering one for the first time is an addition, while replacing
 * or clearing one silently moves every advance-tax figure computed from it.
 */
export async function saveIncomeProfile(
  profile: IncomeProfile | undefined,
): Promise<Result<void>> {
  if (incomeProfile !== undefined) {
    const permitted = requireEditMode(
      profile === undefined ? 'clearing the income profile' : 'replacing the income profile',
    );
    if (!permitted.ok) return permitted;
  }

  incomeProfile = profile;
  return profile === undefined
    ? SettingsRepository.delete(INCOME_PROFILE_KEY)
    : SettingsRepository.set(
        INCOME_PROFILE_KEY,
        JSON.stringify(profile),
        currentPorts().clock.now(),
      );
}

/** Rehydrates the cache from the vault. Called once the vault is unlocked. */
export async function loadIncomeProfile(): Promise<void> {
  const stored = await SettingsRepository.get(INCOME_PROFILE_KEY);
  incomeProfile = stored === undefined ? undefined : (JSON.parse(stored) as IncomeProfile);
}

export function hasIncomeProfile(): boolean {
  return incomeProfile !== undefined;
}

export function incomeProfileOf(): IncomeProfile | undefined {
  return incomeProfile;
}

/**
 * No recorded income means zero income, not a failure — advance tax on nothing is
 * legitimately nil. Callers MUST surface `hasIncomeProfile()` alongside the
 * figure, though: a user who simply forgot to import their Form 16 would
 * otherwise read "₹0 due" as an answer rather than as a missing input.
 */
function profileFor(fy: FinancialYear): Result<IncomeProfile> {
  if (incomeProfile !== undefined) return Ok(incomeProfile);

  const zero = { amount: '0', currency: 'INR' as const };
  return Ok({
    financialYear: fy,
    // AY is the year AFTER the FY: income earned in FY 2025-26 is assessed in
    // AY 2026-27. This previously repeated the FY, which labels every return
    // with the wrong year — a filing-level error, not a display one.
    assessmentYear: FyCalendar.assessmentYearOf(fy),
    grossSalary: zero,
    exemptAllowances: zero,
    chapterViaDeductions: zero,
    housePropertyIncome: zero,
    otherSourcesIncome: zero,
    tdsRemitted: zero,
    tcsCollected: zero,
  });
}

export const ComputeAdvanceTaxUC = {
  execute(input: {
    financialYear: FinancialYear;
    quarter: Quarter;
  }): Promise<Result<AdvanceTaxInstallment>> {
    // Rules resolve first: a missing rule set must surface as its own error
    // rather than as a missing income profile (ADR-005).
    const rules = TaxRuleTable.rulesFor(input.financialYear);
    if (!rules.ok) return Promise.resolve(rules);

    const profile = profileFor(input.financialYear);
    if (!profile.ok) return Promise.resolve(profile);

    return Promise.resolve(
      AdvanceTaxEngine.installment({
        financialYear: input.financialYear,
        quarter: input.quarter,
        income: profile.value,
        exits: [],
        assetClasses: {},
        alreadyPaid: { amount: '0', currency: 'INR' },
        rules: rules.value,
      }),
    );
  },

  compareRegimes(financialYear: FinancialYear): Promise<Result<RegimeComparison>> {
    const rules = TaxRuleTable.rulesFor(financialYear);
    if (!rules.ok) return Promise.resolve(rules);
    const profile = profileFor(financialYear);
    if (!profile.ok) return Promise.resolve(profile);
    return Promise.resolve(Ok(SlabCalculator.compare(profile.value, rules.value)));
  },

  async hniStatus(financialYear: FinancialYear): Promise<Result<HniClassification>> {
    const rules = TaxRuleTable.rulesFor(financialYear);
    if (!rules.ok) return rules;
    const profile = profileFor(financialYear);
    if (!profile.ok) return profile;

    const valuation = await ValuePortfolioUC.execute(currentPorts().clock.now());
    const netWorth = valuation.ok ? valuation.value.netWorth : { amount: '0', currency: 'INR' as const };

    return Ok(
      HniClassifier.classify({
        totalIncome: profile.value.grossSalary,
        netWorth,
        rules: rules.value,
      }),
    );
  },
};

/* --------------------------------------------------------------- ingestion */

export const ImportStatementUC = {
  /**
   * Parses AND commits. Returning a report without writing anything was the
   * original shape, and it made an import look successful while the portfolio
   * stayed empty — the failure mode is invisible precisely because the report
   * says "created: 65".
   */
  async execute(input: {
    file: Uint8Array;
    fileName: string;
    parser: ParserName;
    mode: ImportMode;
    password?: string;
    /** The template the user selected, when they selected one. */
    templateName?: string;
  }): Promise<Result<ImportReport>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const [existing, existingExits] = await Promise.all([
      AssetRepository.all(),
      ExitRepository.all(),
    ]);
    // Rebuilt from the holdings themselves, so re-importing an overlapping export
    // recognises trades already on the ledger (US-4.7).
    const existingKeys = ledgerNaturalKeys(existing, existingExits);

    const report = await Pipeline.ingest({ ...input, existingKeys });
    if (!report.ok) return report;
    if (!report.value.committed) return report;

    const projected = LedgerProjector.project({
      transactions: report.value.transactions ?? [],
      parser: input.parser,
      existing,
      existingExits,
    });
    if (!projected.ok) return projected;

    const saved = await AssetRepository.saveAll(projected.value.assets);
    if (!saved.ok) return saved;

    // After the assets: an exit references its asset by foreign key.
    const savedExits = await ExitRepository.saveAll(projected.value.exits);
    if (!savedExits.ok) return savedExits;

    return Ok({
      ...report.value,
      // Rows the projection could not place are reported, never dropped.
      unapplied: projected.value.unapplied,
      // Stated figures the engine recomputed differently — shown, not silently
      // overridden in either direction.
      reconciliation: projected.value.reconciliation,
    });
  },
};

/* -------------------------------------------------------------- chit funds */

export interface OpenChitInput {
  readonly org: string;
  readonly label: string;
  readonly targetAmount: MoneyValue;
  readonly startDate: IsoDate;
  readonly durationMonths: number;
  readonly emiType: ChitEmiType;
  /** Optional override; derived from the start date and term when absent. */
  readonly endDate?: IsoDate;
  readonly scheduleLabel?: string;
  readonly comments?: string;
}

export interface RecordChitEmiInput {
  readonly chitId: string;
  readonly date: IsoDate;
  readonly amount: MoneyValue;
  readonly mode: PaymentMode;
  readonly paidTo: string;
  readonly comments?: string;
}

export interface ChitQuery {
  readonly statuses?: readonly ChitStatus[] | undefined;
  readonly orgs?: readonly string[] | undefined;
  readonly sortBy?: ChitSortKey | undefined;
  readonly direction?: SortDirection | undefined;
  readonly asOf?: IsoDate | undefined;
}

export interface EditChitInput {
  readonly org?: string;
  readonly label?: string;
  readonly targetAmount?: MoneyValue;
  readonly startDate?: IsoDate;
  readonly endDate?: IsoDate;
  readonly durationMonths?: number;
  readonly emiType?: ChitEmiType;
  readonly scheduleLabel?: string | null;
  readonly comments?: string;
}

const isChit = (asset: Asset): boolean =>
  asset.assetClass === 'CHIT_FUND' && asset.chitFund !== undefined;

const chitsOf = (assets: readonly Asset[]): readonly ChitFund[] =>
  assets.filter(isChit).map((asset) => asset.chitFund as ChitFund);

/** Months added to a date, so a 25-month chit ends where the passbook says. */
function addMonths(date: IsoDate, months: number): IsoDate {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const zeroBased = (month - 1) + months;
  const endYear = year + Math.floor(zeroBased / 12);
  const endMonth = (zeroBased % 12) + 1;
  return `${String(endYear).padStart(4, '0')}-${String(endMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Derived from the chit's own terms, so re-recording the same chit resolves to
 * the same asset rather than duplicating it — the rule the rest of the ledger
 * uses.
 */
function chitIdFor(input: { org: string; label: string; startDate: IsoDate }): string {
  const digest = createHash('sha256')
    .update([input.org.trim().toLowerCase(), input.label.trim().toLowerCase(), input.startDate].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `ast_chit_fund_${digest}`;
}

async function mutateChit(
  chitId: string,
  change: (chit: ChitFund) => ChitFund,
): Promise<Result<void>> {
  const guard = requireUnlocked();
  if (!guard.ok) return guard;

  const asset = await AssetRepository.findById(chitId);
  if (asset?.chitFund === undefined) {
    return Err(new VaultStateError(`no chit fund ${chitId} was found`));
  }
  return AssetRepository.save({ ...asset, chitFund: change(asset.chitFund) });
}

export const ChitUC = {
  /**
   * The register: filtered, sorted, and totalled over the FILTERED set.
   *
   * Computed here rather than in the browser for the same reason the loan
   * register is: summing decimal strings in JavaScript reintroduces the float
   * drift ADR-002 exists to prevent.
   */
  async register(query: ChitQuery = {}): Promise<Result<ChitRegister>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const [assets, schedules] = await Promise.all([
      AssetRepository.all(),
      ChitScheduleRepository.all(),
    ]);

    return Ok(
      ChitLedger.register({
        chits: chitsOf(assets),
        asOf: query.asOf ?? currentPorts().clock.today(),
        schedules,
        filter: {
          ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          ...(query.orgs === undefined ? {} : { orgs: query.orgs }),
        },
        ...(query.sortBy === undefined ? {} : { sortBy: query.sortBy }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
      }),
    );
  },

  async open(input: OpenChitInput): Promise<Result<string>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const org = input.org.trim();
    const label = input.label.trim();
    if (org.length === 0) return Err(new VaultStateError('a chit needs the organisation running it'));
    if (label.length === 0) return Err(new VaultStateError('a chit needs a label'));
    if (!ISO_DATE.test(input.startDate)) {
      return Err(new VaultStateError('a chit needs a start date, as YYYY-MM-DD'));
    }
    if (!Number.isInteger(input.durationMonths) || input.durationMonths <= 0) {
      return Err(new VaultStateError('a chit runs for a whole number of months, at least one'));
    }

    const target = Money.parse(input.targetAmount.amount, input.targetAmount.currency);
    if (!target.ok) return target;
    if (Money.compare(target.value, Money.zero(target.value.currency)) <= 0) {
      return Err(new VaultStateError('a chit amount must be greater than zero'));
    }

    const chitId = chitIdFor({ org, label, startDate: input.startDate });

    const saved = await AssetRepository.save({
      assetId: chitId,
      assetClass: 'CHIT_FUND',
      jurisdiction: 'DOMESTIC',
      currency: target.value.currency,
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      liquidity: 'ILLIQUID',
      chitFund: {
        assetId: chitId,
        org,
        label,
        targetAmount: target.value,
        startDate: input.startDate,
        endDate: input.endDate ?? addMonths(input.startDate, input.durationMonths),
        durationMonths: input.durationMonths,
        emiType: input.emiType,
        status: 'ACTIVE',
        emis: [],
        ...(input.scheduleLabel === undefined || input.scheduleLabel.length === 0
          ? {}
          : { scheduleLabel: input.scheduleLabel }),
        ...(input.comments === undefined || input.comments.length === 0
          ? {}
          : { comments: input.comments }),
      },
    });
    return saved.ok ? Ok(chitId) : saved;
  },

  /** A monthly instalment. Recorded whether or not the chit has been drawn. */
  async recordEmi(input: RecordChitEmiInput): Promise<Result<void>> {
    if (!ISO_DATE.test(input.date)) {
      return Err(new VaultStateError('an instalment needs a date, as YYYY-MM-DD'));
    }
    const paidTo = input.paidTo.trim();
    if (paidTo.length === 0) {
      return Err(new VaultStateError('an instalment needs to say who it was paid to'));
    }

    // Parsed before it can reach the vault: an unparseable amount stored
    // verbatim made every later read of the whole register throw.
    const amount = Money.parse(input.amount.amount, input.amount.currency);
    if (!amount.ok) return amount;
    if (Money.compare(amount.value, Money.zero(amount.value.currency)) <= 0) {
      return Err(new VaultStateError('an instalment must be greater than zero'));
    }

    // Derived from the instalment itself, so recording it twice cannot
    // double-count a month's payment.
    const emiId = `cemi_${createHash('sha256')
      .update([input.chitId, input.date, amount.value.amount, input.mode].join('|'))
      .digest('hex')
      .slice(0, 16)}`;

    return mutateChit(input.chitId, (chit) => ({
      ...chit,
      emis: [
        ...chit.emis.filter((existing) => existing.emiId !== emiId),
        {
          emiId,
          date: input.date,
          amount: amount.value,
          mode: input.mode,
          paidTo,
          ...(input.comments === undefined || input.comments.length === 0
            ? {}
            : { comments: input.comments }),
        },
      ],
    }));
  },

  /**
   * Marks the pot as drawn. The chit leaves the asset side from this moment —
   * the money is now cash elsewhere — but the instalments carry on.
   */
  async withdraw(
    chitId: string,
    input: { readonly date: IsoDate; readonly amount: MoneyValue },
  ): Promise<Result<void>> {
    // A draw changes what an existing chit IS, not what has been paid into it,
    // so it sits on the protected side of the line that `recordEmi` does not.
    const permitted = requireEditMode('marking this chit withdrawn');
    if (!permitted.ok) return permitted;

    if (!ISO_DATE.test(input.date)) {
      return Err(new VaultStateError('a withdrawal needs a date, as YYYY-MM-DD'));
    }
    const amount = Money.parse(input.amount.amount, input.amount.currency);
    if (!amount.ok) return amount;

    return mutateChit(chitId, (chit) => ({
      ...chit,
      status: 'WITHDRAWN',
      withdrawnDate: input.date,
      withdrawnAmount: amount.value,
    }));
  },

  /** Status is editable in both directions: a draw can be recorded in error. */
  setStatus(chitId: string, status: ChitStatus): Promise<Result<void>> {
    const permitted = requireEditMode('changing this chit’s status');
    if (!permitted.ok) return Promise.resolve(permitted);

    return mutateChit(chitId, (chit) => {
      if (status === 'ACTIVE') {
        const { withdrawnDate: _date, withdrawnAmount: _amount, ...rest } = chit;
        return { ...rest, status };
      }
      return { ...chit, status };
    });
  },

  async edit(chitId: string, edit: EditChitInput): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('editing this chit');
    if (!permitted.ok) return permitted;

    if (edit.targetAmount !== undefined) {
      const target = Money.parse(edit.targetAmount.amount, edit.targetAmount.currency);
      if (!target.ok) return target;
    }
    if (edit.startDate !== undefined && !ISO_DATE.test(edit.startDate)) {
      return Err(new VaultStateError('a chit start date must be written as YYYY-MM-DD'));
    }
    if (
      edit.durationMonths !== undefined &&
      (!Number.isInteger(edit.durationMonths) || edit.durationMonths <= 0)
    ) {
      return Err(new VaultStateError('a chit runs for a whole number of months, at least one'));
    }

    return mutateChit(chitId, (chit) => {
      const org = edit.org?.trim();
      const label = edit.label?.trim();
      const target =
        edit.targetAmount === undefined
          ? chit.targetAmount
          : (Money.parse(edit.targetAmount.amount, edit.targetAmount.currency) as {
              ok: true;
              value: MoneyValue;
            }).value;

      const startDate = edit.startDate ?? chit.startDate;
      const durationMonths = edit.durationMonths ?? chit.durationMonths;

      return {
        ...chit,
        ...(org === undefined || org.length === 0 ? {} : { org }),
        ...(label === undefined || label.length === 0 ? {} : { label }),
        targetAmount: target,
        startDate,
        durationMonths,
        // Re-derived unless stated: leaving a stale end date after a term change
        // would have the register disagree with its own duration.
        endDate: edit.endDate ?? addMonths(startDate, durationMonths),
        ...(edit.emiType === undefined ? {} : { emiType: edit.emiType }),
        ...(edit.comments === undefined ? {} : { comments: edit.comments }),
        ...(edit.scheduleLabel === undefined
          ? {}
          : edit.scheduleLabel === null
            ? {}
            : { scheduleLabel: edit.scheduleLabel }),
      };
    });
  },

  /* ------------------------------------------------ withdrawal schedules */

  async schedules(): Promise<Result<readonly ChitWithdrawalSchedule[]>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    return Ok(await ChitScheduleRepository.all());
  },

  async saveSchedule(schedule: ChitWithdrawalSchedule): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const label = schedule.label.trim();
    if (label.length === 0) {
      return Err(new VaultStateError('a withdrawal schedule needs a label'));
    }

    /*
     * Gated only when it would OVERWRITE. Saving under a new label is creating
     * reference data and stays open like every other addition; saving under an
     * existing one replaces its rows wholesale, and every chit pointing at that
     * label silently revalues with it. The second is a change to existing
     * records however much it looks like a save.
     */
    if ((await ChitScheduleRepository.findByLabel(label)) !== undefined) {
      const permitted = requireEditMode(`replacing the "${label}" withdrawal schedule`);
      if (!permitted.ok) return permitted;
    }

    const rows: { month: number; amount: MoneyValue }[] = [];
    for (const row of schedule.rows) {
      if (!Number.isInteger(row.month) || row.month <= 0) {
        return Err(new VaultStateError('a schedule month must be a whole number, at least one'));
      }
      const amount = Money.parse(row.amount.amount, row.amount.currency);
      if (!amount.ok) return amount;
      rows.push({ month: row.month, amount: amount.value });
    }

    return ChitScheduleRepository.save({ label, rows });
  },

  async deleteSchedule(label: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode(`deleting the "${label}" withdrawal schedule`);
    if (!permitted.ok) return permitted;

    /*
     * Refused while a chit still names it. The schedule is what turns a month
     * number into the amount the pot pays out; removing it out from under a
     * chit would leave that chit's withdrawal value unresolvable, and the chit
     * itself gives no sign that the figure it used to show ever existed.
     */
    const assets = await AssetRepository.all();
    const users = chitsOf(assets).filter((chit) => chit.scheduleLabel === label);
    if (users.length > 0) {
      return Err(
        new VaultStateError(
          `"${label}" is still used by ${String(users.length)} chit(s); point them at another schedule first`,
        ),
      );
    }

    return ChitScheduleRepository.delete(label);
  },

  /**
   * Removes a chit and every instalment recorded against it.
   *
   * No soft delete and no trail. A chit has no counterparty reading its history
   * the way a hand loan does — its evidence is the instalment receipts the
   * holder keeps outside this application — so a tombstone row here would be
   * clutter that the register then has to learn to hide.
   */
  async delete(chitId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('deleting this chit');
    if (!permitted.ok) return permitted;

    const asset = await AssetRepository.findById(chitId);
    if (asset?.chitFund === undefined) {
      return Err(new VaultStateError(`no chit fund ${chitId} was found`));
    }

    const removed = await AssetRepository.delete(chitId);
    if (!removed.ok) return removed;
    currentPorts().logger.info('chit deleted');
    return Ok(undefined);
  },
};

/* ------------------------------------------------------------ manual trades */

/**
 * Asset classes a trade can be typed in for, and the identifier each one is
 * actually known by.
 *
 * Not every class belongs here. A hand loan has its own screen because it is a
 * receivable rather than a holding; a bank balance is a position, not a trade.
 * Offering them in a trade form would produce holdings with a quantity and a
 * price that mean nothing.
 */
export const MANUAL_TRADE_CLASSES = [
  { assetClass: 'DOMESTIC_EQUITY', label: 'Indian listed equity', identifier: 'SYMBOL' },
  { assetClass: 'DOMESTIC_ETF', label: 'Indian ETF', identifier: 'SYMBOL' },
  { assetClass: 'DOMESTIC_MUTUAL_FUND', label: 'Mutual fund (equity, debt or hybrid)', identifier: 'FOLIO' },
  { assetClass: 'FOREIGN_EQUITY', label: 'Foreign listed equity', identifier: 'SYMBOL' },
  { assetClass: 'FOREIGN_ETF', label: 'Foreign ETF', identifier: 'SYMBOL' },
  { assetClass: 'UNLISTED_SHARES', label: 'Unlisted shares', identifier: 'NAME' },
  { assetClass: 'SGB', label: 'Sovereign gold bond', identifier: 'SYMBOL' },
] as const;

export type ManualTradeClass = (typeof MANUAL_TRADE_CLASSES)[number]['assetClass'];

export interface RecordTradeInput {
  readonly assetClass: string;
  readonly side: 'BUY' | 'SELL';
  readonly tradeDate: IsoDate;
  readonly symbol?: string;
  readonly isin?: string;
  readonly folioRef?: string;
  readonly schemeName?: string;
  readonly quantity: string;
  readonly pricePerUnit: MoneyValue;
  readonly fees?: MoneyValue;
  readonly otherCharges?: MoneyValue;
  /** Only meaningful for a mutual fund; decides equity vs debt tax treatment. */
  readonly schemeCategory?: string;
  readonly confirmDuplicate?: boolean;
}

export interface RecordTradeResult {
  readonly assetId: string;
  /** Present for a SELL: what the disposal realised against which lots. */
  readonly exits: number;
  /** Rows the projection could not place — a SELL with nothing to sell. */
  readonly unapplied: readonly { readonly reason: string }[];
}

const TRADE_CLASSES = new Set<string>(MANUAL_TRADE_CLASSES.map((entry) => entry.assetClass));

export const TradeUC = {
  classes: (): Promise<Result<typeof MANUAL_TRADE_CLASSES>> =>
    Promise.resolve(Ok(MANUAL_TRADE_CLASSES)),

  /**
   * A trade typed in by hand.
   *
   * Deliberately routed through the SAME projection an imported statement takes,
   * rather than writing a lot straight to the repository. A hand-typed sell must
   * deplete FIFO exactly as an imported one does, and must produce the same
   * disposal record the capital-gains engine reads — a second write path would
   * be a second set of rules to keep in step, and tax is where the divergence
   * would surface.
   */
  async record(input: RecordTradeInput): Promise<Result<RecordTradeResult>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    if (!TRADE_CLASSES.has(input.assetClass)) {
      return Err(
        new VaultStateError(`${input.assetClass} cannot be recorded as a trade`),
      );
    }
    if (!ISO_DATE.test(input.tradeDate)) {
      return Err(new VaultStateError('a trade needs a date, as YYYY-MM-DD'));
    }

    const identity = [input.isin, input.symbol, input.folioRef, input.schemeName].find(
      (value) => value !== undefined && value.trim().length > 0,
    );
    if (identity === undefined) {
      return Err(
        new VaultStateError('a trade needs a symbol, ISIN, folio number or scheme name'),
      );
    }

    // Parsed, not trusted — the same reason the loan form parses: `1,00,000` is
    // a reasonable thing to type and must never reach storage unparsed.
    const price = Money.parse(input.pricePerUnit.amount, input.pricePerUnit.currency);
    if (!price.ok) return price;
    if (Money.compare(price.value, Money.zero(price.value.currency)) <= 0) {
      return Err(new VaultStateError('a price must be greater than zero'));
    }

    // Money.parse is reused for the quantity purely as a decimal parser — it
    // normalises `1,000` the same way, and the currency it is handed is
    // discarded. Only `.amount` is ever read.
    const quantity = Money.parse(input.quantity, price.value.currency);
    if (!quantity.ok) {
      return Err(new VaultStateError('a quantity must be a number'));
    }
    if (Money.compare(quantity.value, Money.zero(price.value.currency)) <= 0) {
      return Err(new VaultStateError('a quantity must be greater than zero'));
    }

    const optionalCost = (
      value: MoneyValue | undefined,
    ): Result<MoneyValue | undefined> => {
      if (value === undefined) return Ok(undefined);
      const parsed = Money.parse(value.amount, price.value.currency);
      return parsed.ok ? Ok(parsed.value) : parsed;
    };

    const fees = optionalCost(input.fees);
    if (!fees.ok) return fees;
    const charges = optionalCost(input.otherCharges);
    if (!charges.ok) return charges;

    const [existing, existingExits] = await Promise.all([
      AssetRepository.all(),
      ExitRepository.all(),
    ]);

    /*
     * The same question the loan form asks, for the same reason. Two fills of one
     * order on one day at one price is an ordinary thing; the natural key that
     * makes a re-import idempotent cannot tell that apart from the same trade
     * typed twice, and would silently drop the second.
     */
    const naturalKey = [
      input.side,
      input.tradeDate,
      identity,
      quantity.value.amount,
      price.value.amount,
      price.value.currency,
    ].join('|');
    const existingKeys = LedgerProjector.naturalKeys(existing, existingExits);
    const occurrences = existingKeys.filter((key) => key === naturalKey).length;

    if (occurrences > 0 && input.confirmDuplicate !== true) {
      return Err(
        new DuplicateTradeError(
          `a ${input.side.toLowerCase()} of ${quantity.value.amount} ${identity} on ${input.tradeDate} at this price is already recorded`,
          [identity],
        ),
      );
    }

    /*
     * The lot id is derived from `importedAt`, so a confirmed duplicate needs a
     * distinct one or the second fill merges into the first lot and the quantity
     * is lost. The occurrence count supplies it deterministically: re-typing the
     * SAME trade resolves to the same lot, while a confirmed second fill gets
     * its own.
     */
    const token = createHash('sha256')
      .update([naturalKey, String(occurrences)].join('|'))
      .digest('hex')
      .slice(0, 16);

    const transaction = {
      kind: input.side,
      date: input.tradeDate,
      quantity: quantity.value.amount,
      pricePerUnit: price.value,
      assetClass: input.assetClass,
      ...(input.symbol === undefined || input.symbol.length === 0 ? {} : { symbol: input.symbol }),
      ...(input.isin === undefined || input.isin.length === 0 ? {} : { isin: input.isin }),
      ...(input.folioRef === undefined || input.folioRef.length === 0
        ? {}
        : { folioRef: input.folioRef }),
      ...(input.schemeName === undefined || input.schemeName.length === 0
        ? {}
        : { schemeName: input.schemeName }),
      ...(fees.value === undefined ? {} : { fees: fees.value }),
      ...(charges.value === undefined ? {} : { otherCharges: charges.value }),
      provenance: {
        sourceFile: 'manual entry',
        sourceRow: 1,
        parserName: 'MANUAL' as const,
        importedAt: `manual:${token}`,
      },
    };

    const projected = LedgerProjector.project({
      transactions: [transaction],
      parser: 'MANUAL',
      existing,
      existingExits,
    });
    if (!projected.ok) return projected;

    const saved = await AssetRepository.saveAll(projected.value.assets);
    if (!saved.ok) return saved;
    // After the assets: an exit references its asset by foreign key.
    const savedExits = await ExitRepository.saveAll(projected.value.exits);
    if (!savedExits.ok) return savedExits;

    return Ok({
      // The asset THIS trade landed on. `assets` is the whole merged ledger, so
      // reading its first entry returned whichever holding the user happened to
      // own first — a different asset than the one just recorded, as soon as
      // there was more than one.
      assetId: projected.value.touched[0] ?? '',
      exits: projected.value.exits.length,
      unapplied: projected.value.unapplied.map((row) => ({ reason: row.reason })),
    });
  },
};

/* -------------------------------------------------------------- hand loans */

export interface RecordLoanInput {
  readonly borrowerName: string;
  readonly principal: MoneyValue;
  readonly interestRatePct: string;
  readonly loanDate: IsoDate;
  readonly notes?: string;
  /**
   * The lender has seen the matching loans and says this is a further, separate
   * one. Without it a same-borrower same-day entry is refused and the matches
   * are returned for confirmation.
   */
  readonly confirmDuplicate?: boolean;
}

/** What the caller is shown when a new loan matches one already on the book. */
export interface DuplicateLoanMatch {
  readonly loanId: string;
  readonly borrowerName: string;
  readonly loanDate: IsoDate;
  readonly principal: MoneyValue;
  readonly interestRatePct: string;
  readonly notes: string;
}

export interface RecordPaymentInput {
  readonly loanId: string;
  readonly date: IsoDate;
  readonly amount: MoneyValue;
  readonly mode: PaymentMode;
  readonly notes?: string;
}

export interface LoanQuery {
  readonly statuses?: readonly LoanStatus[] | undefined;
  readonly borrowers?: readonly string[] | undefined;
  readonly sortBy?: LoanSortKey | undefined;
  readonly direction?: SortDirection | undefined;
  readonly asOf?: IsoDate | undefined;
}

/** Loans are HAND_LOAN assets, so the register and net worth cannot disagree. */
const isLoan = (asset: Asset): boolean =>
  asset.assetClass === 'HAND_LOAN' && asset.handLoan !== undefined;

const loansOf = (assets: readonly Asset[]): readonly HandLoan[] =>
  assets.filter(isLoan).map((asset) => asset.handLoan as HandLoan);

/**
 * Stable and derived from the loan's own terms, so re-recording the same loan
 * resolves to the same asset rather than duplicating it — the same rule the
 * statement importer uses.
 */
function loanIdFor(input: RecordLoanInput, borrowerRef: string): string {
  const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `ast_hand_loan_${slug(borrowerRef)}_${slug(input.loanDate)}_${slug(input.principal.amount)}`;
}

/**
 * A free id for a loan whose natural key is already taken.
 *
 * The derived id encodes borrower, date and amount, which is exactly right for
 * import — a re-imported row must land on the asset it landed on last time — and
 * exactly wrong for a second genuine loan to the same person, on the same day,
 * for the same sum. That combination is not a data-entry error; it happens, and
 * before this the second loan silently OVERWROTE the first, because the assets
 * table upserts on `asset_id`. The money simply vanished from the register.
 *
 * So the derived id stays the identity of the first loan, and a confirmed
 * duplicate takes the next free `_d2`, `_d3` suffix. Import is untouched and
 * remains idempotent.
 */
function freeLoanId(baseId: string, taken: ReadonlySet<string>): string {
  if (!taken.has(baseId)) return baseId;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}_d${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Content-addressed, so a frozen clock in a test cannot collide on the key. */
function auditIdFor(parts: readonly string[]): string {
  return `aud_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
}

/** One trail entry for something that is not a field-level edit. */
function auditEvent(
  loanId: string,
  action: LoanAuditAction,
  recordedAt: string,
  detail: { readonly newValue?: string; readonly reason?: string } = {},
): LoanAuditEntry {
  return {
    entryId: auditIdFor([loanId, action, recordedAt, detail.newValue ?? '', detail.reason ?? '']),
    loanId,
    action,
    recordedAt,
    ...(detail.newValue === undefined ? {} : { newValue: detail.newValue }),
    ...(detail.reason === undefined || detail.reason.length === 0
      ? {}
      : { reason: detail.reason }),
  };
}

export const LoanUC = {
  /**
   * The register: filtered, sorted, and totalled over the FILTERED set.
   *
   * Every figure is computed here rather than in the browser. Summing decimal
   * strings in JavaScript would reintroduce exactly the float drift ADR-002
   * exists to prevent, and these totals are money the user is owed.
   */
  async register(query: LoanQuery = {}): Promise<Result<LoanRegister>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const assets = await AssetRepository.all();
    return Ok(
      HandLoanLedger.register({
        loans: loansOf(assets),
        asOf: query.asOf ?? currentPorts().clock.today(),
        filter: {
          ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          ...(query.borrowers === undefined ? {} : { borrowers: query.borrowers }),
        },
        ...(query.sortBy === undefined ? {} : { sortBy: query.sortBy }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
      }),
    );
  },

  async record(input: RecordLoanInput): Promise<Result<string>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const name = input.borrowerName.trim();
    if (name.length === 0) {
      return Err(new VaultStateError('a borrower name is required'));
    }

    // Parsed, not trusted. `1,00,000` is a reasonable thing to type and must not
    // reach storage as a string no arithmetic can read.
    const principal = Money.parse(input.principal.amount, input.principal.currency);
    if (!principal.ok) return principal;
    if (Money.compare(principal.value, Money.zero(principal.value.currency)) <= 0) {
      return Err(new VaultStateError('a loan amount must be greater than zero'));
    }

    const rate = Money.parse(input.interestRatePct, 'INR');
    if (!rate.ok) {
      return Err(new VaultStateError('an interest rate must be a number, such as 12 or 8.5'));
    }

    if (!ISO_DATE.test(input.loanDate)) {
      return Err(new VaultStateError('a loan needs a date, as YYYY-MM-DD'));
    }

    const ref = borrowerRef(name);
    const assets = await AssetRepository.all();
    const existing = loansOf(assets);

    /*
     * Same borrower, same day. Reported rather than refused: the lender is the
     * only one who knows whether this is a second real loan or the same loan
     * typed twice, and answering that question for them gets it wrong.
     */
    const duplicates = loanDuplicatesOf({ borrowerRef: ref, loanDate: input.loanDate }, existing);
    if (duplicates.length > 0 && input.confirmDuplicate !== true) {
      return Err(
        new DuplicateLoanError(
          duplicates.length === 1
            ? 'a loan to this borrower dated the same day is already recorded'
            : `${String(duplicates.length)} loans to this borrower dated the same day are already recorded`,
          duplicates.map((loan) => loan.assetId),
        ),
      );
    }

    const baseId = loanIdFor({ ...input, principal: principal.value }, ref);
    const loanId = freeLoanId(baseId, new Set(assets.map((asset) => asset.assetId)));
    const recordedAt = currentPorts().clock.now();

    const saved = await AssetRepository.save({
      assetId: loanId,
      assetClass: 'HAND_LOAN',
      jurisdiction: 'DOMESTIC',
      currency: principal.value.currency,
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      liquidity: 'ILLIQUID',
      handLoan: {
        assetId: loanId,
        borrowerRef: ref,
        borrowerName: name,
        principal: principal.value,
        interestRatePct: rate.value.amount,
        interestBasis: 'SIMPLE',
        startDate: input.loanDate,
        repayments: [],
        interestPayments: [],
        ...(input.notes === undefined || input.notes.length === 0 ? {} : { notes: input.notes }),
      },
    });
    if (!saved.ok) return saved;

    // Recorded even for an ordinary creation: a trail that starts at the first
    // edit cannot show what the loan was originally entered as, which is the
    // one value a dispute turns on.
    await LoanAuditRepository.append([
      auditEvent(
        loanId,
        duplicates.length > 0 ? 'CREATED_AS_DUPLICATE' : 'CREATED',
        recordedAt,
        {
          newValue: `${principal.value.currency} ${principal.value.amount} at ${rate.value.amount}% from ${input.loanDate}`,
          ...(duplicates.length === 0
            ? {}
            : {
                reason: `confirmed as distinct from ${duplicates.map((loan) => loan.assetId).join(', ')}`,
              }),
        },
      ),
    ]);
    return Ok(loanId);
  },

  /**
   * An audited edit. Every field is editable and no business rule restricts the
   * values — a deliberate choice, so that a mistyped principal or a wrong date
   * can be corrected in place rather than by closing the loan and re-entering
   * it, which leaves a fictitious settled loan on the register forever.
   *
   * Parse-level validation stays: an amount must still be a number and a date
   * must still be ISO. That is not a business rule but the difference between a
   * loan and a row that makes the whole register throw on read.
   */
  async edit(
    loanId: string,
    edit: LoanEdit,
    options: { readonly reason?: string } = {},
  ): Promise<Result<readonly LoanAuditEntry[]>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('editing this loan');
    if (!permitted.ok) return permitted;

    const asset = await AssetRepository.findById(loanId);
    if (asset?.handLoan === undefined) {
      return Err(new VaultStateError(`no hand loan ${loanId} was found`));
    }

    let clean: LoanEdit = {};

    if (edit.borrowerName !== undefined) {
      const name = edit.borrowerName.trim();
      if (name.length === 0) return Err(new VaultStateError('a borrower name is required'));
      clean = { ...clean, borrowerName: name };
    }
    if (edit.principalAmount !== undefined) {
      const principal = Money.parse(edit.principalAmount, asset.handLoan.principal.currency);
      if (!principal.ok) return principal;
      clean = { ...clean, principalAmount: principal.value.amount };
    }
    if (edit.interestRatePct !== undefined) {
      const rate = Money.parse(edit.interestRatePct, 'INR');
      if (!rate.ok) {
        return Err(new VaultStateError('an interest rate must be a number, such as 12 or 8.5'));
      }
      clean = { ...clean, interestRatePct: rate.value.amount };
    }
    if (edit.loanDate !== undefined) {
      if (!ISO_DATE.test(edit.loanDate)) {
        return Err(new VaultStateError('a loan date must be written as YYYY-MM-DD'));
      }
      clean = { ...clean, loanDate: edit.loanDate };
    }
    if (edit.notes !== undefined) clean = { ...clean, notes: edit.notes };
    if (edit.closedDate !== undefined) {
      if (edit.closedDate !== null && !ISO_DATE.test(edit.closedDate)) {
        return Err(new VaultStateError('a closed date must be written as YYYY-MM-DD'));
      }
      clean = { ...clean, closedDate: edit.closedDate };
    }

    const recordedAt = currentPorts().clock.now();
    const applied = applyLoanEdit(asset.handLoan, clean, {
      recordedAt,
      entryId: (index) => auditIdFor([loanId, recordedAt, String(index), 'EDITED']),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });

    // Nothing actually moved. Persisting anyway would append a reason to the
    // trail for a change that never happened.
    if (applied.entries.length === 0) return Ok([]);

    // The borrower's NAME changed, so its hash must follow — otherwise the
    // register groups the loan under the old borrower and the filter loses it.
    const renamed =
      clean.borrowerName === undefined
        ? applied.loan
        : { ...applied.loan, borrowerRef: borrowerRef(clean.borrowerName) };

    const saved = await AssetRepository.save({ ...asset, handLoan: renamed });
    if (!saved.ok) return saved;

    const appended = await LoanAuditRepository.append(applied.entries);
    if (!appended.ok) return appended;
    return Ok(applied.entries);
  },

  /** The trail for one loan, newest first. */
  async auditFor(loanId: string): Promise<Result<readonly LoanAuditEntry[]>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    return Ok(await LoanAuditRepository.listFor(loanId));
  },

  /** A repayment of PRINCIPAL. Reduces what is owed and what earns interest. */
  async recordPrincipalRepayment(input: RecordPaymentInput): Promise<Result<void>> {
    const amount = validPayment(input);
    if (!amount.ok) return amount;

    return mutateLoan(input.loanId, (loan) => ({
      ...loan,
      repayments: [
        ...loan.repayments,
        {
          date: input.date,
          principal: amount.value,
          paymentId: paymentIdFor(input, 'rep'),
          mode: input.mode,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        },
      ],
    }),
      (recordedAt) =>
        auditEvent(input.loanId, 'PRINCIPAL_REPAYMENT', recordedAt, {
          newValue: `${amount.value.currency} ${amount.value.amount} on ${input.date} by ${input.mode}`,
          ...(input.notes === undefined || input.notes.length === 0
            ? {}
            : { reason: input.notes }),
        }),
    );
  },

  /** A payment of INTEREST. Does not reduce the principal. */
  async recordInterestPayment(input: RecordPaymentInput): Promise<Result<void>> {
    const amount = validPayment(input);
    if (!amount.ok) return amount;

    return mutateLoan(input.loanId, (loan) => ({
      ...loan,
      interestPayments: [
        ...(loan.interestPayments ?? []),
        {
          paymentId: paymentIdFor(input, 'int'),
          date: input.date,
          amount: amount.value,
          mode: input.mode,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        },
      ],
    }),
      (recordedAt) =>
        auditEvent(input.loanId, 'INTEREST_PAYMENT', recordedAt, {
          newValue: `${amount.value.currency} ${amount.value.amount} on ${input.date} by ${input.mode}`,
          ...(input.notes === undefined || input.notes.length === 0
            ? {}
            : { reason: input.notes }),
        }),
    );
  },

  /**
   * The register as a file. Exported from the SAME filtered set the screen
   * shows, so what a lender hands to a borrower matches what they were looking
   * at when they pressed the button.
   */
  async exportCsv(query: LoanQuery = {}): Promise<Result<string>> {
    const result = await LoanUC.register(query);
    return result.ok ? Ok(LoanExporter.toCsv(result.value)) : result;
  },

  async exportPdf(query: LoanQuery = {}): Promise<Result<Uint8Array>> {
    const result = await LoanUC.register(query);
    if (!result.ok) return result;
    return Ok(
      LoanExporter.toPdf({
        loans: result.value.loans,
        totals: result.value.totals,
        generatedOn: query.asOf ?? currentPorts().clock.today(),
      }),
    );
  },

  /** Closing freezes accrual; it does not assert the money came back. */
  close(loanId: string, closedDate: IsoDate): Promise<Result<void>> {
    const permitted = requireEditMode('closing this loan');
    if (!permitted.ok) return Promise.resolve(permitted);

    return mutateLoan(
      loanId,
      (loan) => ({ ...loan, closedDate }),
      (recordedAt) => auditEvent(loanId, 'CLOSED', recordedAt, { newValue: closedDate }),
    );
  },

  reopen(loanId: string): Promise<Result<void>> {
    const permitted = requireEditMode('reopening this loan');
    if (!permitted.ok) return Promise.resolve(permitted);

    return mutateLoan(
      loanId,
      (loan) => {
        const { closedDate: _closed, ...rest } = loan;
        return rest;
      },
      (recordedAt) => auditEvent(loanId, 'REOPENED', recordedAt),
    );
  },

  /**
   * Removes a loan and every payment recorded against it.
   *
   * The trail is written FIRST and survives the loan, which is the whole reason
   * `hand_loan_audit` carries no foreign key to `assets` (v6 migration). Order
   * matters: appending after the delete would lose the trail entirely if the
   * append failed, and a loan that vanished with no record of why is the exact
   * situation the audit table exists to prevent.
   *
   * A deletion cannot be undone from inside the application, so the reason is
   * worth asking for even though nothing enforces one.
   */
  async delete(
    loanId: string,
    options: { readonly reason?: string } = {},
  ): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('deleting this loan');
    if (!permitted.ok) return permitted;

    const asset = await AssetRepository.findById(loanId);
    if (asset?.handLoan === undefined) {
      return Err(new VaultStateError(`no hand loan ${loanId} was found`));
    }

    const recordedAt = currentPorts().clock.now();
    const loan = asset.handLoan;
    const appended = await LoanAuditRepository.append([
      auditEvent(loanId, 'DELETED', recordedAt, {
        // The terms, so the trail still says what was removed. The borrower's
        // NAME is deliberately absent: an audit entry is read outside the
        // register that holds it, and ADR-013 keeps names in the vault only.
        newValue: `${loan.principal.currency} ${loan.principal.amount} at ${loan.interestRatePct}% from ${loan.startDate}`,
        ...(options.reason === undefined || options.reason.length === 0
          ? {}
          : { reason: options.reason }),
      }),
    ]);
    if (!appended.ok) return appended;

    const removed = await AssetRepository.delete(loanId);
    if (!removed.ok) return removed;
    currentPorts().logger.info('hand loan deleted');
    return Ok(undefined);
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A payment is checked BEFORE it can reach the vault.
 *
 * These recorders previously validated nothing, so an amount typed as `1,00,000`
 * was persisted verbatim and every later read of the register threw on it — the
 * whole loan list returned 500, leaving no way to find the offending row from
 * inside the app.
 */
function validPayment(input: RecordPaymentInput): Result<MoneyValue> {
  if (!ISO_DATE.test(input.date)) {
    return Err(new VaultStateError('a payment needs a date, as YYYY-MM-DD'));
  }
  const amount = Money.parse(input.amount.amount, input.amount.currency);
  if (!amount.ok) return amount;
  if (Money.compare(amount.value, Money.zero(amount.value.currency)) <= 0) {
    return Err(new VaultStateError('a payment must be greater than zero'));
  }
  return Ok(amount.value);
}

/** Derived from the payment itself, so recording it twice cannot double-count. */
function paymentIdFor(input: RecordPaymentInput, prefix: string): string {
  return `${prefix}_${createHash('sha256')
    .update([input.loanId, input.date, input.amount.amount, input.mode].join('|'))
    .digest('hex')
    .slice(0, 16)}`;
}

async function mutateLoan(
  loanId: string,
  change: (loan: HandLoan) => HandLoan,
  trail?: (recordedAt: string) => LoanAuditEntry,
): Promise<Result<void>> {
  const guard = requireUnlocked();
  if (!guard.ok) return guard;

  const asset = await AssetRepository.findById(loanId);
  if (asset?.handLoan === undefined) {
    return Err(new VaultStateError(`no hand loan ${loanId} was found`));
  }
  const saved = await AssetRepository.save({ ...asset, handLoan: change(asset.handLoan) });
  if (!saved.ok || trail === undefined) return saved;

  return LoanAuditRepository.append([trail(currentPorts().clock.now())]);
}

/* ----------------------------------------------------------- reference data */

export interface FinancialYearOption {
  readonly financialYear: FinancialYear;
  readonly assessmentYear: string;
  readonly isCurrent: boolean;
  /** False when no rule set exists; the engine refuses rather than approximating. */
  readonly rulesAvailable: boolean;
  readonly rulesStatus?: 'PROVISIONAL' | 'VERIFIED';
}

export interface CalendarYearOption {
  readonly calendarYear: number;
  readonly isCurrent: boolean;
  /** A calendar year still running cannot have a closing 31-December position. */
  readonly isComplete: boolean;
}

export interface Periods {
  readonly today: IsoDate;
  readonly currentFinancialYear: FinancialYear;
  readonly currentAssessmentYear: string;
  readonly currentCalendarYear: number;
  /**
   * What a picker should START on, which is not always the current year.
   *
   * Offering a period and defaulting to it are different decisions. The current
   * FY is always OFFERED — a user looking for the year they are in must find it.
   * But rates for a year are published during it at the earliest, so defaulting
   * to a year with no rule set would make the tax screen look broken on first
   * open, for a reason that has nothing to do with the user.
   */
  readonly defaultFinancialYear: FinancialYear;
  /** Schedule FA reports a 31-December position, so a running year has none. */
  readonly defaultCalendarYear: number;
  readonly financialYears: readonly FinancialYearOption[];
  readonly calendarYears: readonly CalendarYearOption[];
}

const YEARS_OFFERED = 5;

/**
 * The periods the UI offers, derived on the SERVER.
 *
 * Deliberately not computed in the browser. A client west of UTC would decide it
 * is still 31 March while the server has moved into the next financial year, and
 * the dropdown would then disagree with the engine that computes the tax. One
 * clock, injected, is the only way those two can never diverge (ADR-008).
 */
export const ReferenceUC = {
  periods(): Periods {
    const today = currentPorts().clock.today();
    const currentFy = FyCalendar.financialYearOf(today);
    const currentCy = Number(today.slice(0, 4));
    const startYear = Number(currentFy.slice(0, 4));

    const financialYears: FinancialYearOption[] = [];
    // Current year first, then backwards: the year a user is filing for is
    // almost always the current or the immediately preceding one.
    for (let offset = 0; offset < YEARS_OFFERED; offset++) {
      const year = startYear - offset;
      const fy = `${String(year)}-${String((year + 1) % 100).padStart(2, '0')}`;
      const rules = TaxRuleTable.rulesFor(fy);
      financialYears.push({
        financialYear: fy,
        assessmentYear: FyCalendar.assessmentYearOf(fy),
        isCurrent: fy === currentFy,
        rulesAvailable: rules.ok,
        ...(rules.ok ? { rulesStatus: rules.value.status } : {}),
      });
    }

    const calendarYears: CalendarYearOption[] = [];
    for (let offset = 0; offset < YEARS_OFFERED; offset++) {
      const year = currentCy - offset;
      calendarYears.push({
        calendarYear: year,
        isCurrent: year === currentCy,
        isComplete: year < currentCy,
      });
    }

    // Falls back to the current year when nothing has rates at all, so the
    // default is always a year that appears in the list.
    const computable = financialYears.find((year) => year.rulesAvailable);

    return {
      today,
      currentFinancialYear: currentFy,
      currentAssessmentYear: FyCalendar.assessmentYearOf(currentFy),
      currentCalendarYear: currentCy,
      defaultFinancialYear: computable?.financialYear ?? currentFy,
      defaultCalendarYear:
        calendarYears.find((year) => year.isComplete)?.calendarYear ?? currentCy,
      financialYears,
      calendarYears,
    };
  },
};

/* --------------------------------------------------------------- templates */

export interface TemplateSummary {
  readonly name: string;
  readonly description: string;
  readonly assetClass: string;
  readonly columns: readonly string[];
  readonly guidance: string;
}

export const TemplateUC = {
  list(): readonly TemplateSummary[] {
    return TemplateRegistry.definitions().map((template) => ({
      name: template.name,
      description: template.description,
      assetClass: template.assetClass,
      columns: template.columns,
      guidance: template.guidance,
    }));
  },
  generate(name: string): string {
    return TemplateRegistry.generate(name);
  },
};

/* ------------------------------------------------------------------ ledger */

export const LedgerUC = {
  assets(): Promise<readonly Asset[]> {
    return AssetRepository.all();
  },
  liabilities(): Promise<readonly Liability[]> {
    return LiabilityRepository.all();
  },
  exits(): Promise<readonly ExitTransaction[]> {
    return ExitRepository.all();
  },

  /**
   * Removes a holding: its lots, its income events, its corporate actions and
   * its disposals all go with it.
   *
   * The disposals go too, and that is correct rather than incidental — an exit
   * is a sale OF this holding, and one left behind would report a realised gain
   * on units the book no longer says were ever acquired. A user who wants to
   * undo one sale wants `deleteExit`, which is a different operation.
   *
   * Hand loans and chits are refused here and routed to their own use cases: a
   * loan deleted through this generic path would skip the audit entry, and the
   * trail's whole value is that it cannot be got around.
   */
  async deleteAsset(assetId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('deleting this holding');
    if (!permitted.ok) return permitted;

    const asset = await AssetRepository.findById(assetId);
    if (asset === undefined) {
      return Err(new VaultStateError(`no asset ${assetId} was found`));
    }
    if (asset.assetClass === 'HAND_LOAN') {
      return Err(
        new VaultStateError('a hand loan is deleted from the Loans tab, so its audit trail is written'),
      );
    }
    if (asset.assetClass === 'CHIT_FUND') {
      return Err(new VaultStateError('a chit is deleted from the Chits tab'));
    }

    const removed = await AssetRepository.delete(assetId);
    if (!removed.ok) return removed;
    currentPorts().logger.info('holding deleted');
    return Ok(undefined);
  },

  /**
   * Undoes one disposal, returning the units to the lots it took them from.
   *
   * Deleting the exit row alone would leave the holding permanently short: the
   * depletion lives in `remainingQuantity`, not in the presence of the exit, so
   * nothing would ever put those units back. The reversal is driven by the
   * exit's own allocations and is written with the delete in one transaction —
   * see `ExitRepository.deleteWithAssets`.
   */
  async deleteExit(txnId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const permitted = requireEditMode('deleting this disposal');
    if (!permitted.ok) return permitted;

    const exit = await ExitRepository.findById(txnId);
    if (exit === undefined) {
      return Err(new VaultStateError(`no disposal ${txnId} was found`));
    }

    const asset = await AssetRepository.findById(exit.assetId);
    if (asset === undefined) {
      return Err(new VaultStateError(`the holding this disposal belongs to is no longer on the book`));
    }

    const restored = FifoAllocator.restore(asset.lots, exit.allocations);
    if (!restored.ok) return restored;

    // The position is open again by definition: units it had sold are back.
    const { positionClosed: _closed, ...rest } = asset;
    const reversal = await ExitRepository.deleteWithAssets(txnId, [
      { ...rest, lots: restored.value },
    ]);
    if (!reversal.ok) return reversal;
    currentPorts().logger.info('disposal deleted');
    return Ok(undefined);
  },
};

/* -------------------------------------------------------------- compliance */

export interface GenerateComplianceUCOps {
  scheduleFaA3(calendarYear: number): Promise<Result<readonly ScheduleFaA3Row[]>>;
  scheduleFaD(calendarYear: number): Promise<Result<readonly ScheduleFaDRow[]>>;
  scheduleAl(financialYear: FinancialYear): Promise<Result<ScheduleAl>>;
}

/** 31 December of the disclosure year — Schedule FA is calendar-aligned. */
const foreignSnapshotId = (calendarYear: number) => `FOR_31DEC${String(calendarYear)}`;
/** 31 March closing the financial year, e.g. FY 2025-26 → 31 Mar 2026. */
const domesticSnapshotId = (financialYear: FinancialYear) =>
  `DOM_31MAR${String(Number(financialYear.slice(0, 4)) + 1)}`;

export const GenerateComplianceUC: GenerateComplianceUCOps = {
  async scheduleFaA3(calendarYear: number): Promise<Result<readonly ScheduleFaA3Row[]>> {
    const snapshot = await SnapshotRepository.findById(foreignSnapshotId(calendarYear));
    if (snapshot === undefined) {
      return Err(
        new VaultStateError(
          `no 31-December ${String(calendarYear)} foreign snapshot exists; Schedule FA is generated from a frozen snapshot, not from live values`,
        ),
      );
    }

    /*
     * Table A3 requires the PEAK value reached during the calendar year, which
     * needs a daily price and rate series. This build records holdings and
     * closing values but no daily history, so there is nothing to take a maximum
     * over. Returning rows computed from the closing value alone would understate
     * the peak — and under the Black Money Act an understated foreign disclosure
     * is treated far more harshly than an understated domestic one, so this fails
     * loudly instead.
     */
    return Err(
      new VaultStateError(
        'Schedule FA Table A3 needs a daily price and exchange-rate history to compute peak value; this build does not yet record one',
      ),
    );
  },

  async scheduleFaD(calendarYear: number): Promise<Result<readonly ScheduleFaDRow[]>> {
    const snapshot = await SnapshotRepository.findById(foreignSnapshotId(calendarYear));
    if (snapshot === undefined) {
      return Err(
        new VaultStateError(
          `no 31-December ${String(calendarYear)} foreign snapshot exists; Schedule FA is generated from a frozen snapshot, not from live values`,
        ),
      );
    }
    // Foreign bank and custodial accounts are not modelled as assets yet, so
    // there is genuinely nothing to disclose rather than nothing recorded.
    return ScheduleFaGenerator.tableD({ foreignSnapshot: snapshot, calendarYear, accounts: [] });
  },

  async scheduleAl(financialYear: FinancialYear): Promise<Result<ScheduleAl>> {
    const snapshot = await SnapshotRepository.findById(domesticSnapshotId(financialYear));
    if (snapshot === undefined) {
      return Err(
        new VaultStateError(
          `no 31-March snapshot exists for FY ${financialYear}; Schedule AL reports year-end positions and is generated from that snapshot`,
        ),
      );
    }

    const profile = profileFor(financialYear);
    if (!profile.ok) return profile;

    const [assets, liabilities] = await Promise.all([
      AssetRepository.all(),
      LiabilityRepository.all(),
    ]);

    return ScheduleAlGenerator.generate({
      domesticSnapshot: snapshot,
      totalIncome: profile.value.grossSalary,
      // Schedule AL is filed with the return for the ASSESSMENT year (FY + 1).
      assessmentYear: FyCalendar.assessmentYearOf(financialYear),
      items: ScheduleAlGenerator.itemsFrom({ assets, liabilities }),
    });
  },
};

/* ------------------------------------------------------------------- audit */

export const AuditUC = {
  egressLog(): Promise<readonly EgressAuditEntry[]> {
    // Nothing is dispatched without the egress profile, so an empty log is the
    // correct answer for a default install (ADR-010).
    return Promise.resolve([]);
  },
  applicationLog(): Promise<readonly string[]> {
    return Promise.resolve(applicationLogLines);
  },
};

const applicationLogLines: string[] = [];
export function recordLogLine(line: string): void {
  applicationLogLines.push(line);
}
export function clearApplicationLog(): void {
  applicationLogLines.length = 0;
}
