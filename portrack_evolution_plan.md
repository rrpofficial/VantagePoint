# portTrack — Evolution Plan

> Companion to [`ARCHITECTURE_portrack.md`](./ARCHITECTURE_portrack.md) and
> [`implementation_plan_portrack.md`](./implementation_plan_portrack.md).
> Where those describe what was built, this describes what is missing against the
> ten stated product objectives, and the order in which to close the gap.
>
> Written 2026-09-15 against branch `implment-etrade-g-and-l-statement`
> (`cbac33b`). Every claim below is cited to a file and line.

---

## 0. Executive summary

Ten objectives. **Eight met** after Phases 1-4 (2026-09-15); two remain — asset
coverage (Phase 5) and Schedule FA (Phase 6).

The dominant finding was not that features were missing — it was that **three
complete, unit-tested engines had no callers**. The advance-tax calculator, the
other-sources income aggregator, and the liability model were all built and
correct, and were handed empty arrays by the use-case layer or had no write path
at all. The cheapest large win in this codebase was wiring, not building.

**All three are now connected** (Phases 1-4). The same pattern recurred twice
more while doing it: `ValuationInput.fx` and `ValuationInput.prices` were ports
nothing ever supplied, and `IncomeLedger` had no write path into `income_events`.
When something here looks broken, check first whether it is merely unreachable.

| # | Objective | Verdict | Phase |
|---|---|---|---|
| 1 | All assets in one place, with details | 🟡 7 of 25 classes enterable | 5 |
| 2 | Snapshot, and compare across time | 🟢 met (Phase 4) | 4 |
| 3 | Assets **and liabilities** in one place | 🟢 met (Phase 3) | 3 |
| 4 | Add individual transactions/trades | 🟢 met (same 7-class limit) | 5 |
| 5 | Foreign Assets + HNI filing view | 🟡 Schedule AL works, FA always fails | 6 |
| 6 | Quarterly advance tax | 🟢 met (Phase 1) | 1 |
| 7 | Tax on non-salary income | 🟢 met (Phase 2) | 2 |
| 8 | Hand loans + interest accrual | 🟢 met | — |
| 9 | Chit fund progress | 🟢 met | — |
| 10 | EMI progress on loans availed | 🟢 met (Phase 3) | 3 |

**Added 2026-09-15, outside the original ten:** get the data out — CSV and PDF
exports per register, and a wired, tested vault backup. Hand loans already export
both formats; chits, equity and property export neither, and `Backup` is built
and unwired. See Phase 7.

---

## 1. Does the design need to change?

**Keep the architecture. Change four models inside it.**

The hexagonal layering is the reason this audit was possible at all: the engines
are pure, injected through ports, and independently testable, which is why they
are *correct* despite being unreachable. A rewrite would throw away the part that
works and keep the part that does not. Nothing below requires a new architectural
style, a new persistence engine, or a change to the vault, egress or container
model.

### 1.1 What must change

#### D-1 — `Liability` is a balance snapshot; it must become an obligation

```ts
// packages/core-domain/src/types.ts:189-195
export interface Liability {
  readonly liabilityId: string;
  readonly kind: 'HOME_LOAN' | 'PERSONAL_LOAN' | 'MORTGAGE' | 'OTHER';
  readonly principalOutstanding: Money;
  readonly interestRatePct: Percentage;
  readonly asOf: IsoDate;
}
```

There is no tenure, no EMI amount, no start date, no payment history. Objective
10 — "track the EMI progress" — is not expressible against this type. Progress
requires a schedule to measure against.

Note the irony worth recording: **ADR-009 says "Liabilities are first-class,"
realised in `core-domain.Liability`.** The type exists, `valuation.ts:199-211`
subtracts it, and `Dashboard.tsx` renders it — but `LiabilityRepository.save`
(`packages/persistence/src/asset-repository.ts:834`) is called from exactly one
place in the repository, `packages/persistence/test/asset-repository.spec.ts`.
There is no route, no use case, no form. In production the table is always empty,
so **net worth is always identical to gross assets**. ADR-009 was decided and
never honoured.

#### D-2 — Share the amortisation math between loans given and loans taken; do **not** merge the aggregates

A hand loan given (`AssetClass = 'HAND_LOAN'`, with a `handLoan?` bag on `Asset`)
and a home loan taken are the same arithmetic — reducing balance, accrual,
payment history, prepayment — pointing in opposite directions.

The temptation is to unify them into one "Loan" aggregate with a direction flag.
**Do not.** A receivable is an asset and a borrowing is a liability; they land on
opposite sides of net worth and in different Schedule AL sections
(`packages/compliance/src/schedule-al.ts`). A single aggregate with a sign flag
puts one sign error between a correct net worth and a silently inverted one.

Extract instead a pure `packages/core-domain/src/amortisation.ts` — schedule
generation, outstanding-as-of, interest/principal split — and have both
aggregates call it. Share the math, not the identity.

#### D-3 — The valuation dispatch chain is closed against new asset kinds

```ts
// packages/core-domain/src/valuation.ts:139-166
if (asset.assetClass === 'HAND_LOAN' && asset.handLoan && describesEveryLot(asset)) {
  …
} else if (asset.assetClass === 'CHIT_FUND' && asset.chitFund) {
  …
} else {
  … market value, else cost basis
}
```

Each new non-traded asset kind adds a branch here *and* an optional bag on
`Asset` (`handLoan?`, `chitFund?`, `schemeCategory?` …). Phase 5 adds fixed
deposits, recurring deposits, EPF/VPF/PPF and gratuity — four more branches and
four more optional fields, in a function every net-worth figure passes through.

Replace with a registry: `Record<AssetClass, Valuer>`, defaulting to the existing
market-value-else-cost valuer. Mechanical, low-risk, and it makes the
already-written accrual functions (§2.5) pluggable rather than another `else if`.

#### D-4 — `IncomeProfile` is an input; objectives 6 and 7 require it to be an output

```ts
// packages/tax-engine/src/types.ts
export interface IncomeProfile {
  readonly grossSalary: Money;
  …
  readonly otherSourcesIncome: Money;   // ← typed by hand today
  readonly tdsRemitted: Money;
}
```

Objective 6 says advance tax should "use the assets, liabilities and trades
data"; objective 7 says income tax on non-salary income. Both mean income
*derived from the ledger*. The current type treats every figure as user input.

Do not change `IncomeProfile` — the tax engine consumes it correctly and should
stay untouched. Introduce a composition layer above it:

```
ManualIncome   (salary, Chapter VI-A, TDS — genuinely user-supplied)
     +
DerivedIncome  (dividends, deposit interest, hand-loan accrual — from the ledger)
     ↓
IncomeProfile  (what the engine already eats)
```

This keeps the pure engine pure and puts the derivation in `app-services`, where
the ports already are.

### 1.2 What must **not** change

- **Hexagonal layering, pure domain core** (ADR-001) — the reason the engines are salvageable.
- **`Decimal`/`Money` strings, never floats** (ADR-002).
- **Dual FX rate** (ADR-003) — already correct for Rule 115; Phase 1 depends on it.
- **FY-keyed rule data, no rate literals in code** (ADR-005).
- **Immutable content-addressed snapshots** (ADR-006).
- **Vault, egress, PII and container model** (ADR-010 through ADR-015) — untouched by every phase below.

### 1.3 New concept required

**A daily marks store.** Schedule FA Table A3 needs a peak value across the
calendar year, which needs a daily price and FX series. Nothing records one, and
`GenerateComplianceUC.scheduleFaA3` fails loudly rather than understating a
foreign disclosure (`use-cases.ts:1844-1856`) — the right call, but it leaves
objective 5 half-unmet.

The `fx_rates` table (migration v8) is the precedent: rate-keyed, decimal string,
provenance column. Generalise the same shape to `daily_marks`. This is the only
genuinely new structural concept in the plan.

---

## 2. Verified findings

Current schema version is **8**; new migrations begin at **9**.

### 2.1 Advance tax never sees a trade — objective 6

```ts
// packages/app-services/src/use-cases.ts:352-360
AdvanceTaxEngine.installment({
  financialYear: input.financialYear,
  quarter: input.quarter,
  income: profile.value,
  exits: [],                                      // every realised gain, discarded
  assetClasses: {},                               // holding periods unresolvable
  alreadyPaid: { amount: '0', currency: 'INR' },  // never credited
  rules: rules.value,
})
```

`packages/tax-engine/src/advance-tax.ts` correctly implements the cumulative
15/45/75/100% instalments and filters exits by the quarter's due date. It is
handed nothing to filter.

### 2.2 The other-sources aggregator has no callers — objective 7

`OtherSourcesAggregator` is exported at `packages/tax-engine/src/index.ts:34` and
referenced nowhere outside tests. `IncomeEvent` is modelled
(`core-domain/src/income.ts`), persisted (`asset-repository.ts:228`), and read
into the ledger — but there is **no `/api/income` route** to record one, and no
path from a stored income event to a tax figure.

Consequence: hand-loan interest accrues into net worth
(`valuation.ts:139-149`) and is invisible to objective 7.

### 2.3 Liabilities cannot be created — objectives 3, 10

No `/api/liabilities` route exists (verified: zero matches in
`apps/api/src/routes/index.ts`). The only `emis` table in the schema is
`chit_emis` (`migrations.ts:288`), which is chit instalments, not loan EMIs. No
amortisation code exists anywhere in the repository.

### 2.4 Snapshot comparison is half-exposed — objective 2

`snapshotToSnapshot` works in the API
(`apps/api/src/routes/index.ts`, `/api/snapshots/:id/compare?target=`) and in the
use case. `apps/web/src/api.ts:725` exposes only `compareToLive`, so the UI can
never reach it.

Separately, "a given class of assets" is not supported at all:
`SnapshotScope = 'DOMESTIC' | 'FOREIGN' | 'ALL'` is a *jurisdiction*, and custom
snapshots hardcode `scope: 'ALL'` (`use-cases.ts:221`).

### 2.5 Asset coverage and dormant accrual code — objectives 1, 4

`MANUAL_TRADE_CLASSES` (`use-cases.ts:868-876`) covers 7 of the 25 classes in the
taxonomy. EPF, VPF, PPF, NPS I/II, FD, RD, gold (physical/digital), crypto,
cash and bank balance have **no entry form and no import template** — only six
templates exist (`packages/ingestion/src/templates.ts`).

Worse: `packages/core-domain/src/accruals.ts` already implements
`depositAccruedValue` (:70), `recurringContributions` (:90), `epfProjection`
(:110) and `gratuity` (:148). **None has a non-test caller.** A fixed deposit, if
one could be entered, would sit at cost forever.

### 2.6 Schedule FA and the income basis — objective 5

- `scheduleFaA3` returns `Err` unconditionally (`use-cases.ts:1844-1856`).
- `scheduleFaD` passes `accounts: []` (`use-cases.ts:1871`) — foreign bank and custodial accounts are not modelled.
- ~~HNI classification uses `profile.value.grossSalary` as total income (`use-cases.ts:383`), and Schedule AL does the same (`use-cases.ts:1891`). Both ignore capital gains and other sources, understating the ₹50L test that decides whether Schedule AL is required at all.~~ **Fixed 2026-09-15.** `totalIncomeFor` (`use-cases.ts:431`) sums salary, house property, other sources and the FY's realised capital gains from the ledger, and both call sites use it. Pinned by `tests/functional/tax/hni-total-income.spec.ts`. The remainder — dividend and interest *derived* from the ledger rather than typed into the profile — is still Phase 2.

---

## 3. Phased plan

Ordered by objectives recovered per unit of work. Each phase is independently
shippable and leaves the suite green.

### Scoping decision — what advance tax is *for* (2026-09-15)

**Only income the employer is not already withholding on.**

Salary, and the RSU/ESPP perquisite inside it, are covered by the employer's own
TDS and appear on Form 16. portTrack computes the gap: capital gains on
disposals, and other income outside salary.

This is why the vest perquisite is deliberately **not** imported, even though
`ByStatus → Unvested` states it per vest with the Indian rate and tax withheld.
Form 16's gross salary already includes it; importing it separately would tax the
same money twice.

Salary is still an *input* — not to charge it, but to place everything else:
capital gains sit at their own rates, but surcharge bands turn on total income,
and slab-taxed income stacks on top of salary. The engine then credits
`tdsRemitted + tcsCollected + alreadyPaid`, so net payable is by construction the
part the employer is not covering.

### Phase 1 — Connect advance tax to the ledger · objective 6 — ✅ DONE

Delivered 2026-09-15. `ComputeAdvanceTaxUC.execute` now reads real disposals
filtered to the financial year, asset classes keyed per transaction, and
`alreadyPaid` from a new `advance_tax_payments` table (migration v13). Recording
a challan is ungated; deleting one is gated, because removing a payment RAISES
every later instalment. Unconvertible gains and excluded sell-to-cover
disposals are surfaced beside the figure rather than silently shrinking it.

The steps below are kept as the record of what was built.



**Smallest change, largest objective recovered.** The engine is already correct.

1. In `ComputeAdvanceTaxUC.execute`, replace the three literals at
   `use-cases.ts:356-358`:
   - `exits` ← `ExitRepository.all()`, filtered to the financial year.
   - `assetClasses` ← built from `AssetRepository.all()`, so holding periods classify.
   - `alreadyPaid` ← a new `advance_tax_payments` table (**migration v9**: `financial_year`, `quarter`, `amount TEXT`, `paid_on`, `challan_ref`).
2. Add `POST /api/tax/advance/payments` and a small form in `Tax.tsx` to record a
   challan.
3. **Surface `capitalGains.unconvertible` in the UI.** Non-empty means the totals
   are incomplete — a missing Rule 115 month-end rate now silently *shrinks* an
   instalment. `CapitalGainsResult.unconvertible` already carries the reason;
   the screen must show it beside the figure, and `assertFilingReady` must refuse.

**Prerequisite (parallel track):** the E*TRADE G&L Expanded CSV parser, still
pending from the FX work. Without it there are few realistic foreign exits to
exercise this against.

**Acceptance:** record a sale, recompute Q2 — the instalment moves. A disposal
with no resolvable month-end rate appears as a named warning, never as a silently
smaller number.

---

### Phase 2 — Derive income from the ledger · objective 7, part of 5 — ✅ DONE

1. `POST /api/income` — record a dividend or interest receipt, routed through the
   existing `recordDividend` / `recordInterest` in `core-domain/src/income.ts`.
2. New `packages/app-services/src/income-derivation.ts` implementing D-4:
   compose `ManualIncome` + `DerivedIncome` into the existing `IncomeProfile`.
   Call `OtherSourcesAggregator.aggregate` with stored income events plus
   hand-loan accrued interest from `accruals.ts:24`.
3. ~~Fix the total-income basis at `use-cases.ts:383` (HNI) and `use-cases.ts:1891`
   (Schedule AL) to use full derived income, not `grossSalary`.~~ **Done ahead of
   this phase** — `totalIncomeFor` already composes the four heads the profile and
   ledger can supply. What remains for this phase is widening what feeds it:
   once `income-derivation.ts` exists, the `otherSourcesIncome` term stops being a
   typed-in number and becomes a derived one, and `totalIncomeFor` picks that up
   without changing.

**Open rule decision — needs your call before coding:** whether accrued-but-unreceived
hand-loan interest is taxable in the year it accrues. For most individual
taxpayers on the accrual basis it is, but this is a tax-position choice, not an
implementation detail, and it changes every figure downstream. It must be an
explicit, recorded setting rather than an assumption buried in a function.

**Acceptance:** hand-loan interest and dividends appear in the advance-tax trace
with their `section56.otherSources` rule reference, and HNI status flips on total
income rather than salary alone.

---

### Phase 3 — Borrowed loans and EMI · objectives 3, 10 — ✅ DONE

The largest phase. Build it behind the same register shape as `Loans.tsx`, which
already solves filtering, sorting and totals for the mirror-image problem.

1. **Domain** — `packages/core-domain/src/amortisation.ts` (D-2): reducing-balance
   schedule, `outstandingAsOf`, per-instalment interest/principal split,
   prepayment handling, progress percentage. Pure, no I/O.
2. **Model** — replace the `Liability` type (D-1) with `BorrowedLoan`: principal,
   rate, tenure months, EMI amount, start date, `payments[]`, `prepayments[]`,
   lender ref. Keep the old fields as derived getters so `valuation.ts:199-211`
   and `schedule-al.ts` need no change.
3. **Persistence** — **migration v10**: `borrowed_loans` + `borrowed_loan_payments`,
   migrating any existing `liabilities` rows forward.
4. **Services** — `LiabilityUC` with `record`, `register`, `recordPayment`,
   `close`. Gate mutations through `requireEditMode` exactly as loans and chits do.
5. **API** — `GET/POST /api/liabilities`, `POST /api/liabilities/:id/payments`.
6. **UI** — a `Liabilities` tab. It belongs beside Assets in the top nav, **not**
   under it: a borrowing is not an asset, and filing it under an Assets sub-nav
   is the same category error §1.1 warns about. Show schedule, paid-to-date,
   outstanding, interest-vs-principal split, and progress against tenure.
7. Refactor the hand-loan accrual to call the shared `amortisation.ts`.

**Acceptance:** record a 20-year home loan and six EMIs; net worth drops by the
outstanding principal, the Dashboard liabilities card renders for the first time
in production, and the schedule shows the interest/principal crossover.

---

### Phase 4 — Snapshot comparison across time · objective 2 — ✅ DONE

1. Add `compareSnapshots(a, b)` to `apps/web/src/api.ts` — the API and use case
   already exist; this is one method and a second selector in `Snapshots.tsx`.
2. Asset-class scoping. Two options:
   - **Cheap:** a client-side bucket filter over the variance table, reusing
     `bucketOf` from `core-domain/src/asset-bucket.ts`. No schema change.
   - **Correct:** widen `SnapshotScope` beyond jurisdiction and accept a scope on
     `GenerateSnapshotUC.custom` (`use-cases.ts:221`), so a class-scoped snapshot
     is itself frozen and content-addressed.

   **Recommendation: start cheap.** "Compare the equity sleeve across two dates"
   is a *reading* of a full snapshot, not a different snapshot. Only widen the
   scope type if you need a frozen, hash-verifiable class-scoped artifact — and
   note that doing so multiplies the snapshot-per-date count, which ADR-006's
   immutability guarantees then apply to individually.

**Acceptance:** pick any two snapshots and see the delta; filter that delta to
Equity alone.

---

### Phase 5 — Balance-type assets and live accruals · objectives 1, 4

1. Implement the valuer registry (D-3) in `valuation.ts`.
2. Register valuers that call the already-written `depositAccruedValue`,
   `recurringContributions`, `epfProjection` and `gratuity` (§2.5).
3. A **balance entry form**, distinct from `TradeForm.tsx` — an FD is a balance
   with a rate and maturity, not a quantity at a price. Forcing it through the
   trade shape is what produced the dormant-accrual situation in the first place.
   Covers FD, RD, EPF, VPF, PPF, NPS I/II, gold, crypto, cash, bank balance.
4. Import templates for the same classes.

**Acceptance:** enter a fixed deposit; its value grows between two valuations
without any trade being recorded.

---

### Phase 6 — Schedule FA · objective 5

Lowest urgency unless foreign assets are held in the current disclosure year.

1. **Migration v11** — `daily_marks` (§1.3), following the `fx_rates` shape:
   asset or currency key, date, decimal-string value, source, provenance ref.
2. Backfill from the bundled SBI archive for FX; record a daily close for foreign
   holdings going forward.
3. Enable `scheduleFaA3` once a full calendar-year series exists — and keep the
   loud failure whenever it does not. **Never compute peak value from a closing
   value.** Under the Black Money Act an understated foreign disclosure is
   treated far more harshly than an understated domestic one; the existing error
   at `use-cases.ts:1844-1856` is the correct behaviour and must survive this phase.
4. Model foreign bank and custodial accounts so `scheduleFaD` has something to
   disclose beyond `accounts: []`.

**Acceptance:** with a full year of marks, Table A3 generates and its peak value
exceeds the 31-Dec closing value. With a gap, it still refuses.

---

### Phase 7 — Export and backup · requested 2026-09-15

Get the data OUT: as CSV and PDF per asset register, and as a restorable backup
of the whole vault.

Two different needs that are easy to conflate, and must not be:

- **Export** is a readable extract of one register — hand loans, chits, equity,
  property — for a CA, a bank, a family member, or a spreadsheet. It is
  *lossy and human-facing* by design.
- **Backup** is a byte-exact, restorable copy of the vault. It is *complete and
  machine-facing*, and it stays encrypted.

An export is not a backup. A CSV of holdings cannot reconstruct a vault — it has
no lots, no provenance, no rates, no disposals — and offering one under a
"Backup" label would be the kind of mistake a user discovers only when they have
lost the original.

#### 7.1 Where this already stands

| Register | CSV | PDF | Notes |
|---|---|---|---|
| Hand loans | ✅ | ✅ | `LoanExporter` (`core-domain/src/loan-export.ts`), routes `/api/loans/export.csv` and `.pdf`, links in `Loans.tsx:300-303`. **Filter-aware** — it exports what the screen is showing. |
| Chits | ❌ | ❌ | Nothing. |
| Equity / holdings | ❌ | ❌ | Nothing. |
| Immovable property | ❌ | ❌ | Nothing. |
| Whole-vault backup | ⚠️ | — | `Backup` exists in `packages/persistence/src/backup.ts` and correctly archives the KDF metadata alongside the database — **but no use case, route or button reaches it.** Same defect class as the `prices` and `fx` ports: built, correct, unwired. |

The hand-loan exporter is the template to follow, not a thing to generalise
prematurely. It already solves the parts that are easy to get wrong: Indian digit
grouping, decimal-string money that never becomes a float, pagination, and a
generated-on stamp.

#### 7.2 What to build

1. **Wire `Backup`.** A `BackupUC` plus `POST /api/vault/backup` and a Settings
   button. The archive must keep carrying `vault.db.meta.json` — a backup of the
   database alone restores to a vault nobody can open, and that failure surfaces
   only when the backup is needed. Add a **restore** path and a functional test
   that round-trips backup → fresh directory → unlock → same figures; an untested
   restore is not a backup.
2. **Chit register export**, CSV and PDF: scheme, organisation, status, start and
   end, instalments paid to date, agreed withdrawal where a schedule covers it.
   Filter-aware like the loan one, so it exports what the screen shows.
3. **Equity / holdings export**, CSV and PDF: per holding and per LOT — a
   holdings summary without lots cannot support a capital-gains conversation,
   which is most of why it would be exported. Include acquisition date, quantity,
   cost per unit, charges, source currency **and** the INR figure with the rate
   used, plus realised disposals for the selected FY.
4. **Property export**, CSV and PDF, now that the schema carries the detail:
   area and unit, rate, consideration, each duty separately, total tax, and the
   current value with its basis and date.
5. **One export surface**, not four ad-hoc ones. A shared
   `packages/exporters` (or a widened `loan-export.ts`) owning the CSV quoting,
   the PDF table layout and the money formatting, with each register supplying
   columns and rows.

#### 7.3 Constraints this must respect

- **PII (ADR-013).** A borrower's name and a property's street address are in the
  vault in the clear and are replaced by `brw_…` / `addr_…` in anything that
  leaves. An export is a file the user will email. Decide per register, and make
  it an explicit, visible choice at export time — **not a default that leaks.**
  The existing loan CSV is the precedent to check first.
- **ADR-002.** Money stays a decimal string all the way to the byte. A CSV cell
  that went through a float is a corrupted figure that still looks fine.
- **ADR-010.** No egress. These are downloads from the local API; nothing is
  uploaded anywhere, and no export path may acquire a network call.
- **Provisional rates.** Any export carrying a TAX figure must inherit
  `assertFilingReady` — a PDF that looks like a filing document and rests on a
  provisional rule set is exactly the artifact that gate exists to prevent. A
  holdings or register export carries no tax figure and is unaffected.
- **A PDF is a record.** Stamp every one with the generated-on date and the
  vault it came from, as the loan PDF already does.

**Acceptance:** each of loans, chits, equity and property exports to CSV and PDF
from its own tab, carrying the filters on screen; a backup taken from Settings
restores into an empty directory and unlocks with the same passphrase to the same
net worth; and no export of a tax figure is producible from a PROVISIONAL year.

**Open question for the user:** should exports mask PII by default and offer to
include it, or include it by default and offer to mask it? The answer differs by
audience — a CA needs the borrower's name, a spreadsheet for analysis does not.

---

## 4. Sequencing and risk

```
Phase 1 ──┬── Phase 2 ── (HNI / Schedule AL income basis)
          │
E*TRADE ──┘
parser

Phase 3 (independent — largest)
Phase 4 (independent — smallest)
Phase 5 ── Phase 6 (marks store benefits from the valuer registry)

Phase 7 (independent — exports read what exists; backup depends on nothing)
```

Phases 3 and 4 depend on nothing and can run in any order. Phase 2 depends on
Phase 1's wiring being in place. Phase 6 is last by value, not by difficulty.

Phase 7 depends on no other phase: each exporter reads a register that already
exists, and every later phase simply gives it more to export. Its **backup half
is the one piece of this plan that protects against total loss**, and is worth
pulling forward out of order — it is small, and a vault with no tested restore
path is one disk failure from zero.

**Risk register**

| Risk | Phase | Mitigation |
|---|---|---|
| A missing Rule 115 rate silently shrinks an advance-tax instalment | 1 | Surface `unconvertible`; `assertFilingReady` refuses |
| Sign error inverts net worth when sharing loan math | 3 | Keep aggregates separate (D-2); assert net worth direction in tests |
| Migration v10 loses existing `liabilities` rows | 3 | Forward-migrate explicitly; the table is empty in production today, which makes this the cheapest possible moment to change it |
| Peak value computed from closing value | 6 | Keep the loud failure; never approximate |
| Valuer registry changes a net-worth figure | 5 | Golden-value test on the existing fixture before and after |
| A backup restores to a vault nobody can open | 7 | Archive the KDF metadata with the database — `backup.ts` already does; pin it with a round-trip restore test, because an untested restore is not a backup |
| An export leaks a borrower's name or a street address into a file the user emails | 7 | Masking is an explicit choice at export time, never a silent default (ADR-013) |
| A CSV cell round-trips through a float | 7 | Decimal strings to the byte (ADR-002); no `Number()` in an exporter |

**Standing constraint:** no fabricated exchange rates, ever. Every rate that
reaches a tax figure carries its own source document reference — the discipline
`packages/fx-itbr/src/sbi-archive.ts` already enforces. A plausible invented
figure flowing into a filing is the worst failure mode available in this codebase.

---

## 5. Open questions

1. **Accrual basis for hand-loan interest** (Phase 2) — taxable when it accrues,
   or when it is received? Blocks Phase 2's derivation; changes every downstream
   figure.
2. **Rate verification** (carried over from the FX work, still unanswered) —
   should the ~81 month-end rates that drive tax figures be marked `verified`
   against SBI's own PDFs, with `assertFilingReady` refusing until they are?
3. **Class-scoped snapshots** (Phase 4) — a filtered reading, or a frozen
   artifact of its own? §3 Phase 4 recommends the former.
4. **Liabilities placement** (Phase 3) — top-level tab, as recommended, or a
   sub-tab under Assets?
5. **Export masking default** (Phase 7) — should an export mask the borrower name
   and the property address by default and offer to include them, or the reverse?
   A CA needs the names; a spreadsheet for analysis does not, and it is the file
   most likely to be emailed.

---

## 6. Definition of done

All ten objectives green, and specifically:

- Net worth differs from gross assets when a borrowing exists.
- An advance-tax instalment changes when a trade is recorded.
- Hand-loan interest appears in both net worth **and** taxable income.
- Any two snapshots can be compared, filtered to an asset class.
- A fixed deposit grows without a trade.
- Schedule FA either generates from a real daily series, or refuses — never approximates.
- Every register — loans, chits, equity, property — exports to CSV and PDF from
  its own tab, carrying the filters on screen.
- A backup taken from Settings restores into an empty directory, unlocks with the
  same passphrase, and reports the same net worth. **Tested, not assumed.**

---

## 7. Deferred — to be addressed at the end

### Opening-balance lots

For holdings whose acquisition history genuinely cannot be recovered — shares
vested years ago whose statements no longer exist, or bought through an account
that has since closed.

Record an opening lot with a user-supplied acquisition date and cost, stored
flagged as **estimated**, so every tax figure derived from it carries that flag
through to `assertFilingReady`. That is the standard accounting answer to
unrecoverable history: state the estimate, mark it, and never let it masquerade
as a measured figure.

**Currently moot.** After importing four years of Gains & Losses exports plus the
holdings export, reconciliation stands at **0 discrepancies across 30 tranches,
0 unaccounted units** — there is no gap for an opening balance to fill. The 29
units that once looked unrecoverable turned out to be a duplicate-detection
defect, not missing paperwork.

It becomes necessary the moment a broker is added whose history does not go back
far enough, so it stays on the list rather than being dropped. Nothing depends on
it, which is why it sits last.

### The rebate is not modelled at all — s.156(2) / s.87A

Found 2026-09-15 while sourcing FY 2026-27 from the enacted Finance Act 2026.
`TaxRuleSet` has **no rebate field**, and nothing in `packages/tax-engine`
mentions one: `grep -rn "rebate\|87A" packages/tax-engine/` returns nothing.

Income-tax Act 2025 **s.156(2)(a)** allows a deduction of the whole tax, or
₹60,000, whichever is less, where total income does not exceed ₹12,00,000. So a
default-regime taxpayer under ₹12 lakh owes **nil**, and this engine computes
slab tax for them regardless. The 1961 Act's s.87A does the same job for earlier
years.

The error direction is safe — tax is OVERSTATED, so an advance-tax instalment is
never under-demanded — but it is wrong, and wrong by the entire liability for
anyone below the threshold.

**Two things make this more than a missing constant:**

1. The rebate is **not available against income taxed at special rates**. Capital
   gains under s.196/197/198 are outside it, so the rebate applies to the slab
   part of the liability only. A naive `min(tax, 60000)` would wipe out capital
   gains tax for a taxpayer whose salary is small and whose gains are large —
   exactly this app's user.
2. It is **year-specific and regime-specific**, so it belongs in the FY rule set
   beside `standardDeduction`, not in the calculator.

Shape: `rebate?: { limit: Money; maxAmount: Money; appliesToSpecialRates: false }`
on `TaxRuleSet`, applied in `SlabCalculator` after slab tax and before surcharge,
against the slab component only.

### Correct the FY 2024-25 rule set — parked

**Deprioritised 2026-09-15 at the user's direction: past-year advance tax is not
a current concern.** Nothing here is pending work. It is written down because the
year is still offered in the picker and someone will eventually compute with it —
and because the defect below is not obvious from reading the file.

The year is safe as it stands: `status: 'PROVISIONAL'` keeps `assertFilingReady`
refusing it, and its `provisionalNote` states the specific defect, so the banner
says what is wrong rather than warning generically.

FY 2025-26 was verified on
2026-09-15 against the Finance Bill 2026 First Schedule Part I-A (clause 2(1)
charges AY 2026-27, which is FY 2025-26). FY 2026-27 is provisional by design,
sourced from Bills awaiting enactment. FY 2024-25 is neither — it is wrong:

- `slabs.NEW_REGIME` is byte-for-byte FY 2025-26's table. It begins at the
  ₹4,00,000 exemption that Finance Bill 2026 clause 2(2) Table Sl. No. 4 assigns
  to AY 2026-27, so it is that year's schedule carried back. An income of ₹12L is
  taxed under bands that did not exist in FY 2024-25.
- `standardDeduction.NEW_REGIME` is ₹50,000 here against ₹75,000 in FY 2025-26,
  and the increase is understood to have taken effect in AY 2025-26 — this year.
- Capital gains rates changed **mid-year, on 23 July 2024**. `ltcgRatePct`,
  `stcgListedEquityRatePct` and `ltcgExemptionLimit` are single values, so one
  half of the year is wrong whichever is stored. This one is a type problem, not
  a data problem: `TaxRuleSet` cannot express a rate that changes on a date
  inside the year.

**To close it:** the First Schedule to the **Finance (No. 2) Act, 2024**, plus
s.115BAC(1A), s.16(ia), s.111A and s.112A as amended by it. Then correct the
table, settle the deduction, decide how the 23 July split is represented, and set
`status: 'VERIFIED'`.

Until then the year stays PROVISIONAL and `assertFilingReady` refuses it, which
is correct. Its `provisionalNote` names the specific defect, so the banner tells
the user what is wrong rather than warning generically.

### Regime-aware surcharge bands

`TaxRuleSet.surchargeBands` is a single array, but the two regimes genuinely
differ above ₹5 crore: the **default** regime (s.115BAC / s.202 of the 2025 Act)
caps at 25%, while the **opt-out** ("old") regime reaches 37% under Paragraph A
of the First Schedule. One array cannot express both.

Every year's file therefore states the default-regime bands, because that is the
regime that applies unless the taxpayer elects otherwise — so FY 2024-25,
FY 2025-26 and FY 2026-27 all correctly carry **three** bands (10/15/25),
confirmed for FY 2025-26 against Finance Bill 2026 clause 2(4)(b) Sl. No. 10. The
consequence is narrow and worth stating plainly: a taxpayer who **opts out** and
has total income **above ₹5 crore** is understated by twelve percentage points of
surcharge. Below ₹5 crore, or on the default regime, the figures are right.

The fix is a type change — `surchargeBands: { OLD_REGIME: [...], NEW_REGIME: [...] }`,
mirroring how `slabs` and `standardDeduction` are already keyed — plus threading
the regime into `SlabCalculator`'s surcharge step and `RegimeComparison`. It is
deferred rather than done because it touches every rule file and the comparison
engine, for a case (opt-out regime, ₹5 crore-plus) that does not currently arise.

**Do not "fix" this by adding a 37% band to a year's array.** That was tried on
FY 2026-27 and was wrong: clause 3(4)(a)(ii) of the Finance Bill 2026 excludes
s.202 taxpayers from Paragraph F, and the Table at clause 3(4)(b) Sl. No. 10 gives
them three bands. Adding the fourth overstates the default regime — the common
case — to fix the rare one.
