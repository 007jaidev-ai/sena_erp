# Tally bills importer

`import_tally_bills.py` extracts the real outstanding **Sales/Purchase** bills
(with real Tally credit terms) from a Tally export sqlite into the compact JSON
the Cash Flow Planner reads:

```
cashdash/data/tally_bills.json
```

## What's in the public repo vs not

- **Committed:** this script + the output JSON. In the **public** repo the output
  JSON is a *synthetic sample* — fabricated parties/amounts, not real data.
- **Not committed:** the Tally export `*.sqlite3` (multi-GB; git-ignored) and the
  *real* generated JSON. Those live outside this public repo.

## Usage

```bash
python3 import_tally_bills.py [path/to/export.sqlite3] [path/to/out.json]
```

With no arguments it expects the sqlite next to the `cashdash` package and writes
`cashdash/data/tally_bills.json`. It needs only the Python standard library
(`sqlite3`, `re`, `json`) — no Frappe, no third-party packages.

## How it works

- **Pass A (structured tables):** nets every party-ledger bill allocation by
  `(ledger, bill_name)` — `New Ref` opens a bill, `Agst Ref` settles it. A bill is
  in scope if it originated from a **Sales** or **Purchase** voucher and still has
  non-zero net outstanding. Settlements from any voucher type are included in the
  net. Payable vs receivable is decided by walking the ledger's Tally group chain
  to *Sundry Debtors* / *Sundry Creditors*.
- **Pass B (raw XML):** sweeps `raw_payloads` for each New Ref bill's `<BILLDATE>`
  and `<BILLCREDITPERIOD>` (e.g. "45 Days"), keyed by `(LEDGERNAME, bill)`. A
  regex tokenizer is used deliberately — Tally payloads contain unbound namespace
  prefixes (`<UDF:...>`) that break a strict XML parser. Empty credit period →
  "Due on receipt".

See [`../../KNOWN_LIMITATIONS.md`](../../KNOWN_LIMITATIONS.md) for the caveats
(identity stability across re-imports, GL reconciliation, etc.).
