#!/usr/bin/env python3
"""
import_tally_bills.py — extract real outstanding Sales/Purchase bills (with real
Tally credit terms) from the dormant Tally export sqlite into a compact JSON the
Cash Flow Planner reads.

WHY THIS EXISTS
---------------
The planner (cashdash/page/cash_flow_planner) used to fabricate credit terms with
a hash and fall back to hardcoded synthetic invoices. The real data is a multi-GB
Tally export sqlite. Real credit terms ("45 Days") live only in the raw Tally XML
(`raw_payloads`), not in the parsed `bill_allocations_json`. This script joins the
two and writes `cashdash/data/tally_bills.json`.

The 5 GB sqlite is NOT committed to git (see .gitignore). Only the compact output
JSON is committed. Re-run this script when you get a fresh Tally export.

WHAT IT DOES
------------
Pass A (structured tables): net every party-ledger bill allocation by
  (ledger_name, bill_name). `New Ref` opens a bill, `Agst Ref` settles it. A bill
  is *in scope* if it ORIGINATES from a Sales or Purchase voucher (New Ref on a
  Sales/Purchase voucher) and still has non-zero net outstanding. Settlements from
  ANY voucher type (Receipt, Payment, Journal, ...) are included in the net so the
  outstanding is true.
Pass B (raw XML): stream `raw_payloads.response_xml` once and, for each New Ref
  bill allocation, capture <BILLDATE> and <BILLCREDITPERIOD> ("45 Days"), keyed by
  (LEDGERNAME, bill NAME). Empty credit period => "Due on receipt".

Side (payable vs receivable) is decided by walking the party ledger's Tally group
chain to `Sundry Debtors` (receivable) or `Sundry Creditors` (payable).

USAGE
-----
    python3 import_tally_bills.py [path/to/export.sqlite3] [path/to/out.json]

Defaults resolve the sqlite sitting next to the cashdash package and write to
cashdash/data/tally_bills.json.
"""

import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)  # .../cashdash/cashdash

DEFAULT_SQLITE = os.path.join(PKG, "tally_export.sqlite3")
DEFAULT_OUT = os.path.join(PKG, "data", "tally_bills.json")

# Origin voucher types that define an in-scope bill (user decision: Sales/Purchase only).
SP_ORIGIN = ("Sales", "Purchase")


# ----------------------------------------------------------------------------- helpers


def strip_ledger_prefix(name):
    """'60A2 Acme Appliances (North)' -> 'Acme Appliances (North)'.

    Tally ledgers carry a short code prefix (e.g. 60A2, 30L2, 10L2). Strip a single
    leading alphanumeric code token for display while keeping the full ledger name
    as the stable id.
    """
    return re.sub(r"^\s*[0-9][0-9A-Za-z.]*\s+", "", name or "").strip() or (name or "")


def parse_credit_days(text):
    """'45 Days' -> 45, '1 Month' -> 30, '' / None -> 0."""
    if not text:
        return 0
    t = text.strip().lower()
    m = re.search(r"(\d+)", t)
    if not m:
        return 0
    n = int(m.group(1))
    if "month" in t:
        n *= 30
    elif "week" in t:
        n *= 7
    return n


def fmt_date(value):
    """Normalise a Tally date to ('dd-mm-YYYY', date). Accepts both the raw-XML
    form '20250612' and the structured `voucher_date` form '2025-06-12'.
    Returns ('', None) on bad/empty input."""
    if not value:
        return "", None
    s = str(value).strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            d = datetime.strptime(s, fmt).date()
            return d.strftime("%d-%m-%Y"), d
        except ValueError:
            continue
    return "", None


def build_classifier(conn):
    """Return classify(ledger_name) -> 'RECEIVABLE' | 'PAYABLE' | None.

    Walk the ledger's group parent chain to Sundry Debtors / Sundry Creditors.
    """
    group_parent = {n: p for n, p in conn.execute("SELECT name, parent FROM groups")}
    ledger_parent = {
        n: p for n, p in conn.execute("SELECT name, parent FROM ledgers")
    }

    def classify(ledger_name):
        cur = ledger_parent.get(ledger_name)
        seen = set()
        while cur and cur not in seen:
            seen.add(cur)
            low = cur.lower()
            if "sundry debtor" in low:
                return "RECEIVABLE"
            if "sundry creditor" in low:
                return "PAYABLE"
            cur = group_parent.get(cur)
        return None

    return classify, ledger_parent


# ----------------------------------------------------------------------------- Pass A


def pass_a_netting(conn):
    """Return (net, origin):

    net:    {(ledger, bill): summed_amount}  across ALL non-cancelled vouchers
    origin: {(ledger, bill): {"vtype","vdate","value"}} for Sales/Purchase New Refs
    """
    net = defaultdict(float)
    origin = {}
    q = """
        SELECT vle.ledger_name, vle.bill_allocations_json,
               v.base_voucher_type, v.voucher_date
        FROM voucher_ledger_entries vle
        JOIN vouchers v ON v.id = vle.voucher_id
        WHERE vle.is_party_ledger = 1 AND v.is_cancelled = 0
          AND vle.bill_allocations_json NOT IN ('', '[]', 'null')
    """
    for ledger, bj, vtype, vdate in conn.execute(q):
        try:
            allocs = json.loads(bj)
        except (ValueError, TypeError):
            continue
        for a in allocs:
            bill = a.get("name")
            if bill is None:
                continue
            amt = a.get("amount") or 0
            typ = (a.get("type") or "")
            key = (ledger, bill)
            net[key] += amt
            if typ.startswith("New Ref") and vtype in SP_ORIGIN:
                prev = origin.get(key)
                # Keep the earliest origin (the bill's true opening).
                if prev is None or (vdate or "") < prev["vdate"]:
                    origin[key] = {
                        "vtype": vtype,
                        "vdate": vdate or "",
                        "value": abs(amt),
                    }
    return net, origin


# ----------------------------------------------------------------------------- Pass B


def pass_b_credit_terms(conn, wanted_keys):
    """Stream all raw XML once; return {(ledger, bill): {"days","billdate"}}.

    Only keys present in `wanted_keys` are kept (the in-scope outstanding bills),
    so memory stays tiny regardless of the 5 GB input.
    """
    terms = {}
    rows = conn.execute(
        "SELECT response_xml FROM raw_payloads WHERE response_xml LIKE '%BILLALLOCATIONS.LIST%'"
    )
    scanned = 0
    for (xml_text,) in rows:
        scanned += 1
        if not xml_text:
            continue
        _scan_payload(xml_text, wanted_keys, terms)
        if scanned % 500 == 0:
            sys.stderr.write(
                "  pass B: scanned %d payloads, matched %d/%d bills\n"
                % (scanned, len(terms), len(wanted_keys))
            )
            sys.stderr.flush()
        if len(terms) == len(wanted_keys):
            break  # every in-scope bill found; stop early
    sys.stderr.write("  pass B done: scanned %d payloads\n" % scanned)
    return terms


# A lightweight tag tokenizer. We deliberately do NOT use a real XML parser:
# Tally payloads contain unbound namespace prefixes (e.g. <UDF:_UDF_788572062>)
# that make ElementTree raise mid-stream, which would silently truncate a payload
# and drop every bill after the break. A regex sweep is immune to that and we only
# need a handful of leaf tags.
_TOKEN = re.compile(r"<(/?)([A-Za-z0-9._:]+)(?:\s[^>]*?)?(/?)>([^<]*)", re.S)
_BILL_TAGS = {"NAME": "name", "BILLTYPE": "type", "BILLDATE": "billdate", "BILLCREDITPERIOD": "credit"}


def _scan_payload(xml_text, wanted_keys, terms):
    """Sweep one payload's tags, tracking the current LEDGERNAME and reading each
    New Ref BILLALLOCATIONS.LIST for the bill's BILLDATE + BILLCREDITPERIOD."""
    cur_ledger = None
    cur = {}
    in_bill = False
    for closing, tag, selfclose, text in _TOKEN.findall(xml_text):
        if tag == "BILLALLOCATIONS.LIST":
            if closing:
                in_bill = False
                if cur.get("type", "").startswith("New Ref") and cur_ledger:
                    key = (cur_ledger, cur.get("name"))
                    if key in wanted_keys and key not in terms:
                        terms[key] = {
                            "days": parse_credit_days(cur.get("credit")),
                            "billdate": cur.get("billdate", ""),
                        }
                cur = {}
            elif not selfclose:
                in_bill = True
                cur = {}
        elif closing:
            continue
        elif tag == "LEDGERNAME":
            cur_ledger = text.strip()
        elif in_bill and tag in _BILL_TAGS:
            cur[_BILL_TAGS[tag]] = text.strip()


# ----------------------------------------------------------------------------- build


def build_records(conn):
    classify, ledger_parent = build_classifier(conn)
    sys.stderr.write("Pass A: netting bill allocations...\n")
    net, origin = pass_a_netting(conn)

    # In scope = Sales/Purchase-originated bills still outstanding.
    inscope = {k: o for k, o in origin.items() if abs(net[k]) > 1}
    sys.stderr.write(
        "Pass A: %d S/P New-Ref bills, %d still outstanding.\n"
        % (len(origin), len(inscope))
    )

    sys.stderr.write("Pass B: reading real credit terms from raw XML...\n")
    terms = pass_b_credit_terms(conn, set(inscope.keys()))

    company = conn.execute("SELECT name FROM companies LIMIT 1").fetchone()[0]

    payables, receivables = [], []
    no_term = 0
    for (ledger, bill), o in sorted(inscope.items()):
        side = classify(ledger)
        if side is None:
            continue  # not a debtor/creditor ledger — skip defensively
        t = terms.get((ledger, bill), {})
        days = t.get("days", 0)
        # Prefer the XML BILLDATE; fall back to the origin voucher date.
        bill_date_str, bill_date = fmt_date(t.get("billdate") or o["vdate"])
        if days and bill_date:
            final_str = (bill_date + timedelta(days=days)).strftime("%d-%m-%Y")
            credit_term = "Net %d" % days
        else:
            final_str = bill_date_str
            credit_term = "Due on receipt"
            no_term += 1

        rec = {
            "party": strip_ledger_prefix(ledger),
            "party_id": ledger,
            "party_group": ledger_parent.get(ledger, ""),
            "ref_no": bill,
            "bill_date": bill_date_str,
            "credit_term": credit_term,
            "final_date": final_str,
            "value": round(o["value"], 2),
            "outstanding": round(abs(net[(ledger, bill)]), 2),
            "is_real": True,
        }
        (receivables if side == "RECEIVABLE" else payables).append(rec)

    # Stable, deterministic ids (lists already sorted by ledger/bill).
    for i, r in enumerate(payables, 1):
        r["name"] = "TLY-P-%05d" % i
    for i, r in enumerate(receivables, 1):
        r["name"] = "TLY-R-%05d" % i

    sys.stderr.write(
        "Built %d payables + %d receivables (%d without a real term).\n"
        % (len(payables), len(receivables), no_term)
    )

    return {
        "company": company,
        "source": "Tally export (cashdash importer)",
        # The sqlite filename encodes the export date; record it for provenance.
        "as_of": "2026-04-25",
        "payables": payables,
        "receivables": receivables,
    }


def main():
    sqlite_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SQLITE
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(sqlite_path):
        sys.exit("sqlite not found: %s" % sqlite_path)

    conn = sqlite3.connect(sqlite_path)
    data = build_records(conn)
    conn.close()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    pay = sum(r["outstanding"] for r in data["payables"]) / 1e5
    rec = sum(r["outstanding"] for r in data["receivables"]) / 1e5
    sys.stderr.write(
        "Wrote %s\n  payable outstanding ~Rs %.1fL | receivable outstanding ~Rs %.1fL\n"
        % (out_path, pay, rec)
    )


if __name__ == "__main__":
    main()
