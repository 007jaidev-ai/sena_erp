# Cash Flow Planner — UI/UX Design Brief

A brief for improving the look, feel, and usability of the **Cash Flow Planner**
demo. Pair this with `cashflow-planner-spec.json` (machine-readable tokens,
component inventory, and prioritized improvement goals).

---

## 1. What it is

A drag-and-drop **cash-flow scheduling board** for a manufacturing ERP
(Avinash Industries). The finance user takes real open invoices (payables and
receivables) plus financing options (Cash Credit / Bill Discounting draws and
repayments) and **drags them onto a calendar** to decide *when* money moves —
then watches the running cash balance, the lowest-cash point, and bank-facility
limits react live.

- **Surface:** a Frappe Desk *Page* (`cashflow-planner-demo`), rendered inside
  ERP "Desk". It also lives in the right-hand panel beside an AI sidebar, so
  **horizontal width is often constrained** and vertical scrolling is normal.
- **Stack:** vanilla JS + jQuery, drag-drop via **SortableJS**, all styling via
  a single injected `<style>` block. **No React/Vue, no build-time CSS.** Colors
  come from **Frappe theme CSS variables** (`var(--green-600)`, `var(--bg-blue)`,
  etc.) so the page must inherit Frappe light/dark themes.
- **Status:** functional demo under active iteration. Logic is solid; the visual
  design is utilitarian and dense. **This brief is about UI/UX polish, not
  feature changes.**

## 2. Who uses it & the core job

- **User:** a finance controller / CFO-office operator. Comfortable with numbers,
  impatient, working fast.
- **Core job:** "Across the coming weeks/months, *when* should each payment land
  so I never run out of cash and never breach my bank limits?"
- **Mental model:** a calendar + two "inboxes" of unscheduled money (what we owe
  on the left, what we're owed on the right). Drag from an inbox onto a date.

## 3. Current layout (4 zones, top → bottom)

```
┌───────────────────────────────────────────────────────────────────────┐
│ ZONE C · MONITOR (sticky top)                                           │
│  toolbar: ↶ ↷ | Opening ₹ | Horizon ▼ |        Merge Save Plans Export Reset │
│  title + breadcrumb           KPIs: Horizon Net · Lowest Cash · Unscheduled │
│  [warning bar if cash goes negative]                                    │
│  facility bars:  Cash Credit (CC) ▓▓▓░░   |   Bill Discounting (BD) ▓░░░ │
├──────────────┬─────────────────────────────────────────┬────────────────┤
│ ZONE A (L)   │ ZONE B · TIMELINE                        │ ZONE A (R)     │
│ Payables &   │  MACRO:  ◀ 2026 ▼ ▶   [Jun][Jul][Aug]…   │ Receivables    │
│ Financing    │  MONTH:  ← Calendar   [Wk1][Wk2][Wk3]…   │ (reservoir)    │
│ (reservoir)  │  MICRO:  ← Jun 2026   [Mon][Tue][Wed]…   │                │
│  search      │  each column = net, ▲in ▼out, Σrunning,  │  search        │
│  pills       │  block count, Drill ▸, + droppable body  │  pills         │
│  entity      │                                          │  entity        │
│  folders     │                                          │  folders       │
│  with cards  │                                          │  with cards    │
├──────────────┴─────────────────────────────────────────┴────────────────┤
│ ZONE D · Credit Terms table (per-invoice detail; overview widgets off)  │
│  header + "Open full tool ↗"   |   sortable invoice table (vendors/cust) │
└───────────────────────────────────────────────────────────────────────┘
```

**Three-level time drill in Zone B:**
- **Macro** = one **year** of **month** columns at a time, paged with a `◀ year ▶`
  toggle (current year out to ~2035).
- **Month** = the **weeks** of one month.
- **Micro** = the **days** of one week.

**The two reservoirs (Zone A)** list every unscheduled block as **collapsible
per-counterparty folders**. Cards are draggable; a card already placed on the
calendar shows greyed/dashed ("placed — click to locate"). Left = payables &
financing (red top-border), right = receivables (green top-border).

**A block/card** carries: a type tag (PAY / REC / CC / BD / CC↩ / BD↩), entity
name, optional flags (★ priority, ⏱ overdue), block id (mono), due date, a
timing pill (late/early), an editable ₹ value (in Lakhs), and a `⋮` move menu.
Editing a value down **splits** the card; a split fragment gets a `↩` merge-back.

## 4. Current visual language (what exists today)

- **Density:** very high. Base font **12px**, labels **9–10px**, lots of
  `text-transform:uppercase; letter-spacing` micro-labels. Tabular-nums on.
- **Color semantics (load-bearing — keep the meanings):**
  - **green** = inflow / receivable / positive / within-limit
  - **red** = outflow / payable / negative / overdue / hard-limit breach
  - **orange** = financing repayment, "late" timing, soft-limit warning
  - **teal** = Bill Discounting; **dark green** = Cash Credit
  - **blue** = selection / horizon focus / drill affordance / "early" / placed-hover
  - **purple** = contra (a counterparty that is both customer & vendor)
- **Shape:** small radii (3–4px), 1px borders everywhere, 3px colored left-border
  on cards, sticky column heads, dashed empty-drop zones.
- **Motion:** 120ms drag animation, a flash highlight on locate, a flashing red
  fill when a facility hard-limit is breached.
- **Theme:** all via Frappe vars → must survive light **and** dark mode.

## 5. Known UX pain points to solve

1. **Visual noise / flatness.** Everything is the same weight, size, and 1px
   border. Hard to know where to look first. The *primary* signals (am I going
   negative? what's the lowest-cash week? what's overdue?) don't pop above the
   secondary chrome.
2. **Hierarchy of the 4 zones is weak.** The sticky monitor, the board, and the
   table all read as equally important. The board (the actual work surface)
   should dominate.
3. **Calendar legibility.** Month/week/day columns look almost identical across
   the three drill levels — users lose track of *which level they're on*. The
   horizon "focus band" (shaded blue) and the dimmed future columns are subtle.
4. **The reservoirs are busy.** Search + 3 filter pills + nested folders + cards,
   ×2 sides, in ~236px each. Folders, counts, totals, and cards compete.
5. **Cards are cramped.** Type tag, name, flags, id, due, timing pill, value
   input, move button, and a "where" badge all pack into a ~2-line card. The
   editable value vs. read-only value states aren't obviously different.
6. **State legibility.** placed/dimmed/overdue/late/early/past-day/weekend/holiday
   are all encoded but easy to miss. Empty-state drop targets are plain dashed
   boxes.
7. **Constrained width.** In the sidebar the 3-column body + horizontal-scroll
   lanes get tight. Needs to degrade gracefully.
8. **Affordances.** Drag handles, what's draggable vs. clickable, and the
   `⋮`/`↩`/Drill controls aren't strongly signposted.

## 6. Design goals (what "better" means here)

- **Establish clear visual hierarchy:** board first; monitor as a calm status
  strip; reservoirs as quiet inboxes; table as reference detail.
- **Make the money story pop:** running balance, lowest-cash point, negative-cash
  warning, and limit breaches should be the most salient things on screen.
- **Differentiate the three calendar levels** at a glance (year vs month vs day),
  and make horizon vs future obvious without reading.
- **Calmer cards & reservoirs:** reduce per-element noise, improve scannability,
  make editable vs locked and placed vs unplaced unmistakable.
- **Stronger, friendlier drag affordances** and empty/drop states.
- **Keep it dense but breathable** — this is a power-user tool; don't bloat it,
  but add rhythm, spacing, and weight contrast.

## 7. Hard constraints (do not break)

- **Use Frappe CSS variables** for all color; never hardcode hex that won't adapt
  to dark mode. (Hex fallbacks alongside `var(--x)` are fine, as today.)
- **Keep all existing class names and DOM structure where possible** — styling is
  one injected stylesheet keyed to these classes (`cfp-*`, and `sct-*` for the
  embedded Credit Terms table). Prefer restyling existing classes / adding
  modifier classes over renaming or restructuring.
- **No new heavy dependencies** (no Tailwind/Bootstrap/React). Plain CSS, optional
  small SVG icons inline.
- **Preserve the color *semantics*** in §4 — recolor for polish, but green stays
  "money in / good", red stays "money out / danger", etc.
- **Must work** in a narrow embedded panel and at full Desk width; light + dark.
- This is **UI/UX only** — don't propose feature/logic changes.

## 8. What to deliver

1. A refreshed **visual system**: type scale, spacing/rhythm, weight contrast,
   border/elevation strategy, refined (theme-var-based) palette, focus/hover
   states — expressed as CSS that maps onto the existing `cfp-*` / `sct-*`
   classes.
2. **Zone-by-zone redesign** notes + before/after for: the monitor/KPI strip, the
   calendar columns (all 3 levels), the reservoir folders, and the block card.
3. **Component states** spec'd: card (unplaced/placed/dimmed/overdue/late/early),
   column (horizon/future/past/today/weekend/holiday), facility bar (ok/soft/
   hard), empty/drop targets, buttons/pills.
4. **Annotated mockups** (any fidelity) for macro, month, and micro views, plus a
   single card and a reservoir folder.
5. Notes on **responsive/narrow-width** behavior and **dark-mode** parity.

See `cashflow-planner-spec.json` for exact tokens, the component inventory with
current class names, and the prioritized improvement list.
