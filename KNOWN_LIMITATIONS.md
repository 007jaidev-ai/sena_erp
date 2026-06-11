# Known limitations

This app is a **proof of concept**. The data-extraction logic is sound and
spot-checked, but the delivery mechanism is demo-grade. The gaps below should be
closed before any production / treasury use. They are listed roughly by severity.

## Architectural

1. **Static snapshot, goes stale.** The planner's entire data source is a
   committed `data/tally_bills.json` produced at a fixed point in time. There is
   no live sync, so the board drifts out of date every day and bills read as
   "overdue" purely because the extract is old. Production needs a scheduled sync
   (or to read live ERPNext invoices), not a committed file.

2. **Re-import can re-key user state.** Bill ids (`TLY-P-00001…`) are assigned by
   sort position. The planner persists user decisions (schedules, notes, "paid",
   splits) keyed by that id in a JSON config file. A fresh import that adds /
   settles bills shifts the ordering, so previously saved state can reattach to
   the wrong bill. Fix: derive the id from a stable hash of
   `(party_ledger, bill_ref)` instead of row position.

3. **No company / tenant scoping.** The data file is single-company and the read
   path no longer filters by the active company. On a multi-company site every
   user sees the same book. Production needs a `company` field and scoping.

4. **Numbers are not GL-reconciled or auditable.** Outstanding is a heuristic net
   of bill allocations; it excludes on-account/advances, non-bill-linked credit/
   debit notes, TDS/round-off, forex, and journal/opening-balance bills. There is
   no drill-down from a planner row back to source vouchers, so a mismatch against
   the accountant's aging can't be explained from the app.

## Correctness / security

5. **Permission bypass.** `get_planner_data` reads a file, so it returns all
   bills to anyone who can call the method — it does not honour ERPNext record
   permissions (company, territory, user permissions).

6. **Single-file persistence, last-write-wins.** Planner state is one JSON in
   site private files with read-modify-write and no locking. Two concurrent users
   (both Accounts roles) can silently clobber each other.

7. **Credit terms are best-effort and unflagged.** Some bills fall back to "Due
   on receipt" — a mix of genuinely term-less bills and bills whose term could not
   be matched in the source XML. They render identically to verified terms, with
   no confidence flag. The importer also has no self-check (extracted count vs
   rows written) and the "nearest `<LEDGERNAME>` owns the bill" parse heuristic
   may not hold across all Tally configurations.

8. **Float money.** Amounts are JSON floats and summed as floats in the planner.
   Production should use Decimal / integer paise.

## Suggested production shape

A scheduled job (or a Tally connector) populates an **auditable doctype** — one
row per outstanding bill, with a `company` field, a stable natural key, real
permission rules, and a link back to the source voucher — and the planner reads
that doctype. The static `tally_bills.json` + importer in this repo are the
prototype that proves the extraction and the UI; they are not the production data
path.
