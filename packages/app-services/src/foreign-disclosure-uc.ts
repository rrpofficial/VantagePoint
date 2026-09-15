/**
 * Schedule FA's inputs, and the readiness report that says why it will refuse
 * (Phase 6, objective 5).
 *
 * The plan's acceptance criterion is two sentences: "with a full year of marks,
 * Table A3 generates and its peak value exceeds the 31-Dec closing value. With a
 * gap, it still refuses." Refusing is easy; refusing *usefully* is the work, and
 * that is what `readiness` is for — it names every holding, every gap and every
 * missing entity detail, so the refusal is something a user can close rather
 * than a wall.
 */
import {
  Err,
  Money,
  Ok,
  VaultStateError,
  type Currency,
  type IsoDate,
  type Result,
} from '@vantagepoint/shared-kernel';
import { firstAcquisitionOf, type Asset } from '@vantagepoint/core-domain';
import {
  AssetRepository,
  ForeignDisclosureRepository,
  MarkRepository,
  Vault,
  type ForeignAccount,
  type ForeignHoldingDetail,
  type MarkCoverage,
} from '@vantagepoint/persistence';
import { createHash } from 'node:crypto';
import { currentPorts } from './context.js';
import { requireEditMode } from './edit-mode.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const requireUnlocked = (): Result<void> =>
  Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));

export interface HoldingReadiness {
  readonly assetId: string;
  readonly label: string;
  readonly currency: string;
  readonly hasEntityDetail: boolean;
  readonly priceCoverage: MarkCoverage;
  readonly rateCoverage: MarkCoverage;
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export interface FaReadiness {
  readonly calendarYear: number;
  readonly holdings: readonly HoldingReadiness[];
  readonly accountCount: number;
  readonly ready: boolean;
}

export interface RecordForeignDetailInput {
  readonly assetId: string;
  readonly countryCode: string;
  readonly entityName: string;
  readonly entityAddress: string;
  readonly natureOfEntity: string;
  readonly acquisitionDate?: IsoDate;
  readonly notes?: string;
}

export interface RecordForeignAccountInput {
  readonly countryCode: string;
  readonly institutionName: string;
  readonly accountNumber: string;
  readonly accountOpenDate: IsoDate;
  readonly currency: Currency;
  readonly peakBalance: string;
  readonly closingBalance: string;
  readonly calendarYear: number;
  readonly notes?: string;
}

const window = (year: number) => ({
  from: `${String(year)}-01-01`,
  to: `${String(year)}-12-31`,
});

const foreignHoldings = async (): Promise<readonly Asset[]> =>
  (await AssetRepository.all()).filter(
    (asset) => asset.jurisdiction === 'FOREIGN' && asset.lots.length > 0,
  );

export const ForeignDisclosureUC = {
  /**
   * What stands between the vault and a Table A3 for this year.
   *
   * Reported per holding rather than as one verdict: "it refuses" is not
   * actionable, and the two reasons it refuses — an incomplete series and a
   * missing entity record — have completely different fixes.
   */
  async readiness(calendarYear: number): Promise<Result<FaReadiness>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const span = window(calendarYear);
    const [assets, details, accounts] = await Promise.all([
      foreignHoldings(),
      ForeignDisclosureRepository.details(),
      ForeignDisclosureRepository.accounts(calendarYear),
    ]);
    const detailFor = new Set(details.map((detail) => detail.assetId));

    const holdings = assets.map((asset) => {
      const acquired = firstAcquisitionOf(asset) ?? span.from;
      const from = acquired > span.from ? acquired : span.from;
      const instrument = asset.isin ?? asset.symbol ?? asset.assetId;

      const priceCoverage = MarkRepository.coverage('ASSET', instrument, from, span.to);
      const rateCoverage =
        asset.currency === 'INR'
          ? { covered: true, markCount: 0, gaps: [] }
          : MarkRepository.coverage('CURRENCY', asset.currency, from, span.to);

      const hasEntityDetail = detailFor.has(asset.assetId);
      const blockers: string[] = [];
      if (!hasEntityDetail) {
        blockers.push('no entity country, name, address or nature recorded');
      }
      if (!priceCoverage.covered && priceCoverage.shortfall !== undefined) {
        blockers.push(priceCoverage.shortfall);
      }
      if (!rateCoverage.covered && rateCoverage.shortfall !== undefined) {
        blockers.push(rateCoverage.shortfall);
      }

      return {
        assetId: asset.assetId,
        label: asset.symbol ?? asset.isin ?? asset.assetId,
        currency: asset.currency,
        hasEntityDetail,
        priceCoverage,
        rateCoverage,
        ready: blockers.length === 0,
        blockers,
      };
    });

    return Ok({
      calendarYear,
      holdings,
      accountCount: accounts.length,
      ready: holdings.every((holding) => holding.ready),
    });
  },

  details: (): Promise<readonly ForeignHoldingDetail[]> => ForeignDisclosureRepository.details(),

  /**
   * Recording the entity detail is additive; replacing it is not.
   *
   * A country or an entity name already stated is one a disclosure may already
   * have been generated from, so changing it takes the same gate every other
   * change does.
   */
  async recordDetail(input: RecordForeignDetailInput): Promise<Result<ForeignHoldingDetail>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    for (const [field, value] of [
      ['country', input.countryCode],
      ['entity name', input.entityName],
      ['entity address', input.entityAddress],
      ['nature of the entity', input.natureOfEntity],
    ] as const) {
      if (value.trim().length === 0) {
        return Err(
          new VaultStateError(
            `Schedule FA states the ${field} of every foreign holding, so it cannot be left blank`,
          ),
        );
      }
    }
    if (input.acquisitionDate !== undefined && !ISO_DATE.test(input.acquisitionDate)) {
      return Err(new VaultStateError('an acquisition date must be written as YYYY-MM-DD'));
    }

    const asset = await AssetRepository.findById(input.assetId);
    if (asset === undefined) return Err(new VaultStateError('no holding with that id'));
    if (asset.jurisdiction !== 'FOREIGN') {
      return Err(new VaultStateError('Schedule FA discloses foreign holdings only'));
    }

    const existing = (await ForeignDisclosureRepository.details()).some(
      (detail) => detail.assetId === input.assetId,
    );
    if (existing) {
      const gate = requireEditMode('changing the Schedule FA entity detail already recorded');
      if (!gate.ok) return gate;
    }

    const detail: ForeignHoldingDetail = {
      assetId: input.assetId,
      countryCode: input.countryCode.trim().toUpperCase(),
      entityName: input.entityName.trim(),
      entityAddress: input.entityAddress.trim(),
      natureOfEntity: input.natureOfEntity.trim(),
      ...(input.acquisitionDate === undefined ? {} : { acquisitionDate: input.acquisitionDate }),
      ...(input.notes === undefined || input.notes.trim().length === 0
        ? {}
        : { notes: input.notes.trim() }),
    };
    const saved = await ForeignDisclosureRepository.saveDetail(detail);
    return saved.ok ? Ok(detail) : saved;
  },

  accounts: (calendarYear?: number): Promise<readonly ForeignAccount[]> =>
    ForeignDisclosureRepository.accounts(calendarYear),

  async recordAccount(input: RecordForeignAccountInput): Promise<Result<ForeignAccount>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    if (input.institutionName.trim().length === 0 || input.accountNumber.trim().length === 0) {
      return Err(new VaultStateError('a foreign account needs an institution and an account number'));
    }
    if (!ISO_DATE.test(input.accountOpenDate)) {
      return Err(new VaultStateError('an account opening date must be written as YYYY-MM-DD'));
    }

    const peak = Money.parse(input.peakBalance, input.currency);
    if (!peak.ok) return peak;
    const closing = Money.parse(input.closingBalance, input.currency);
    if (!closing.ok) return closing;

    /*
     * A peak below the closing balance is arithmetically impossible, and the
     * likely cause is that the closing figure was typed into both. Refused
     * rather than corrected: under the Black Money Act an understated peak is
     * the expensive direction, and silently substituting the larger number
     * would produce a disclosure the holder never checked.
     */
    if (Money.compare(peak.value, closing.value) < 0) {
      return Err(
        new VaultStateError(
          'the peak balance is below the closing balance, which cannot be — the peak is the ' +
            'highest the account reached during the year, read off your statements',
        ),
      );
    }

    /*
     * Identity from the account and the year it describes, so re-entering the
     * same account for the same year updates it, while the following year's
     * figures are a new row — a peak has no meaning without its window.
     */
    const accountId = `facct_${createHash('sha256')
      .update([input.accountNumber.trim(), String(input.calendarYear)].join('|'))
      .digest('hex')
      .slice(0, 16)}`;

    const existing = (await ForeignDisclosureRepository.accounts(input.calendarYear)).some(
      (account) => account.accountId === accountId,
    );
    if (existing) {
      const gate = requireEditMode('changing a foreign account already recorded for that year');
      if (!gate.ok) return gate;
    }

    const account: ForeignAccount = {
      accountId,
      countryCode: input.countryCode.trim().toUpperCase(),
      institutionName: input.institutionName.trim(),
      accountNumber: input.accountNumber.trim(),
      accountOpenDate: input.accountOpenDate,
      currency: input.currency,
      peakBalance: peak.value,
      closingBalance: closing.value,
      calendarYear: input.calendarYear,
      status: 'OPEN',
      ...(input.notes === undefined || input.notes.trim().length === 0
        ? {}
        : { notes: input.notes.trim() }),
    };
    const saved = await ForeignDisclosureRepository.saveAccount(account);
    if (!saved.ok) return saved;

    currentPorts().logger.info('foreign account recorded');
    return Ok(account);
  },

  async deleteAccount(accountId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    const gate = requireEditMode('deleting a foreign account');
    if (!gate.ok) return gate;
    return ForeignDisclosureRepository.deleteAccount(accountId);
  },
};

export const MarksUC = {
  /**
   * Folds every rate and price already in the vault into the marks series.
   *
   * Called after an import, and available as a button, because the series is
   * what Table A3's peak is taken over and a statement imported before this
   * existed would otherwise never reach it.
   */
  async sync(): Promise<Result<{ currencyMarks: number; assetMarks: number }>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;
    return MarkRepository.syncFromLedger();
  },

  /**
   * A daily close recorded by hand.
   *
   * The only way to build a complete series for a holding whose statements are
   * monthly, which is most of them. Ungated and overwriting, because a mark is
   * an observation rather than a record of money moving, and nothing is frozen
   * against it — a snapshot stores its own values (ADR-006).
   */
  async record(input: {
    kind: 'CURRENCY' | 'ASSET';
    key: string;
    date: IsoDate;
    value: string;
    currency?: Currency;
    sourceDocumentRef: string;
  }): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    if (!ISO_DATE.test(input.date)) {
      return Err(new VaultStateError('a mark needs its date, as YYYY-MM-DD'));
    }
    const parsed = Money.parse(input.value, input.currency ?? 'INR');
    if (!parsed.ok) return Err(new VaultStateError('a mark must be a number'));
    if (Money.compare(parsed.value, Money.zero(parsed.value.currency)) <= 0) {
      return Err(new VaultStateError('a mark must be greater than zero'));
    }
    if (input.sourceDocumentRef.trim().length === 0) {
      /*
       * Required, exactly as it is on an FX rate. A disclosure figure with no
       * provenance cannot be defended to an assessing officer, and this one
       * feeds a Schedule FA peak.
       */
      return Err(
        new VaultStateError('a mark needs the document it came from, so the figure can be traced'),
      );
    }

    return MarkRepository.save(
      [
        {
          kind: input.kind,
          key: input.key,
          date: input.date,
          value: parsed.value.amount,
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          source: 'MANUAL',
          sourceDocumentRef: input.sourceDocumentRef.trim(),
        },
      ],
      currentPorts().clock.now(),
    );
  },

  coverage(
    kind: 'CURRENCY' | 'ASSET',
    key: string,
    calendarYear: number,
  ): Promise<Result<MarkCoverage>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    const span = window(calendarYear);
    return Promise.resolve(Ok(MarkRepository.coverage(kind, key, span.from, span.to)));
  },
};
