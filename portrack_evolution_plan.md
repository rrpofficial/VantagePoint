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

Ten objectives. Four met, two partial, four unmet.

The dominant finding is not that features are missing — it is that **three
complete, unit-tested engines have no callers**. The advance-tax calculator, the
other-sources income aggregator, and the liability model are all built and
correct. They are handed empty arrays by the use-case layer, or have no write
path at all. The cheapest large win in this codebase is wiring, not building.

| # | Objective | Verdict | Phase |
|---|---|---|---|
| 1 | All assets in one place, with details | 🟡 7 of 25 classes enterable | 5 |
| 2 | Snapshot, and compare across time | 🟡 compare-to-live only | 4 |
| 3 | Assets **and liabilities** in one place | 🔴 no way to create a liability | 3 |
| 4 | Add individual transactions/trades | 🟢 met (same 7-class limit) | 5 |
| 5 | Foreign Assets + HNI filing view | 🟡 Schedule AL works, FA always fails | 6 |
| 6 | Quarterly advance tax | 🔴 engine correct, ledger not connected | 1 |
| 7 | Tax on non-salary income | 🔴 aggregator has zero callers | 2 |
| 8 | Hand loans + interest accrual | 🟢 met | — |
| 9 | Chit fund progress | 🟢 met | — |
| 10 | EMI progress on loans availed | 🔴 not implemented | 3 |

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
- HNI classification uses `profile.value.grossSalary` as total income (`use-cases.ts:383`), and Schedule AL does the same (`use-cases.ts:1891`). Both ignore capital gains and other sources, understating the ₹50L test that decides whether Schedule AL is required at all.

---

## 3. Phased plan

Ordered by objectives recovered per unit of work. Each phase is independently
shippable and leaves the suite green.

### Phase 1 — Connect advance tax to the ledger · objective 6

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

### Phase 2 — Derive income from the ledger · objective 7, part of 5

1. `POST /api/income` — record a dividend or interest receipt, routed through the
   existing `recordDividend` / `recordInterest` in `core-domain/src/income.ts`.
2. New `packages/app-services/src/income-derivation.ts` implementing D-4:
   compose `ManualIncome` + `DerivedIncome` into the existing `IncomeProfile`.
   Call `OtherSourcesAggregator.aggregate` with stored income events plus
   hand-loan accrued interest from `accruals.ts:24`.
3. Fix the total-income basis at `use-cases.ts:383` (HNI) and `use-cases.ts:1891`
   (Schedule AL) to use full derived income, not `grossSalary`.

**Open rule decision — needs your call before coding:** whether accrued-but-unreceived
hand-loan interest is taxable in the year it accrues. For most individual
taxpayers on the accrual basis it is, but this is a tax-position choice, not an
implementation detail, and it changes every figure downstream. It must be an
explicit, recorded setting rather than an assumption buried in a function.

**Acceptance:** hand-loan interest and dividends appear in the advance-tax trace
with their `section56.otherSources` rule reference, and HNI status flips on total
income rather than salary alone.

---

### Phase 3 — Borrowed loans and EMI · objectives 3, 10

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

### Phase 4 — Snapshot comparison across time · objective 2

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

## 4. Sequencing and risk

```
Phase 1 ──┬── Phase 2 ── (HNI / Schedule AL income basis)
          │
E*TRADE ──┘
parser

Phase 3 (independent — largest)
Phase 4 (independent — smallest)
Phase 5 ── Phase 6 (marks store benefits from the valuer registry)
```

Phases 3 and 4 depend on nothing and can run in any order. Phase 2 depends on
Phase 1's wiring being in place. Phase 6 is last by value, not by difficulty.

**Risk register**

| Risk | Phase | Mitigation |
|---|---|---|
| A missing Rule 115 rate silently shrinks an advance-tax instalment | 1 | Surface `unconvertible`; `assertFilingReady` refuses |
| Sign error inverts net worth when sharing loan math | 3 | Keep aggregates separate (D-2); assert net worth direction in tests |
| Migration v10 loses existing `liabilities` rows | 3 | Forward-migrate explicitly; the table is empty in production today, which makes this the cheapest possible moment to change it |
| Peak value computed from closing value | 6 | Keep the loud failure; never approximate |
| Valuer registry changes a net-worth figure | 5 | Golden-value test on the existing fixture before and after |

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

---

## 6. Definition of done

All ten objectives green, and specifically:

- Net worth differs from gross assets when a borrowing exists.
- An advance-tax instalment changes when a trade is recorded.
- Hand-loan interest appears in both net worth **and** taxable income.
- Any two snapshots can be compared, filtered to an asset class.
- A fixed deposit grows without a trade.
- Schedule FA either generates from a real daily series, or refuses — never approximates.
