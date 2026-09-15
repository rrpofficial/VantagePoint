/** Snapshot types. Types only — no runtime behaviour. */
import type {
  IsoDate,
  IsoDateTime,
  Money,
  Percentage,
  Quantity,
  Rate,
} from '@vantagepoint/shared-kernel';
import type {
  AssetClass,
  Jurisdiction,
  ValuedPosition,
} from '@vantagepoint/core-domain';

export type SnapshotKind = 'DOMESTIC_COMPLIANCE' | 'FOREIGN_COMPLIANCE' | 'CUSTOM';
export type SnapshotScope = 'DOMESTIC' | 'FOREIGN' | 'ALL';

export interface SnapshotPosition extends ValuedPosition {
  readonly jurisdiction: Jurisdiction;
  /**
   * Value in the holding's own currency, and the rate used to reach INR.
   * Both are needed to separate price movement from currency movement in a
   * comparison; without them the two are indistinguishable in the INR total.
   */
  readonly nativeValue?: Money;
  readonly fxRate?: Rate;
}

export interface Snapshot {
  readonly snapshotId: string;
  readonly kind: SnapshotKind;
  readonly scope: SnapshotScope;
  readonly asOf: IsoDateTime;
  readonly positions: readonly SnapshotPosition[];
  readonly totals: {
    readonly netWorth: Money;
    readonly grossAssets: Money;
    readonly liabilities: Money;
    readonly byAssetClass: Readonly<Partial<Record<AssetClass, Money>>>;
  };
  readonly contentHash: string;
  readonly createdAt: IsoDateTime;
  readonly frozen: true;
  readonly supersededRateAvailable?: boolean;
}

export interface SnapshotSpec {
  readonly snapshotId: string;
  readonly kind: SnapshotKind;
  readonly scope: SnapshotScope;
  readonly asOf: IsoDateTime;
}

export type MovementBucket = 'NEW' | 'LIQUIDATED' | 'INCREASED' | 'DECREASED' | 'UNCHANGED';

export interface PositionDelta {
  readonly assetId: string;
  /**
   * The asset class this position had, so a comparison can be scoped to one
   * sleeve without joining back against the live ledger — where a position sold
   * since the snapshot no longer exists to classify.
   */
  readonly assetClass: string;
  readonly bucket: MovementBucket;
  readonly quantityBefore: Quantity;
  readonly quantityAfter: Quantity;
  readonly valueBefore: Money;
  readonly valueAfter: Money;
  readonly valueDelta: Money;
  readonly valueDeltaPct: Percentage;
  /** Price movement and currency movement attributed separately. */
  readonly priceEffect?: Money;
  readonly currencyEffect?: Money;
}

export interface AllocationRow {
  readonly assetClass: AssetClass;
  readonly pctBefore: Percentage;
  readonly pctAfter: Percentage;
  readonly shiftPct: Percentage;
}

export interface VarianceReport {
  readonly netWorthBefore: Money;
  readonly netWorthAfter: Money;
  readonly netWorthDelta: Money;
  readonly netWorthDeltaPct: Percentage;
  readonly positions: readonly PositionDelta[];
  readonly topGainers: readonly PositionDelta[];
  readonly newAdditions: readonly PositionDelta[];
  readonly liquidations: readonly PositionDelta[];
  readonly allocation: readonly AllocationRow[];
}

export interface CashFlow {
  readonly date: IsoDate;
  readonly amount: Money;
}
