/**
 * Projecting parsed statement rows onto the asset ledger (US-4.1).
 *
 * The parsers deliberately stop at "these are the rows". This is where rows
 * become holdings: a BUY opens a lot, a SELL consumes lots FIFO, a dividend
 * becomes an income event. It lives in `ingestion` rather than `app-services`
 * because it is a rule, not wiring, and rules belong in a domain package.
 *
 * Two properties matter more than completeness here:
 *
 *  1. **Identity is derived, not generated.** Asset and lot ids come from the
 *     statement content, so re-importing the same file merges into the same
 *     holdings instead of duplicating them (US-4.7).
 *  2. **Nothing is silently absorbed.** A row this cannot place — an account-level
 *     fee with no lot to attach to, a generic template row with no asset class —
 *     comes back in `unapplied` with a reason. Quietly folding an unattributable
 *     fee into some arbitrary lot would invent a cost basis, and an invented cost
 *     basis is indistinguishable from a real one once it is stored.
 */
import { createHash } from 'node:crypto';
import { Money, Ok, type Result } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import {
  AssetRegistry,
  FifoAllocator,
  LotBook,
  equityExitId,
  equityLotId,
  isAssetClass,
  type AcquisitionLot,
  type Asset,
  type AssetClass,
  type EquityAwardKind,
  type ExitTransaction,
  type IncomeEvent,
} from '@vantagepoint/core-domain';
import type { ParsedTransaction, ParserName, ReconciliationNote } from './types.js';

/** A row that parsed cleanly but could not be placed on the ledger. */
export interface UnappliedTransaction {
  readonly kind: ParsedTransaction['kind'];
  readonly date: string;
  readonly symbol?: string;
  readonly sourceRow: number;
  readonly reason: string;
}

export interface LedgerProjection {
  readonly assets: readonly Asset[];
  /**
   * The assets these transactions actually landed on, in the order first
   * touched.
   *
   * `assets` carries every holding in the vault, because a projection merges
   * into what is already there rather than replacing it. A caller that wanted to
   * know which asset its own row produced therefore could not read `assets[0]` —
   * that is simply the first holding the user happens to own, and the manual
   * trade form returned exactly that id to the browser.
   */
  readonly touched: readonly string[];
  /** Disposals, recorded so they are neither re-applied nor lost to tax. */
  readonly exits: readonly ExitTransaction[];
  readonly unapplied: readonly UnappliedTransaction[];
  /** Figures the source stated that this recomputed differently. */
  readonly reconciliation: readonly ReconciliationNote[];
}

/**
 * What a source format holds, when the format itself tells us. TEMPLATE is
 * absent on purpose: `parseTemplate` is a generic reader that does not preserve
 * which template it read, so guessing an asset class here would mislabel a hand
 * loan as equity — and asset class drives tax treatment.
 */
const PARSER_ASSET_CLASS: Readonly<Partial<Record<ParserName, AssetClass>>> = {
  ZERODHA_TRADEBOOK: 'DOMESTIC_EQUITY',
  ZERODHA_TAX_PNL: 'DOMESTIC_EQUITY',
  VESTED: 'FOREIGN_EQUITY',
  ETRADE: 'FOREIGN_EQUITY',
  /*
   * A safety net only. Every row the G&L parser emits states its own class from
   * the file's Plan Type column, and a row whose plan cannot be read is rejected
   * outright rather than defaulted. This catches a future code path that forgets
   * to state one: landing such a row on FOREIGN_EQUITY makes it visible and
   * reportable as unapplied, where dropping it would make it disappear.
   */
  ETRADE_GL: 'FOREIGN_EQUITY',
  ETRADE_HOLDINGS: 'FOREIGN_EQUITY',
  CAMS: 'DOMESTIC_MUTUAL_FUND',
};

/**
 * Equity compensation is FOREIGN_EQUITY, like any other share of the company.
 *
 * It was once RSU and ESPP, two asset classes of their own, which split one
 * company's shares across separate holdings — the same symbol bought outright
 * and received as an RSU became two assets, double counted on screen and matched
 * FIFO in two separate queues. How a tranche was acquired now lives on the lot,
 * as `equityAward`, where it belongs: it changes the perquisite and the cost
 * basis, not what the security is.
 */
const KIND_ASSET_CLASS: Readonly<Partial<Record<ParsedTransaction['kind'], AssetClass>>> = {
  RSU_VEST: 'FOREIGN_EQUITY',
  ESPP_PURCHASE: 'FOREIGN_EQUITY',
};

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

function assetClassFor(
  transaction: ParsedTransaction,
  parser: ParserName,
): AssetClass | undefined {
  // A row that states its own class wins: a VantagePoint template says exactly what
  // it holds, which is more authoritative than anything the file format implies.
  if (transaction.assetClass !== undefined && isAssetClass(transaction.assetClass)) {
    return transaction.assetClass;
  }
  return KIND_ASSET_CLASS[transaction.kind] ?? PARSER_ASSET_CLASS[parser];
}

/**
 * Stable across imports of the same file, and across different files describing
 * the same holding: ISIN first because it identifies a security globally, then
 * symbol, then the opaque folio reference.
 *
 * **A hand loan is identified by the LOAN, not by the borrower.** Two loans to
 * the same person are two receivables: different principal, different rate,
 * different start date, and therefore different interest accruing on each. Keyed
 * on the borrower alone they collapsed into one asset carrying a single set of
 * terms, and the valuation — which reads one principal — silently reported only
 * the first, understating money lent by the whole of the second loan.
 *
 * The discriminator is the loan's own terms rather than its file position, so a
 * re-import, or the same loan exported in a different row order, still resolves
 * to the same asset.
 */
function assetIdFor(transaction: ParsedTransaction, assetClass: AssetClass): string {
  const key = transaction.isin ?? transaction.symbol ?? transaction.folioRef;
  const base = `ast_${slug(assetClass)}_${key === undefined ? 'unidentified' : slug(key)}`;

  if (transaction.handLoan !== undefined) {
    return `${base}_${slug(transaction.handLoan.startDate)}_${slug(transaction.pricePerUnit.amount)}`;
  }
  /*
   * Two deposits at one bank are two assets. The label alone does not separate
   * them — "HDFC FD" is a plausible name for both — so the opening date joins
   * the key, exactly as a loan's start date does. Without it the second row
   * would merge into the first and its balance would be lost.
   */
  if (transaction.balanceAccount !== undefined) {
    return `${base}_${slug(transaction.balanceAccount.openedOn)}`;
  }
  return base;
}

/**
 * The lot's identity.
 *
 * An equity-award lot is identified by its GRANT and the tranche within it, so
 * the same vest resolves to the same lot whichever file describes it — a Gains &
 * Losses export listing what was sold, or a holdings export listing what is
 * still held. Those two files state different quantities and round prices
 * differently, so anything derived from the row's figures would split one
 * tranche in two.
 *
 * Everything else falls back to provenance, which makes a re-import of the SAME
 * file idempotent — the best available when the source offers no stable
 * reference of its own.
 */
function lotIdFor(transaction: ParsedTransaction): string {
  if (transaction.equityAward !== undefined) {
    return equityLotId(transaction.equityAward, transaction.date);
  }
  const digest = transaction.provenance.importedAt.replace('import:', '');
  return `lot_${digest}_${String(transaction.provenance.sourceRow).padStart(5, '0')}`;
}

/**
 * The disposal's identity: the broker's order, and the tranche it came out of.
 *
 * Deliberately NOT derived from the lot id alone. One tranche is routinely sold
 * more than once — a sell-to-cover on vest day and a manual sale months later —
 * and two disposals sharing an id means the second is silently discarded as an
 * already-seen exit, leaving its proceeds out of the gain entirely.
 */
function exitIdFor(transaction: ParsedTransaction): string {
  if (transaction.equityAward !== undefined) {
    const stable = equityExitId({
      ...(transaction.orderRef === undefined ? {} : { orderRef: transaction.orderRef }),
      lotId: equityLotId(transaction.equityAward, transaction.date),
      exitDate: transaction.date,
      quantity: transaction.quantity,
    });
    if (stable !== undefined) return stable;
  }
  const digest = transaction.provenance.importedAt.replace('import:', '');
  return `exit_${digest}_${String(transaction.provenance.sourceRow).padStart(5, '0')}`;
}

interface Draft {
  asset: Asset;
  lots: AcquisitionLot[];
  income: IncomeEvent[];
}

function draftFor(
  drafts: Map<string, Draft>,
  assetId: string,
  assetClass: AssetClass,
  transaction: ParsedTransaction,
): Draft {
  const existing = drafts.get(assetId);
  if (existing !== undefined) return existing;

  const base: Asset = {
    assetId,
    assetClass,
    jurisdiction: AssetRegistry.jurisdictionOf(assetClass),
    currency: transaction.pricePerUnit.currency,
    ...(transaction.symbol === undefined || transaction.symbol.length === 0
      ? {}
      : { symbol: transaction.symbol }),
    ...(transaction.isin === undefined || transaction.isin.length === 0
      ? {}
      : { isin: transaction.isin }),
    ...(transaction.folioRef === undefined ? {} : { folioRef: transaction.folioRef }),
    lots: [],
    incomeEvents: [],
    corporateActions: [],
  };
  const draft: Draft = { asset: base, lots: [], income: [] };
  drafts.set(assetId, draft);
  return draft;
}

/** Deterministic, so re-importing the same sheet does not duplicate a payment. */
function paymentIdFor(assetId: string, prefix: string, date: string, amount: string): string {
  return `${prefix}_${createHash('sha256')
    .update([assetId, date, amount].join('|'))
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * Builds the loan, including a repayment the source had no column for.
 *
 * A spreadsheet that tracks status as a word records "Repaid" without recording
 * WHEN or HOW MUCH principal came back. Importing the word alone would leave the
 * loan showing its full principal outstanding forever, contradicting the sheet
 * it came from. Where a row says Repaid and lists no principal repayment, a full
 * repayment is reconstructed on the closing date — or on the loan date if none
 * is given, which accrues no interest and is the conservative reading.
 */
function handLoanFrom(
  assetId: string,
  transaction: ParsedTransaction,
  parsed: NonNullable<ParsedTransaction['handLoan']>,
): NonNullable<Asset['handLoan']> {
  const repayments = parsed.principalRepayments.map((payment) => ({
    date: payment.date,
    principal: payment.amount,
    paymentId: paymentIdFor(assetId, 'rep', payment.date, payment.amount.amount),
    mode: 'OTHER' as const,
  }));

  const declaredRepaid = parsed.declaredStatus === 'REPAID';
  const alreadyCovered = repayments.some((repayment) =>
    Money.compare(repayment.principal, transaction.pricePerUnit) >= 0,
  );

  if (declaredRepaid && !alreadyCovered) {
    const settledOn = parsed.closedDate ?? parsed.startDate;
    const outstanding = repayments.reduce(
      (remaining, repayment) => Money.subtract(remaining, repayment.principal),
      transaction.pricePerUnit,
    );
    if (Money.compare(outstanding, Money.zero(outstanding.currency)) > 0) {
      repayments.push({
        date: settledOn,
        principal: outstanding,
        paymentId: paymentIdFor(assetId, 'rep', settledOn, outstanding.amount),
        mode: 'OTHER' as const,
      });
    }
  }

  return {
    assetId,
    borrowerRef: parsed.borrowerRef,
    borrowerName: parsed.borrowerName,
    principal: transaction.pricePerUnit,
    interestRatePct: parsed.interestRatePct,
    interestBasis: parsed.interestBasis,
    startDate: parsed.startDate,
    ...(parsed.closedDate === undefined ? {} : { closedDate: parsed.closedDate }),
    ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
    repayments,
    interestPayments: parsed.interestPayments.map((payment) => ({
      paymentId: paymentIdFor(assetId, 'int', payment.date, payment.amount.amount),
      date: payment.date,
      amount: payment.amount,
      mode: 'OTHER' as const,
    })),
  };
}

const ACQUISITION_KINDS = new Set<ParsedTransaction['kind']>([
  'BUY',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'REINVESTMENT',
]);

export function projectToLedger(input: {
  readonly transactions: readonly ParsedTransaction[];
  readonly parser: ParserName;
  /** Holdings already in the vault, so an import merges rather than replaces. */
  readonly existing?: readonly Asset[];
  /** Disposals already recorded, so a re-import does not sell the same units twice. */
  readonly existingExits?: readonly ExitTransaction[];
}): Result<LedgerProjection> {
  const drafts = new Map<string, Draft>();
  for (const asset of input.existing ?? []) {
    drafts.set(asset.assetId, {
      asset,
      lots: [...asset.lots],
      income: [...asset.incomeEvents],
    });
  }

  const exits: ExitTransaction[] = [];
  const touched: string[] = [];
  const seenExits = new Set((input.existingExits ?? []).map((exit) => exit.txnId));
  const reconciliation: ReconciliationNote[] = [];
  /*
   * What a holdings export claims is left of each tranche, checked at the end
   * against what the ledger's own disposals produce. Collected rather than
   * compared inline: disposals are applied as they are reached, so the computed
   * remainder is only final once every row has been processed.
   */
  const statedRemaining = new Map<string, { quantity: string; sourceRow: number }>();
  /*
   * Tranches a holdings export has stated in full. Once one is known whole, a
   * partial statement of it adds nothing — its units are already counted.
   */
  const authoritativeLots = new Set<string>(
    (input.existing ?? []).flatMap((asset) =>
      asset.lots
        .filter((lot) => lot.statedRemainingQuantity !== undefined)
        .map((lot) => lot.lotId),
    ),
  );

  const unapplied: UnappliedTransaction[] = [];
  const reject = (transaction: ParsedTransaction, reason: string): void => {
    unapplied.push({
      kind: transaction.kind,
      date: transaction.date,
      ...(transaction.symbol === undefined ? {} : { symbol: transaction.symbol }),
      sourceRow: transaction.provenance.sourceRow,
      reason,
    });
  };

  // Chronological, so FIFO sees lots in the order they were actually opened even
  // when a statement lists sells before the buys that funded them.
  const ordered = [...input.transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.provenance.sourceRow - b.provenance.sourceRow,
  );

  for (const transaction of ordered) {
    const assetClass = assetClassFor(transaction, input.parser);
    if (assetClass === undefined) {
      reject(
        transaction,
        'this source format does not identify an asset class; import it through a typed parser',
      );
      continue;
    }

    const assetId = assetIdFor(transaction, assetClass);
    if (!touched.includes(assetId)) touched.push(assetId);

    /*
     * The property's own facts — name, type, area, location — belong to the
     * asset, not to the purchase, and arrive on whichever row mentions them.
     * Applied on a SELL as well as a BUY: a sale can be the first row that
     * names the property when only the disposal is being recorded.
     */
    if (transaction.propertyDetail !== undefined) {
      const draft = draftFor(drafts, assetId, assetClass, transaction);
      draft.asset = {
        ...draft.asset,
        property: { ...transaction.propertyDetail, assetId },
      };
    }

    /*
     * Deposit and scheme terms, like the property's own facts, belong to the
     * ASSET rather than to the lot the row also creates. The lot records the
     * opening entry; this is what the valuer reads to grow the balance (Phase 5).
     */
    if (transaction.balanceAccount !== undefined) {
      const draft = draftFor(drafts, assetId, assetClass, transaction);
      draft.asset = {
        ...draft.asset,
        balanceAccount: { ...transaction.balanceAccount, assetId },
      };
    }

    if (ACQUISITION_KINDS.has(transaction.kind)) {
      const draft = draftFor(drafts, assetId, assetClass, transaction);

      // Loan terms arrive with the row that opens the loan, and belong to the
      // asset rather than to a lot.
      if (transaction.handLoan !== undefined && draft.asset.handLoan === undefined) {
        const loan = handLoanFrom(assetId, transaction, transaction.handLoan);
        draft.asset = { ...draft.asset, handLoan: loan };

        // The status the sheet stated, checked against the one the repayments
        // imply. Neither overwrites the other; the disagreement is reported.
        const declared = transaction.handLoan.declaredStatus;
        if (declared !== undefined) {
          const repaid = loan.repayments.reduce(
            (sum, repayment) => Money.add(sum, repayment.principal),
            Money.zero(loan.principal.currency),
          );
          const computed =
            Money.compare(repaid, loan.principal) >= 0
              ? 'REPAID'
              : loan.repayments.length > 0
                ? 'PARTIALLY_REPAID'
                : 'ACTIVE';

          if (computed !== declared) {
            reconciliation.push({
              row: transaction.provenance.sourceRow,
              field: 'status',
              stated: declared,
              computed,
            });
          }
        }
      }

      const lot = LotBook.recordAcquisition({
        assetClass,
        tradeDate: transaction.date,
        quantity: transaction.quantity,
        pricePerUnit: transaction.pricePerUnit,
        lotId: lotIdFor(transaction),
        ...(transaction.equityAward === undefined
          ? {}
          : { equityAward: transaction.equityAward }),
        ...(transaction.fees === undefined ? {} : { fees: transaction.fees }),
        ...(transaction.otherCharges === undefined
          ? {}
          : { otherCharges: transaction.otherCharges }),
        ...(transaction.perquisiteValue === undefined
          ? {}
          : { perquisiteValue: transaction.perquisiteValue }),
        ...(transaction.property === undefined ? {} : { property: transaction.property }),
      });
      if (!lot.ok) {
        reject(transaction, lot.error.message);
        continue;
      }
      /*
       * Idempotent per tranche, and tolerant of two sources describing it
       * differently.
       *
       * A Gains & Losses row states only the units it DISPOSED of; a holdings row
       * states the tranche's full size. Both are true, and both now resolve to
       * the same lot id — so the larger is kept, because the smaller is a partial
       * view of it. Taking the first to arrive instead would make the result
       * depend on import order: G&L first would leave the still-held units off
       * the ledger entirely.
       *
       * Safe precisely because the id is grant-plus-tranche: one tranche is one
       * acquisition, so two statements of it can never be two different lots.
       */
      const existing = draft.lots.find((candidate) => candidate.lotId === lot.value.lotId);
      const partial = transaction.lotQuantityIsPartial === true;


      if (existing === undefined) {
        draft.lots.push(lot.value);
        if (!partial) authoritativeLots.add(lot.value.lotId);
      } else {
        /*
         * Two sources, one tranche.
         *
         * An AUTHORITATIVE statement — a holdings row — states the tranche whole,
         * so it sets the size. A PARTIAL one states a single sale out of it and
         * adds nothing here: slices are NOT summed, because the stored lot would
         * then be larger than any row that built it, and the duplicate detector
         * rebuilds its keys from stored lots — so a re-import would stop
         * recognising those rows and add every slice a second time.
         *
         * A lot known only from slices is instead sized by its DISPOSALS, in the
         * SELL branch below. Disposals are deduplicated by their own id, which
         * makes that idempotent however many times a file is imported.
         *
         * Growth is added to the REMAINDER too, so units already consumed stay
         * consumed.
         */
        const incoming = new Decimal(lot.value.quantity);
        const held = new Decimal(existing.quantity);
        const target = partial ? held : Decimal.max(held, incoming);

        if (target.greaterThan(held)) {
          const grown = target.minus(held);
          draft.lots = draft.lots.map((candidate) =>
            candidate.lotId === lot.value.lotId
              ? {
                  ...lot.value,
                  quantity: target.toFixed(),
                  remainingQuantity: new Decimal(existing.remainingQuantity).plus(grown).toFixed(),
                }
              : candidate,
          );
        }
        if (!partial) authoritativeLots.add(lot.value.lotId);
      }

      /*
       * Stamped onto the lot, not merely compared now.
       *
       * An import-time comparison only fires on the file that carried the stated
       * figure — load holdings first and disposals second and nothing is ever
       * checked. Stored, the claim outlives the import and the ledger can be
       * reconciled against it at any point afterwards.
       */
      if (transaction.statedRemainingQuantity !== undefined) {
        const stated = transaction.statedRemainingQuantity;
        draft.lots = draft.lots.map((candidate) =>
          candidate.lotId === lot.value.lotId
            ? { ...candidate, statedRemainingQuantity: stated }
            : candidate,
        );
        statedRemaining.set(lot.value.lotId, {
          quantity: stated,
          sourceRow: transaction.provenance.sourceRow,
        });
      }
      continue;
    }

    if (transaction.kind === 'SELL') {
      const draft = drafts.get(assetId);
      if (draft === undefined || draft.lots.length === 0) {
        reject(transaction, 'no holding to sell from; the matching purchase is not in the ledger');
        continue;
      }

      const txnId = exitIdFor(transaction);
      // Applying the same disposal twice would deplete the holding twice, and
      // the second depletion looks exactly like a legitimate later sale.
      if (seenExits.has(txnId)) continue;

      /*
       * Matched to the lot the SOURCE named, where it named one.
       *
       * A stock-plan sale states its grant and vest date, and the shares are not
       * fungible demat holdings whose identity was lost — so matching them
       * oldest-first re-derives an answer the broker's own statement contradicts.
       * The concrete symptom was a sell-to-cover on vest day consuming a lot from
       * five years earlier. See the note in `core-domain/lots.ts`.
       *
       * FIFO remains the fallback, and which one ran is recorded on the disposal
       * rather than inferred later.
       */
      const namedLot =
        transaction.equityAward === undefined
          ? undefined
          : equityLotId(transaction.equityAward, transaction.date);

      /*
       * Grow a slice-built lot to cover the disposal it is about to take.
       *
       * A tranche known only from a Gains & Losses export is created at the size
       * of its FIRST sale, because slices are not summed (see above). Its later
       * sales then find it empty. Sizing it from the disposals as they arrive
       * reconstructs the tranche exactly, and stays idempotent because a repeated
       * disposal is recognised by its own id and never reaches here.
       *
       * Only for a lot no holdings export has stated. Where one has, the tranche
       * is known whole and a sale exceeding it is a genuine discrepancy — to be
       * reported, not absorbed by quietly enlarging the holding.
       */
      if (namedLot !== undefined && !authoritativeLots.has(namedLot)) {
        const target = draft.lots.find((candidate) => candidate.lotId === namedLot);
        if (target !== undefined) {
          const short = new Decimal(transaction.quantity).minus(target.remainingQuantity);
          if (short.greaterThan(0)) {
            draft.lots = draft.lots.map((candidate) =>
              candidate.lotId === namedLot
                ? {
                    ...candidate,
                    quantity: new Decimal(candidate.quantity).plus(short).toFixed(),
                    remainingQuantity: new Decimal(candidate.remainingQuantity)
                      .plus(short)
                      .toFixed(),
                  }
                : candidate,
            );
          }
        }
      }

      const specific =
        namedLot === undefined
          ? undefined
          : FifoAllocator.allocateSpecific(draft.lots, namedLot, transaction.quantity);

      const allocated =
        specific?.ok === true
          ? specific
          : FifoAllocator.allocate(draft.lots, transaction.quantity);
      if (!allocated.ok) {
        reject(transaction, allocated.error.message);
        continue;
      }
      const lotMatching = specific?.ok === true ? 'SPECIFIC' : 'FIFO';
      draft.lots = [...allocated.value.updatedLots];
      seenExits.add(txnId);

      const allocations = allocated.value.allocations;
      exits.push({
        txnId,
        assetId,
        exitDate: transaction.date,
        // FIFO's oldest consumed lot is the holding period's start.
        ...(allocations[0]?.acquisitionDate === undefined
          ? {}
          : { acquisitionDate: allocations[0].acquisitionDate }),
        quantity: transaction.quantity,
        pricePerUnit: transaction.pricePerUnit,
        fees: Money.zero(transaction.pricePerUnit.currency),
        stt: Money.zero(transaction.pricePerUnit.currency),
        allocations,
        ...(transaction.disposalKind === undefined
          ? {}
          : { disposalKind: transaction.disposalKind }),
        ...(transaction.orderRef === undefined ? {} : { orderRef: transaction.orderRef }),
        ...(transaction.property === undefined ? {} : { property: transaction.property }),
        lotMatching,
      });
      continue;
    }

    if (transaction.kind === 'DIVIDEND') {
      const draft = drafts.get(assetId);
      if (draft === undefined) {
        reject(transaction, 'dividend for a holding that is not in the ledger');
        continue;
      }
      const gross = Money.multiply(transaction.pricePerUnit, transaction.quantity);
      const eventId = `inc_${lotIdFor(transaction).replace('lot_', '')}`;
      if (!draft.income.some((event) => event.eventId === eventId)) {
        draft.income.push({
          eventId,
          assetId,
          kind:
            AssetRegistry.jurisdictionOf(assetClass) === 'FOREIGN'
              ? 'DIVIDEND_FOREIGN'
              : 'DIVIDEND_DOMESTIC',
          date: transaction.date,
          grossAmount: gross,
          taxWithheld: Money.zero(gross.currency),
          netAmount: gross,
          // Withholding is not on the row; claiming credit for tax we cannot see
          // would overstate the relief.
          eligibleForForeignTaxCredit: false,
        });
      }
      continue;
    }

    reject(
      transaction,
      'an account-level fee cannot be attributed to a specific lot; record it manually',
    );
  }

  const assets = [...drafts.values()].map((draft) => ({
    ...draft.asset,
    lots: draft.lots,
    incomeEvents: draft.income,
  }));

  /*
   * The source's claim about what remains, against what the ledger computed.
   *
   * A difference is almost always disposal history that was never imported: the
   * broker says 10 units are left, the ledger still shows 16 because the six
   * sales are in an export nobody loaded. That is the one gap a user cannot find
   * by looking — every figure on screen is internally consistent and wrong — so
   * it is surfaced as a reconciliation note rather than resolved by silently
   * trusting either side.
   */
  for (const asset of assets) {
    for (const lot of asset.lots) {
      const stated = statedRemaining.get(lot.lotId);
      if (stated === undefined) continue;
      if (new Decimal(lot.remainingQuantity).equals(stated.quantity)) continue;

      reconciliation.push({
        row: stated.sourceRow,
        field: 'remainingQuantity',
        stated: stated.quantity,
        computed: lot.remainingQuantity,
      });
    }
  }

  return Ok({ assets, touched, exits, unapplied, reconciliation });
}

/**
 * The acquisition kind a stored LOT must have come from.
 *
 * Read from the lot's own award rather than from its asset class. Once RSU and
 * ESPP folded into FOREIGN_EQUITY, the class no longer says how a tranche was
 * acquired — and one asset can now hold an RSU vest, an ESPP purchase and an
 * ordinary buy side by side, which is the point.
 */
const AWARD_KIND_TO_ACQUISITION: Readonly<
  Partial<Record<EquityAwardKind, ParsedTransaction['kind']>>
> = {
  RSU: 'RSU_VEST',
  RSA: 'RSU_VEST',
  PSU: 'RSU_VEST',
  ESPP: 'ESPP_PURCHASE',
  ESOP: 'ESPP_PURCHASE',
};

/**
 * Every acquisition kind a stored lot could have come from.
 *
 * Usually one: the lot's award says so. But a source that records an RSU release
 * WITHOUT naming a grant — the E*TRADE transaction history does exactly this —
 * leaves a FOREIGN_EQUITY lot with no award at all, and the asset class no longer
 * distinguishes a vest from an ordinary purchase now that equity compensation
 * shares a class with it.
 *
 * Rather than guess, such a lot offers all three keys. Over-offering can only
 * suppress a re-import whose date, symbol, quantity AND price already match an
 * existing lot exactly — which is the duplicate case anyway — while guessing
 * wrong would let the same vest be imported twice.
 */
const acquisitionKindsOf = (lot: AcquisitionLot): readonly ParsedTransaction['kind'][] => {
  if (lot.equityAward !== undefined) {
    return [AWARD_KIND_TO_ACQUISITION[lot.equityAward.kind] ?? 'BUY'];
  }
  return ['BUY', 'RSU_VEST', 'ESPP_PURCHASE'];
};

/**
 * Natural keys for everything already on the ledger, so a re-import recognises
 * its own earlier rows (US-4.7).
 *
 * Reconstructed from stored holdings rather than from a table of imported rows:
 * the ledger is the record, and a separate import journal would be a second
 * source of truth that could disagree with it.
 */
export function ledgerNaturalKeys(
  assets: readonly Asset[],
  exits: readonly ExitTransaction[] = [],
): readonly string[] {
  const keys: string[] = [];
  const identityOf = new Map(
    assets.map((asset) => [asset.assetId, asset.isin ?? asset.symbol ?? asset.folioRef ?? '']),
  );
  /**
   * The acquisition kind a disposal's tranche was opened with, by lot.
   *
   * Per LOT, not per asset: one FOREIGN_EQUITY holding can now carry an RSU
   * vest, an ESPP purchase and an ordinary buy at once, so the asset no longer
   * has a single answer.
   */
  const kindOfLot = new Map(
    assets.flatMap((asset) =>
      asset.lots.map((lot) => [lot.lotId, acquisitionKindsOf(lot)[0] ?? 'BUY'] as const),
    ),
  );

  for (const asset of assets) {
    const identity = asset.isin ?? asset.symbol ?? asset.folioRef ?? '';

    for (const lot of asset.lots) {
      for (const acquisitionKind of acquisitionKindsOf(lot)) {
        keys.push(
          [
            acquisitionKind,
            lot.acquisitionDate,
            identity,
            // The ORIGINAL quantity: `remainingQuantity` shrinks as the holding
            // is sold, and keying on it would make an earlier buy look like a
            // new one the moment any of it was disposed of.
            lot.quantity,
            lot.costPerUnit.amount,
            lot.costPerUnit.currency,
            // The tranche, matching `naturalKey`. See the note there: without
            // it, two vests sold identically on one day collapse into one row.
            lot.equityAward === undefined ? '' : lot.lotId,
          ].join('|'),
        );
      }
    }

    /*
     * Income events are deliberately absent. A stored event keeps only the gross
     * amount — the per-unit price and unit count that formed the natural key are
     * not recoverable from it, so any key built here would be a guess. A guessed
     * key that happens to collide would suppress a genuine second dividend, which
     * understates income; the projection's provenance-derived event id already
     * makes re-importing the SAME file idempotent, which is the case that matters.
     */
  }

  // Disposals. Without these a re-imported statement's sells look new, and FIFO
  // depletes the holding a second time — the ledger then understates the
  // position and overstates realised gains, with nothing to show it happened.
  for (const exit of exits) {
    /*
     * The tranche this disposal came out of, matching `naturalKey`. Only a
     * specific match identifies it: a FIFO allocation says which lot the ledger
     * CHOSE, not which one the source row named.
     */
    const tranche =
      exit.lotMatching === 'SPECIFIC' ? (exit.allocations[0]?.lotId ?? '') : '';

    keys.push(
      [
        'SELL',
        exit.exitDate,
        identityOf.get(exit.assetId) ?? '',
        exit.quantity,
        exit.pricePerUnit.amount,
        exit.pricePerUnit.currency,
        tranche,
      ].join('|'),
    );

    /*
     * The acquisition SLICE that came with this disposal.
     *
     * A Gains & Losses row yields two transactions, and the acquisition half
     * states only the units that row sold. Slices are not summed onto the lot, so
     * the stored lot's quantity is not any slice's quantity and the key built
     * from it above cannot match those rows on a re-import — which made an import
     * that changed nothing still report "created: 2".
     *
     * The disposal remembers what its slice looked like: the tranche it came out
     * of supplies the date and cost, and the disposal itself the quantity. Only
     * for specifically-matched disposals, where that allocation IS the tranche
     * the row named; a FIFO match says nothing about which lot the row meant.
     */
    const allocation = exit.allocations[0];
    if (
      exit.orderRef === undefined ||
      exit.lotMatching !== 'SPECIFIC' ||
      allocation?.acquisitionDate === undefined
    ) {
      continue;
    }
    const acquisitionKind = kindOfLot.get(allocation.lotId);
    if (acquisitionKind === undefined) continue;

    keys.push(
      [
        acquisitionKind,
        allocation.acquisitionDate,
        identityOf.get(exit.assetId) ?? '',
        exit.quantity,
        allocation.costPerUnit.amount,
        allocation.costPerUnit.currency,
        allocation.lotId,
      ].join('|'),
    );
  }

  return keys;
}
