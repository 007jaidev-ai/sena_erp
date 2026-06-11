# Cashdash

A Frappe/ERPNext app that adds a **Cash Flow Planner** and a **Credit Terms
Ledger** to the Desk, for treasury-style planning over outstanding payables and
receivables.

> **Proof of concept.** This public repo ships with **synthetic sample data**.
> The real deployment runs against a company's actual Tally/ERPNext books, which
> are **not** part of this repo. See [Data](#data) and
> [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## What it does

- **Cash Flow Planner** (`/desk/cash-flow-planner`) — a weekly board where you
  drag outstanding bills onto weeks, set an opening balance, model scenarios, and
  see the running cash position. Page code lives in
  `cashdash/cashdash/page/cash_flow_planner/`.
- **Credit Terms Ledger** (`/desk/cash-flow-ledger`) — the per-invoice detail
  view (party, bill date, credit term, due date, value, outstanding, status) that
  the planner is built on. Page code in `cashdash/cashdash/page/cash_flow_ledger/`.

Both pages read a single backend method, `get_planner_data`, which returns
payables + receivables in a flat dict shape.

## Data

The planner reads outstanding bills from a committed JSON file:

```
cashdash/data/tally_bills.json
```

In this public repo that file is a **synthetic sample** (fabricated parties and
amounts) so the board renders for a demo. In a real deployment it is generated
from a company's Tally export by the importer:

```
cashdash/importer/import_tally_bills.py
```

The importer nets bill-wise allocations into per-bill outstanding amounts and
pulls real credit terms from the raw Tally XML. See
[`cashdash/importer/README.md`](cashdash/importer/README.md). The multi-GB Tally
export sqlite is intentionally **git-ignored** (see `.gitignore`) and never
committed.

To run against real data, replace `cashdash/data/tally_bills.json` with an
importer-generated file (kept private / outside this public repo).

## Installation

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch main
bench install-app cashdash
```

Then open `/desk/cash-flow-planner`.

## Status & limitations

This is a POC. Before any production use, read
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — it documents the static-snapshot
data model, re-import identity caveats, and the company/permission scoping a
production build would need.

## Contributing

This app uses `pre-commit` (ruff, eslint, prettier, pyupgrade):

```bash
cd apps/cashdash
pre-commit install
```

## License

mit
