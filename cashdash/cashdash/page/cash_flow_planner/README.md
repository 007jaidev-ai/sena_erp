# Cash Flow Planner — Handoff & Reference

A working manual for the **Cash Flow Planner** Desk page (`cashdash` app). Written
for two readers:

- **Senior dev** picking this up cold — the state model, invariants, endpoints, and
  every permutation that matters.
- **End user / power user (Accounts)** — what each control does and what each
  badge/tag means.

> TL;DR of the moving parts: bills become **blocks** you arrange on a **timeline**.
> Money is **integer paise** end to end. You edit a **private draft**; **Publish**
> promotes it to the **shared board**. Credit terms are **best-effort** and
> **editable** with provenance. Partial payments **split** a bill into conserved
> pieces. Every block carries a **provenance tag** (you / planned / auto / paid).

---

## 0. Files & where things live

| File | Role |
|---|---|
| `cash_flow_planner.js` | All UI + client state machine (vanilla JS + jQuery). |
| `cash_flow_planner.py` | Whitelisted endpoints + persistence (drafts/shared, file hardening). |
| `cash_flow_planner.css` | Styling, incl. tag/badge classes. |
| `cash_flow_planner.html` | Page shell (`#cfp-root`, `#cfp-app`). |
| `cash_flow_planner.json` | Frappe Page doctype definition. |
| `test_cash_flow_planner.py` | Backend unit tests (data load, partial-save guards, concurrency). |
| `../../data/tally_bills.json` | Committed extract of real outstanding bills (source of truth for bills). |
| `../../importer/import_tally_bills.py` | Regenerates `tally_bills.json` from a Tally export sqlite (not committed). |

Runtime data (NOT in git, under `sites/<site>/private/files/`):

| File | Role |
|---|---|
| `cash_flow_planner_data.json` | **Shared board** (published, has a `rev`). Also holds the global named-plan library. |
| `cash_flow_planner_draft__<user>.json` | **Per-user private draft** (has a `base_rev`). |
| `*.lock` | flock sidecar files for serialized writes. |

This is a **Desk Page** — its JS/CSS load directly (no esbuild bundle). A browser
reload of the page picks up changes (run `bench clear-cache` if stale).

---

## 1. Mental model

```
 tally_bills.json ──server──> invoices ──toBlock()──> BLOCKS
                                                        │
   ┌───────────────── RESERVOIR (sides) ───────────────┴──── TIMELINE ────────────┐
   │  Payables (left)         Receivables (right)        Year → Month → Week grid  │
   │  • Upcoming (unscheduled)                           columns carry net/Σ/short │
   │  • Scheduled (placed, greyed)   ── drag ──>         a block lives on a DATE    │
   └──────────────────────────────────────────────────────────────────────────────┘
                                                        │
                              Credit terms LEDGER (bottom, editable terms)
```

- A **block** is one obligation (a bill) or a **split piece** of one, or a seeded
  **bank-facility** line.
- **Unscheduled** blocks sit in the side **reservoir**; **placed** blocks sit on the
  **timeline** at a `placedDate`. Dragging moves a block between the two.
- Money flows: **payables are negative** (cash out), **receivables positive** (cash
  in). Facility **draw is +**, **repayment −**.
- You always edit **your private draft**. **Publish** makes it the shared board.

---

## 2. Money is INTEGER PAISE (the most important invariant)

**Rule:** every monetary value in memory and in transit is a **signed integer number
of paise** (₹1 = 100 paise). Floats appear *only* at the display edge and the
lakhs toolbar input.

| Where | Unit | Notes |
|---|---|---|
| `b.amountP`, `b.orderValueP` | signed paise | pay = negative, rec = positive |
| `this.openingP` | paise | opening cash on hand |
| Column sums (`inflow/outflow/net/Σ`), KPIs, `balanceAt`, `minBalanceInRange` | paise | exact integer sums — **no float drift** |
| `familyCeil[root]` (split ceiling) | paise | conservation is an exact `===` check |
| `CC_LIMIT`, `BD_LIMIT`, `HIGH_VALUE_P` | paise | ₹6Cr / ₹4Cr / ₹5L |
| `tally_bills.json` `value_paise`, `outstanding_paise` | int paise | server source |
| `fmtShort(p)` | **paise in → rupee string out** | the *only* paise→rupee conversion for display |
| Toolbar "Opening cash" field | **lakhs (float)** | display/entry only; 1 lakh = 1e5 rupees = **1e7 paise** |
| `opening_balance_paise` in the config file | **int paise** | canonical persisted opening cash (legacy `opening_balance` lakhs is auto-migrated on load) |

**Why:** summing many float rupees drifts (e.g. `100 × ₹0.10 = 9.99999…`). Integer
paise can never lose or invent a paisa across a long chain of edits and sums.

**Server boundary:** `_coerce_paise()` tolerates a legacy data file that still has
float `value`/`outstanding`. The CSV export renders paise back to 2-dp rupees.

**Gotcha:** the toolbar input is **lakhs**, not rupees. `80` means ₹80,00,000.
Entering rupees by mistake (e.g. `8000000`) triggers a heads-up toast but still
applies.

---

## 3. The block object (state reference)

Produced by `toBlock()` (bills), `addFacilityBlocks()` (facilities), and the split
functions (pieces). Key fields:

| Field | Meaning |
|---|---|
| `id` | invoice name (`TLY-P-00001`) or split-piece id (`<root>#<n>`) |
| `root`, `splitFrom` | split family root id; the sibling a piece was carved from |
| `side` | `'pay'` \| `'rec'` |
| `type` | `'PAY'` \| `'REC'` \| facility code (`'CC'`/`'BD'`) |
| `amountP` | signed paise (pay −, rec +) |
| `orderValueP` | original order value, paise |
| `due`, `billDate` | Dates (effective due = post-term-override) |
| `term` | credit-term label string |
| `placedDate` | Date if on the timeline, else `null` (in reservoir) |
| `origin` | `'user'` \| `'planned'` \| `'auto'` \| `null` — see §4 |
| `facility` | `null` \| `'financing'` (CC) \| `'bd'` |
| `paid` | planning-only "ticked paid" flag |
| `overdue`, `priority`, `highValue` | derived flags (highValue = ≥ ₹5L) |
| `termVerified` / `termUnverified` | credit-term provenance (see §7) |
| `termEdited` | `'term'` \| `'date'` \| `null` |
| `termOriginal` / `dueOriginal` | pre-override values (for the badge) |
| `srcTerm` / `srcDue` | the source term/due (for an exact Reset) |

---

## 4. Provenance tag: `✓ you` / `✦ planned` / `auto` / `✓ paid`

The top-left tag on a **placed** block (`renderPlaced`) is driven by `origin` (plus
`paid`). Unscheduled blocks show no tag.

| Tag | `origin` | Set when… | Card style |
|---|---|---|---|
| `✓ you` | `user` | **Manual drag-drop** onto a day/week/column (`placeOnDate`) | solid (yours) |
| `✦ planned` | `planned` | The **Plan ▾** tool (`planPeriod`) or **Carry overdue → today** (`placeOverdueOnToday`) — *you clicked, the app chose the dates* | `.suggested` (tentative) |
| `auto` | `auto` | **Restored from a save**: loaded schedule (`toBlock`), loaded named plan (`loadPlans`), restored split piece (`restoreFragments`) | `.suggested` (tentative) |
| `✓ paid` | (any) + `paid` | The bill is ticked paid — **overrides** the other three | `.paid` |

**Priority:** `paid` > `auto` > `planned` > `user`.

**Transitions:**

```
 (reservoir, no tag) ──drag──>            user   (✓ you)
 (reservoir, no tag) ──Plan ▾ / Carry──>  planned (✦ planned)
 saved board ──reload──>                  origin restored from the saved `origins` map
                                          (you/planned survive; not recorded → auto)
 any placed ──drag again──>               user   (a re-drag is always manual)
 any placed ──tick paid──>                paid   (visual override; origin unchanged)
 any placed ──drag to reservoir──>        null   (unplaced → no tag)
```

**Provenance is persisted.** `origins` ( `{ id: 'user' | 'planned' }`, see
`originsMap()`/`toBlock()`) is saved alongside `schedules` and round-trips through
Save, Publish, and named plans — so `✓ you` and `✦ planned` **survive a reload**. Only
`'user'`/`'planned'` are stored; a placed block with no `origins` entry restores as
`auto` (which is exactly "restored from a save"). "auto" means *restored*, not "the app
auto-planned it."

---

## 5. Scheduling & placement permutations

A block is either **unscheduled** (reservoir) or **placed** (`placedDate` set). Placed
blocks interact with **today** and the **horizon**.

| Placement | Relative to today | Visual / behavior |
|---|---|---|
| Unscheduled | — | in reservoir "Upcoming"; counts toward `Unscheduled` KPI; not in any cash sum |
| Placed | future | normal card; counts in net/balance |
| Placed | today | `Today` column highlight |
| Placed | past | guarded: dropping into the past triggers a **"did it already happen?"** confirm (`warnPastPlacement`); `Past` tag |
| Placed (carried-late) | on/after today **but** real due date already passed | `⏱ Was due …` banner (`isCarriedLate`); still shows lateness |

**Ways a block gets placed:**

1. **Drag** one block → `dropOnColumn` → `finalizePlace` → `origin:'user'`.
2. **Plan ▾ → year/month/week/day** → `planPeriod` schedules *every unscheduled bill
   whose due date falls in that period* onto its due date → `origin:'planned'`.
   Overdue ones are carried to **today** (not the past).
3. **Carry overdue → today** → `placeOverdueOnToday` → all unscheduled overdue bills
   onto today → `origin:'planned'`.
4. **Restore** on load / load-plan → `origin` from the saved `origins` map
   (`'user'`/`'planned'` survive a reload; otherwise `'auto'`).

**Undo/redo:** every placement/split/paid toggle goes through `commit()` (60-deep
`past` stack). Undo/redo do **not** re-hit the server; they replay in-memory state.

---

## 6. Partial-payment splitting (conserved money)

Editing a block's amount (click the amount → inline edit) **splits** the bill. The
rule that must never break:

> **Conservation:** for each family, Σ\|piece\| === `familyCeil[root]` (in paise,
> exact). Checked on every commit by `assertConservation()`; a violation logs
> `[CFP] money conservation broken`.

- `root` = the original invoice id; `familyCeil[root]` = the full invoice total
  (seeded on the first split).
- **Reduce** (type a smaller value): shrink this piece, carve the remainder into a
  fresh **unscheduled** kept-aside piece (`_reduceInto`).
- **Grow** (type a larger value): absorb sibling pieces up to the ceiling
  (`_growFrom`). Capped at the ceiling — can never invent money.
- **Merge back** (↩ on a fragment): fold a piece's money into a sibling
  (`mergeBack`) — never an ✕ that drops money.
- **Merge fragments** (menu): collapse every family back to one whole invoice.

| Scenario | Result |
|---|---|
| Reduce to the same value | no-op (no undo entry, no 0-piece) |
| Reduce below current | kept piece created with the remainder, unscheduled |
| Grow ≤ ceiling, siblings available | absorbs smallest/unscheduled siblings first |
| Grow > ceiling | capped, toast "Capped at … the full invoice" |
| Grow with no siblings | toast "nothing to grow into — reduce it instead" |
| Edit a **facility** line | blocked (facilities aren't part-payable) |
| Edit invalid text | toast "Enter a positive amount, e.g. 50000" (`parseMoneyPaise`) |
| Reload after splits | `restoreFragments` rebuilds the family from the `fragments` map (`origin:'auto'`) |

---

## 7. Credit terms — best-effort, flagged, and editable

### 7.1 Provenance

`tally_bills.json` carries `term_verified` per bill:

- **Verified** (`Net 45` etc.) — a real Tally credit period was matched.
- **Unverified** (`Due on receipt`) — best-effort fallback. **Mix** of genuinely
  term-less bills AND bills whose term couldn't be matched in the XML. Flagged with a
  `? unverified` badge so it's never confused with a confirmed term.

`_apply_term_override()` (server) computes `term_verified` / `term_unverified` and,
when an override exists, the corrected term/date + provenance.

### 7.2 The two-mode edit (the dialog)

Click any term (ledger) or the badge on a card → `editTerm()` dialog. A radio decides
the **meaning**:

| Mode | What you edit | Effect | Badge |
|---|---|---|---|
| **"The supplier's credit term"** (standing) | preset / custom **days** | recompute due = billDate + days; term becomes **verified**; offers to apply to this supplier's other unverified bills | `✎ term` |
| **"A one-off date move"** | a **date** | term label unchanged; only *this* bill's due date shifts | `⇄ ±Nd` |

| Term badge | Meaning |
|---|---|
| `? unverified` | source term couldn't be verified — click to confirm/correct |
| `✎ term` | credit term was corrected (tooltip shows "was …", who, when) |
| `⇄ +5d` | one-off manual date move (tooltip shows original due) |
| *(none)* | verified source term, untouched |

Other behaviors:

- **Reset to source** (dialog secondary action, shown when an override exists) reverts
  to `srcTerm`/`srcDue` exactly.
- **Sibling propagation:** after a standing correction, `_offerApplyToSiblings`
  **asks** (never silent) whether to apply the same term to the supplier's other
  unverified bills.
- **Confirming a term-less bill:** setting "Due on receipt" via the dialog (days 0)
  still clears `unverified` — it's now user-confirmed.
- **Split pieces:** an edit keys off `rootOf(b)` (the invoice), so all pieces of a
  family share the corrected term.
- **Persistence:** stored in `term_overrides` (keyed by invoice), saved **immediately**
  via `save_term_override` (own endpoint, doesn't touch scheduling), and round-tripped
  through draft Save / named plans / CSV ("Term Source" column).
- Edits **patch the live board in place** (`_applyTermLocally`) — no reload, so
  unsaved scheduling isn't lost.

---

## 8. Concurrency — shared board + per-user drafts

The big one. Two Accounts users used to silently clobber each other (one global file,
unlocked read-modify-write). Now:

### 8.1 Model

```
        ┌─ draft__alice.json (base_rev) ─┐
 edits ─┤                                 ├─ Publish ─> cash_flow_planner_data.json
        └─ draft__bob.json   (base_rev) ─┘             (shared board, rev, saved_plans)
```

- You **edit your private draft** — zero cross-user contention.
- **Publish** promotes your draft → shared, **only if** your `base_rev` still equals
  the shared `rev` (optimistic lock). Else → **conflict** (never a silent overwrite).
- **Named plans** live in the shared file = one global library everyone can load.
- All writes are **flock-serialized** + **atomic** (temp file → `os.replace`), so the
  file can never be torn and concurrent writers can't both "win".

### 8.2 Publish permutations (two users A and B, both forked at rev N)

| Sequence | Outcome |
|---|---|
| A edits, A publishes | shared → rev N+1, `published_by=A`; A's `base_rev` → N+1 |
| A publishes, then B publishes (B still at N) | B gets **conflict** `{shared_rev:N+1, published_by:A}`; shared untouched |
| B resolves with **Force publish** | shared → rev N+2 = B's draft (overwrites A) |
| B resolves with **Reload shared** | B's draft discarded, re-forked at N+1 (takes A's); B's edits lost (B's informed choice) |
| A and B edit **different bills**, publish sequentially | both succeed; second is **not** stale because it re-forked / second publisher must reload first then re-apply (schedules are holistic — see gotcha) |
| Two publishes truly simultaneous | flock serializes; first wins rev+1, second sees stale → conflict |

### 8.3 Draft lifecycle

| Action | Endpoint | Effect |
|---|---|---|
| Open planner | `get_planner_data` | loads your draft (forks from shared on first use); returns `board_meta` |
| Save | `save_planner_data` | writes your draft (locked, atomic) — toast "Draft saved" |
| Save a note / term | `save_review_note` / `save_term_override` | field-scoped locked draft write |
| Publish | `publish_planner(force)` | promote → shared (or conflict) |
| Reload shared | `discard_draft` | re-fork draft from shared (discards your edits) |
| Reset draft → shared | `reset_planner_data` | delete your draft (next load re-forks) |
| Save as… | `save_named_plan` | snapshot your draft into the shared plan library |
| Load plans… | `list_/load_named_plan` | load a shared plan into your draft (in memory) |

### 8.4 "Behind" indicator

`board_meta.behind = shared_rev > base_rev` → someone published after you forked. UI
shows a `⟳ shared moved` chip + `⚠` on Publish. It's **informational**; you can keep
editing, then Publish (which will conflict → choose), or Reload.

> **Gotcha (holistic schedules):** the `schedules` map is the whole board arrangement.
> Two people who scheduled bills differently can't be auto-merged, so the second
> publisher hits a conflict and must Reload (and re-apply) or Force. This is the
> deliberate "surface it, don't silently guess" tradeoff. Term/note edits, being
> field-scoped, merge cleanly within a draft.

---

## 9. Timeline, columns, KPIs, facilities

### 9.1 Views

`year` (12 months) → `month` (weeks) → `week` (7 days), DFS drill via column heads.
`HORIZON_START` = Monday of the current week; `horizonWeeks` default 6;
`horizonEnd` = +(6×7−1) days.

### 9.2 Per-column derived values (`buildColumns`)

| Value | Meaning |
|---|---|
| `inflow` / `outflow` / `net` | Σ of placed `amountP` (>0 / <0 / all) in the column |
| `Σ` (`sigma`) | running balance at column end (`balanceAt`) |
| `minBal` | lowest end-of-day balance in the column (`minBalanceInRange`) |
| `shortfall` | `minBal < 0` → ⚠ marker (cash dips below ₹0 on *some* day in the period) |
| `isHorizon` / `isFuture` / `isPast` / `isToday` | styling flags |

### 9.3 Status KPIs (`kpis`) — **placed cash only**

| KPI | Meaning |
|---|---|
| Horizon net | Σ placed amounts within the horizon |
| Lowest cash · wk N | min end-of-week balance across horizon weeks |
| Overdue | count of overdue blocks |
| Unscheduled | count of reservoir blocks |
| ✓ Paid | ticked-paid count / bill count |

> Empty board ⇒ "Lowest cash = opening" reads as healthy runway — the UI explicitly
> notes "nothing scheduled yet" so that's not misread.

### 9.4 Bank facilities

Seeded **client-side** (`addFacilityBlocks`) as 3 demo rows (CC draw ₹18L, BD draw
₹24L, CC repay −₹9L); backend carries no financing rows. `balanceAt` includes facility
draws as cash in. Utilization bars:

| Facility | Limit | States |
|---|---|---|
| Cash Credit (CC, `financing`) | ₹6 Cr | ok < 80% · soft ≥ 80% · hard ≥ 100% |
| Bill Discounting (BD, `bd`) | ₹4 Cr | same thresholds (`SOFT = 0.8`) |

`facCC`/`facBD` = `max(0, Σ placed facility amounts)` (draws − repayments, floored).

---

## 10. Endpoint reference (all `@frappe.whitelist`)

| Endpoint | Reads/Writes | Purpose |
|---|---|---|
| `get_planner_data(base_date)` | draft + shared | bills + draft config + `board_meta` |
| `save_planner_data(...)` | draft | full board save (private) |
| `save_review_note(invoice_name, note)` | draft | field-scoped note save |
| `save_term_override(invoice_name, override)` | draft | field-scoped credit-term override |
| `publish_planner(force=0)` | shared | promote draft → shared (optimistic / force) |
| `discard_draft()` | draft | re-fork draft from shared |
| `reset_planner_data()` | draft | delete draft (revert to shared) |
| `save_named_plan(plan_name)` | shared | snapshot draft → shared plan library |
| `load_named_plan` / `list_named_plans` / `delete_named_plan` | shared | named-plan library |
| `export_planner_csv(base_date, schedules, paid)` | — | CSV of live board (incl. Term Source) |

**Config / draft / shared shapes:**

```jsonc
// shared (cash_flow_planner_data.json)
{ ...board fields..., "rev": 3, "published_by": "...", "published_at": "...",
  "saved_plans": { "Q3 plan": { ...board fields..., "saved_at": "...", "saved_by": "..." } } }

// draft (cash_flow_planner_draft__<user>.json)
{ ...board fields..., "base_rev": 3 }

// board fields = opening_balance_paise(int), horizon, scenario, schedules{id:dateKey},
//   origins{id:'user'|'planned'}, notes{}, custom_amounts{}, fragments{}, paid{id:true},
//   term_overrides{ id: {kind:'term',days,term_label} | {kind:'date',due_date} ,edited_by,edited_at},
//   cc_utilization, bd_utilization
```

---

## 11. Cross-cutting permutations (the tricky interactions)

| Combination | Behavior |
|---|---|
| Split a bill, then term-edit it | term override keys off `rootOf` → applies to the whole family; pieces share term/due |
| Term-edit (recompute due), bill was overdue | overdue/`carried-late` recompute from the new due (`_applyTermLocally` updates `overdue`) |
| One-off date move into the past | allowed (it's an explicit date); overdue math follows |
| Tick paid, then split | paid flag rides on the edited block (Object.assign copies it); `paidMap` persists real-block paid flags |
| Tick paid on a facility line | blocked (`togglePaid` guards `facility`) |
| Publish with unsaved term/term edits | Publish calls `_saveDraft` first, so the draft (incl. overrides) is up to date before promoting |
| Load a named plan with different term overrides | `loadPlans` re-applies that plan's `term_overrides` and **reverts** invoices not in the map to source |
| Reload shared while you have splits | splits are in your draft `fragments`; Reload discards the draft → splits gone (informed) |
| Bill removed from `tally_bills.json` but present in a saved schedule/override | block simply won't be created; `restoreFragments` skips a missing base; a term override with no matching bill is inert |
| `custom_amounts` | present in the schema and merged server-side, but the **current UI sends `{}`** (amount edits go through the split engine, not custom_amounts) — left in for back-compat |
| Two browser tabs, same user | both write the *same* draft file; flock serializes; last save wins (same user, acceptable) |
| Opening cash entered as rupees by mistake | applied, with a heads-up toast (field is lakhs) |

---

## 12. Known limitations & deliberate tradeoffs

1. **Holistic `schedules`** → publish conflicts on overlapping drag arrangements aren't
   auto-merged; user reloads/forces (§8 gotcha).
2. **POSIX file locks** (`fcntl`) — bench is Linux/Mac; degrades to best-effort
   elsewhere.
3. **Facilities are client-seeded demo rows**, not backend data.
4. **`saved_plans` snapshots board fields only** (not nested plans), and **Save as**
   does not Publish.
5. **Named plan / term overrides reference invoice ids** — stale ids (after a data
   refresh) are silently inert, not errors.

*(Resolved since first draft: provenance now persists via `origins` (§4); opening cash
is canonical integer paise via `opening_balance_paise` (§2).)*

---

## 13. Testing

```bash
bench --site <site> set-config allow_tests true   # if disabled
bench --site <site> run-tests --module \
  cashdash.cashdash.page.cash_flow_planner.test_cash_flow_planner
```

Covered: real-term data load, **partial-save data-loss guards**, CSV reflects live
state, **provenance + opening-paise round-trip**, **per-user draft isolation**,
**publish optimistic conflict + force**, and **flock serialization** (8 threads ×
100 locked increments = 800, no lost updates).

Pure-logic checks (money paise sums, term apply/reset, tag selection, split
conservation) can be exercised by `exec`-ing the module with a stubbed `frappe`
(no DB) — see the patterns used during development.

---

## 14. Where to look (by task)

| Task | Start at |
|---|---|
| Add a money field | keep it `…P` (paise); format only via `fmtShort` |
| Change a provenance tag | `renderPlaced` (tag), `origin` assignments (`placeOnDate`/`planPeriod`/`placeOverdueOnToday`/`toBlock`/`loadPlans`/`restoreFragments`) |
| Touch credit terms | `editTerm`/`_applyTermLocally`/`termBadge` (JS), `_apply_term_override` (PY) |
| Touch concurrency | `_update_draft`/`_load_shared`/`_load_draft`/`publish_planner` (PY), `_saveDraft`/`publishPlanner`/`_publishConflict` (JS) |
| Touch splitting | `_reduceInto`/`_growFrom`/`mergeBack`/`assertConservation`/`fragmentsMap`/`restoreFragments` |
| Persistence shape | `BOARD_KEYS`, `_default_board`, `save_planner_data` |

---

*Keep the invariants intact: money stays integer paise; split families stay conserved;
draft writes stay locked + atomic; publish stays optimistic (never a silent clobber).*
