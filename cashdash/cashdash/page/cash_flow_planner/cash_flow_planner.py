import frappe
import json
import os
import csv
import io
from datetime import datetime

@frappe.whitelist()
def get_planner_data(base_date=None):
	"""
	Returns a dictionary containing:
	- payables: list of purchase invoices
	- receivables: list of sales invoices
	- config: saved planner settings (opening balance, horizon, scenario, schedules, notes)
	- supplier_groups: list of supplier group names
	- customer_groups: list of customer group names
	"""
	# Default the "today" anchor to the real current date (the frontend normally
	# passes its own; this covers direct/API calls so overdue math stays correct).
	if not base_date:
		base_date = frappe.utils.nowdate()

	# Load persisted config
	config = load_persisted_config()

	# Load the real outstanding bills (with real Tally credit terms) from the
	# app's committed data file. This is the single source of truth — see
	# importer/import_tally_bills.py, which regenerates data/tally_bills.json
	# from a Tally export sqlite.
	bills = load_tally_bills(base_date)

	# Inject saved review notes / custom amounts. The synthetic arg is now empty:
	# merge_invoices just overlays the persisted overrides onto the real bills.
	payables = merge_invoices(bills["payables"], [], config.get("notes", {}), config.get("custom_amounts", {}), base_date)
	receivables = merge_invoices(bills["receivables"], [], config.get("notes", {}), config.get("custom_amounts", {}), base_date)

	# Group filters are derived from the data so they always match party_group.
	supplier_groups = distinct_groups(payables)
	customer_groups = distinct_groups(receivables)

	# Detect contra parties
	contra_parties = get_contra_parties(payables, receivables)

	return {
		"payables": payables,
		"receivables": receivables,
		"config": config,
		"supplier_groups": supplier_groups,
		"customer_groups": customer_groups,
		"contra_parties": contra_parties
	}

@frappe.whitelist()
def save_planner_data(opening_balance, horizon, scenario, schedules, notes, cc_utilization=0, bd_utilization=0, custom_amounts=None, fragments=None, paid=None):
	"""
	Saves the planner configurations and schedules to a local JSON file.

	`paid` is a planning-only map { invoice_name: true } of bills the user has
	ticked off as paid ON THE BOARD. It is NOT a real payment — no Payment Entry
	is created and no invoice is touched. When omitted (None), the existing paid
	map is preserved so a partial save (e.g. the ledger's note save) can't wipe it.
	"""
	config_path = get_config_file_path()

	# Load existing data to preserve saved_plans
	existing = {}
	if os.path.exists(config_path):
		try:
			with open(config_path, "r") as f:
				existing = json.load(f)
		except Exception:
			pass

	data = {
		"opening_balance": float(opening_balance or 0),
		"horizon": horizon,
		"scenario": scenario,
		"schedules": json.loads(schedules or "{}"),
		"notes": json.loads(notes or "{}"),
		# Optional maps preserve the existing value when not passed, so a partial save
		# from another screen can never silently wipe the planner's working state.
		"custom_amounts": json.loads(custom_amounts) if custom_amounts is not None else existing.get("custom_amounts", {}),
		"fragments": json.loads(fragments) if fragments is not None else existing.get("fragments", {}),
		"paid": json.loads(paid) if paid is not None else existing.get("paid", {}),
		"cc_utilization": float(cc_utilization or 0),
		"bd_utilization": float(bd_utilization or 0),
		"saved_plans": existing.get("saved_plans", {})
	}
	
	with open(config_path, "w") as f:
		json.dump(data, f, indent=4)
		
	return {"status": "success", "message": "Planner state saved successfully"}

@frappe.whitelist()
def save_review_note(invoice_name, note=None):
	"""
	Updates ONLY the review note for one invoice in the persisted config.
	The ledger uses this instead of save_planner_data so adding a note never
	touches the planner's schedules / splits / opening balance (data-loss guard).
	"""
	if not invoice_name:
		frappe.throw("invoice_name is required")
	config_path = get_config_file_path()
	config = load_persisted_config()
	notes = config.get("notes", {})
	if note:
		notes[invoice_name] = note
	else:
		notes.pop(invoice_name, None)
	config["notes"] = notes
	with open(config_path, "w") as f:
		json.dump(config, f, indent=4)
	return {"status": "success", "message": "Note saved"}


@frappe.whitelist()
def reset_planner_data():
	"""
	Deletes the local JSON config file and resets the planner.
	"""
	config_path = get_config_file_path()
	if os.path.exists(config_path):
		os.remove(config_path)
	return {"status": "success", "message": "Planner reset successfully"}

def get_config_file_path():
	site_path = frappe.get_site_path("private", "files")
	if not os.path.exists(site_path):
		os.makedirs(site_path)
	return os.path.join(site_path, "cash_flow_planner_data.json")

def load_persisted_config():
	config_path = get_config_file_path()
	if os.path.exists(config_path):
		try:
			with open(config_path, "r") as f:
				cfg = json.load(f)
				if "custom_amounts" not in cfg:
					cfg["custom_amounts"] = {}
				if "fragments" not in cfg:
					cfg["fragments"] = {}
				if "paid" not in cfg:
					cfg["paid"] = {}
				if "saved_plans" not in cfg:
					cfg["saved_plans"] = {}
				return cfg
		except Exception:
			pass
	return {
		"opening_balance": 80.00, # In Lakhs, i.e., ₹80.00L
		"horizon": "6 wks",
		"scenario": "Realistic",
		# No seeded schedules/notes: they keyed off the old synthetic ACC-* invoice
		# names and would never match the real TLY-* bills. The board starts empty
		# and the user schedules real bills onto weeks themselves.
		"schedules": {},
		"notes": {},
		"custom_amounts": {},
		"fragments": {},
		"paid": {},
		"saved_plans": {},
		"cc_utilization": 0,
		"bd_utilization": 0
	}

def get_bill_data_path():
	"""Path to the committed extract of real outstanding bills."""
	return frappe.get_app_path("cashdash", "data", "tally_bills.json")


def distinct_groups(rows):
	"""Sorted distinct party_group values present in the given bills. The ledger
	JS prepends its own 'All groups' option, so this returns only the real groups."""
	return sorted({r.get("party_group") for r in rows if r.get("party_group")})


def load_tally_bills(base_date_str):
	"""Load the real outstanding bills from data/tally_bills.json and recompute the
	time-relative fields (age_days, payment_status) against base_date. Returns
	{"payables": [...], "receivables": [...]} in the planner's invoice dict shape.

	The data file is produced by importer/import_tally_bills.py from a Tally export
	and carries real per-bill credit terms (e.g. "Net 45") and due dates — replacing
	the old hash-assumed terms. Missing file => empty board (no synthetic fallback).
	"""
	base_date = datetime.strptime(base_date_str, "%Y-%m-%d").date()
	path = get_bill_data_path()
	if not os.path.exists(path):
		return {"payables": [], "receivables": []}

	with open(path, "r") as f:
		raw = json.load(f)

	def hydrate(rows):
		out = []
		for r in rows:
			final_date = _parse_ddmmyyyy(r.get("final_date"))
			age_days = (base_date - final_date).days if final_date else 0
			payment_status = f"Overdue {age_days}d" if age_days > 0 else f"Due in {abs(age_days)}d"

			item = dict(r)
			item["party_id"] = r.get("party_id") or r.get("party")
			item["value"] = float(r.get("value") or 0)
			item["outstanding"] = float(r.get("outstanding") or 0)
			item["age_days"] = age_days
			item["payment_status"] = payment_status
			item.setdefault("is_real", True)
			out.append(item)
		return out

	return {
		"payables": hydrate(raw.get("payables", [])),
		"receivables": hydrate(raw.get("receivables", [])),
	}


def _parse_ddmmyyyy(s):
	"""'18-04-2026' -> date, '' / bad -> None."""
	if not s:
		return None
	try:
		return datetime.strptime(s, "%d-%m-%Y").date()
	except ValueError:
		return None

def merge_invoices(real, synthetic, saved_notes, saved_amounts, base_date_str):
	# Keyed by name
	merged = {}
	
	# Add synthetic first
	for item in synthetic:
		merged[item["name"]] = item
		
	# Overwrite or append real
	for item in real:
		merged[item["name"]] = item

	# Inject review notes and UTR/cheque details from config
	for name, item in merged.items():
		if name in saved_notes:
			item["review_notes"] = saved_notes[name]
		else:
			item["review_notes"] = ""
		
		if name in saved_amounts:
			item["outstanding"] = float(saved_amounts[name])
			
	return list(merged.values())

def get_contra_parties(payables, receivables):
	"""
	Detects party names that appear in both payables and receivables.
	Returns a sorted list of contra-party names.
	"""
	# Parties that appear on BOTH sides of the displayed data. Derived from the
	# fetched invoices only — no full Supplier/Customer table scan per load.
	payable_parties = {inv["party"] for inv in payables}
	receivable_parties = {inv["party"] for inv in receivables}
	return sorted(list(payable_parties & receivable_parties))


@frappe.whitelist()
def save_named_plan(plan_name):
	"""
	Saves the current planner config as a named plan.
	The plan is stored under saved_plans[plan_name] in the JSON config file.
	"""
	if not plan_name or not plan_name.strip():
		frappe.throw("Plan name is required")

	plan_name = plan_name.strip()
	config_path = get_config_file_path()
	config = load_persisted_config()

	# Snapshot the current working state (everything except saved_plans itself)
	snapshot = {
		"opening_balance": config.get("opening_balance", 0),
		"horizon": config.get("horizon", "6 wks"),
		"scenario": config.get("scenario", "Realistic"),
		"schedules": config.get("schedules", {}),
		"notes": config.get("notes", {}),
		"custom_amounts": config.get("custom_amounts", {}),
		"fragments": config.get("fragments", {}),
		"paid": config.get("paid", {}),
		"cc_utilization": config.get("cc_utilization", 0),
		"bd_utilization": config.get("bd_utilization", 0),
		"saved_at": datetime.now().isoformat()
	}

	if "saved_plans" not in config:
		config["saved_plans"] = {}

	config["saved_plans"][plan_name] = snapshot

	with open(config_path, "w") as f:
		json.dump(config, f, indent=4)

	return {"status": "success", "message": f"Plan '{plan_name}' saved successfully"}


@frappe.whitelist()
def load_named_plan(plan_name):
	"""
	Loads and returns the data for a previously saved named plan.
	"""
	if not plan_name or not plan_name.strip():
		frappe.throw("Plan name is required")

	plan_name = plan_name.strip()
	config = load_persisted_config()
	saved_plans = config.get("saved_plans", {})

	if plan_name not in saved_plans:
		frappe.throw(f"Plan '{plan_name}' not found")

	return saved_plans[plan_name]


@frappe.whitelist()
def delete_named_plan(plan_name):
	"""
	Deletes a previously saved named plan.
	"""
	if not plan_name or not plan_name.strip():
		frappe.throw("Plan name is required")

	plan_name = plan_name.strip()
	config_path = get_config_file_path()
	config = load_persisted_config()
	saved_plans = config.get("saved_plans", {})

	if plan_name not in saved_plans:
		frappe.throw(f"Plan '{plan_name}' not found")

	del saved_plans[plan_name]
	config["saved_plans"] = saved_plans

	with open(config_path, "w") as f:
		json.dump(config, f, indent=4)

	return {"status": "success", "message": f"Plan '{plan_name}' deleted successfully"}


@frappe.whitelist()
def list_named_plans():
	"""
	Returns a list of saved plan names with their timestamps.
	"""
	config = load_persisted_config()
	saved_plans = config.get("saved_plans", {})

	plans = []
	for name, data in saved_plans.items():
		plans.append({
			"plan_name": name,
			"saved_at": data.get("saved_at", ""),
			"scenario": data.get("scenario", ""),
			"horizon": data.get("horizon", "")
		})

	# Sort by saved_at descending (most recent first)
	plans.sort(key=lambda x: x.get("saved_at", ""), reverse=True)
	return plans


@frappe.whitelist()
def export_planner_csv(base_date=None, schedules=None, paid=None):
	"""
	Generates a CSV of all payables and receivables for export.

	`schedules` and `paid` are the LIVE board state passed from the screen, so the
	export matches what the user sees (not just the last save). When omitted, falls
	back to the persisted config.
	"""
	if not base_date:
		base_date = frappe.utils.nowdate()
	data = get_planner_data(base_date)
	payables = data.get("payables", [])
	receivables = data.get("receivables", [])
	config = data.get("config", {})
	sched = json.loads(schedules) if schedules else config.get("schedules", {})
	paid_map = json.loads(paid) if paid else config.get("paid", {})

	output = io.StringIO()
	writer = csv.writer(output)

	writer.writerow([
		"Party", "Invoice", "Ref No", "Bill Date", "Credit Term",
		"Final Date", "Value", "Outstanding", "Scheduled To", "Type", "Status", "Paid (planned)"
	])

	def write_rows(rows, kind):
		for inv in rows:
			name = inv.get("name", "")
			writer.writerow([
				inv.get("party", ""), name, inv.get("ref_no", ""),
				inv.get("bill_date", ""), inv.get("credit_term", ""), inv.get("final_date", ""),
				inv.get("value", 0), inv.get("outstanding", 0),
				sched.get(name, ""), kind, inv.get("payment_status", ""),
				"Yes" if paid_map.get(name) else ""
			])

	write_rows(payables, "Payable")
	write_rows(receivables, "Receivable")

	csv_content = output.getvalue()
	output.close()
	return csv_content
