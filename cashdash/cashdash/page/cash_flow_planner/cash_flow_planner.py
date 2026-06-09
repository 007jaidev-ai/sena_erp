import frappe
import json
import os
import csv
import io
import hashlib
from datetime import datetime, timedelta

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

	# Fetch Supplier & Customer Groups for filtering
	supplier_groups = [d.name for d in frappe.get_all("Supplier Group", order_by="name")]
	customer_groups = [d.name for d in frappe.get_all("Customer Group", order_by="name")]
	
	if not supplier_groups:
		supplier_groups = ["All supplier groups", "OEM Purchase Ledgers", "Job Work & Contract Processing", "RM - Packaging Materials", "Statutory, Provisions & Payables"]
	if not customer_groups:
		customer_groups = ["All customer groups", "Supplier Return Parties", "Scrap Buyers", "Finished Goods Customers", "Component Customers"]

	# Try fetching real invoices from DB
	real_payables = fetch_real_invoices("Purchase Invoice", base_date)
	real_receivables = fetch_real_invoices("Sales Invoice", base_date)

	# Generate synthetic data to match the screenshots and supplement if DB is empty
	synthetic_payables = get_synthetic_payables(base_date)
	synthetic_receivables = get_synthetic_receivables(base_date)

	# Merge (prefer real if they have same name, but for this demo dashboard, we combine them)
	payables = merge_invoices(real_payables, synthetic_payables, config.get("notes", {}), config.get("custom_amounts", {}), base_date)
	receivables = merge_invoices(real_receivables, synthetic_receivables, config.get("notes", {}), config.get("custom_amounts", {}), base_date)

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
		"schedules": {
			"ACC-PINV-2026-00001": "2026-W23",
			"ACC-PINV-2026-00002": "2026-W23",
			"ACC-PINV-2026-00003": "2026-W23",
			"ACC-PINV-2026-00010": "2026-W24",
			"ACC-PINV-2026-00011": "2026-W24",
			"ACC-PINV-2026-00013": "2026-W25",
			"ACC-PINV-2026-00014": "2026-W25",
			"ACC-PINV-2026-00015": "2026-W26",
			"ACC-PINV-2026-00016": "2026-W26",
			"ACC-SINV-2026-00001": "2026-W23",
			"ACC-SINV-2026-00002": "2026-W23",
			"ACC-SINV-2026-00003": "2026-W24",
			"ACC-SINV-2026-00007": "2026-W24",
			"ACC-SINV-2026-00008": "2026-W25",
			"ACC-SINV-2026-00009": "2026-W25",
			"ACC-SINV-2026-00010": "2026-W26",
			"ACC-SINV-2026-00011": "2026-W26"
		},
		"notes": {
			"ACC-PINV-2026-00001": "Cheque #991023 assigned",
			"ACC-SINV-2026-00003": "Followed up, promised by 15th"
		},
		"custom_amounts": {},
		"fragments": {},
		"paid": {},
		"saved_plans": {},
		"cc_utilization": 0,
		"bd_utilization": 0
	}

def assume_credit_days(doctype, party_group, seed):
	"""
	Real invoices currently land as "Due on receipt" because the credit-terms
	doctype isn't built yet. To give the planner a board worth testing on, we
	spread an ASSUMED credit term of 0–90 days across every invoice so due dates
	fan out over the whole timeline (overdue → in-horizon → later) instead of
	clustering. Deterministic — seeded by invoice name — so the same invoice keeps
	the same term across reloads and your blocks don't jump around mid-test. (Once
	a real terms field starts populating due_date, fetch_real_invoices stops
	calling this: credit_days > 0 wins.) doctype/party_group are kept in the
	signature for future per-group tuning but don't affect the spread today.
	"""
	h = int(hashlib.md5((seed or "x").encode("utf-8")).hexdigest(), 16)
	return h % 91  # 0..90 inclusive

def fetch_real_invoices(doctype, base_date_str):
	base_date = datetime.strptime(base_date_str, "%Y-%m-%d").date()
	fields = [
		"name", "posting_date", "due_date", "grand_total",
		"outstanding_amount", "docstatus"
	]
	
	if doctype == "Purchase Invoice":
		fields += ["supplier as party", "supplier_name as party_name", "supplier_group as party_group", "bill_no as ref_no"]
	else:
		fields += ["customer as party", "customer_name as party_name", "customer_group as party_group"]
		
	filters = {
		"docstatus": 1,
		"outstanding_amount": (">", 0)
	}

	# Scope to the active company so a multi-company site doesn't mix books.
	company = frappe.defaults.get_user_default("company") or frappe.db.get_single_value("Global Defaults", "default_company")
	if company:
		filters["company"] = company

	records = frappe.get_all(doctype, filters=filters, fields=fields)
	invoices = []
	for r in records:
		# Calculate synthetic or actual credit terms
		post_date = r.posting_date
		due_date = r.due_date

		credit_days = 0
		if post_date and due_date:
			credit_days = (due_date - post_date).days

		# No real credit term yet (due == posting → "Due on receipt"): assume one
		# from the party group and roll the due date forward so the planner has a
		# realistic forward-looking schedule to work with.
		assumed_term = False
		if credit_days <= 0 and post_date:
			credit_days = assume_credit_days(doctype, r.party_group, r.name)
			due_date = post_date + timedelta(days=credit_days)
			assumed_term = True

		term_str = f"Net {credit_days}" if credit_days > 0 else "Due on receipt"

		# Compute payment status
		age_days = (base_date - due_date).days if due_date else 0
		if age_days > 0:
			payment_status = f"Overdue {age_days}d"
		else:
			payment_status = f"Due in {abs(age_days)}d"
			
		invoices.append({
			"name": r.name,
			"party": r.party_name or r.party,
			"party_id": r.party,
			"party_group": r.party_group or ("OEM Purchase Ledgers" if doctype == "Purchase Invoice" else "Finished Goods Customers"),
			"ref_no": r.get("ref_no") or r.name,
			"bill_date": post_date.strftime("%d-%m-%Y") if post_date else "",
			"credit_term": term_str,
			"final_date": due_date.strftime("%d-%m-%Y") if due_date else "",
			"value": float(r.grand_total or 0),
			"outstanding": float(r.outstanding_amount or 0),
			"payment_status": payment_status,
			"age_days": age_days,
			"is_real": True,
			"assumed_term": assumed_term
		})
	return invoices

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

def get_synthetic_payables(base_date_str):
	# Baseline synthetic suppliers from screenshots
	# Base date is June 3, 2026
	suppliers = [
		{"party": "Franke Faber India Pvt Ltd - Maharashtra", "group": "OEM Purchase Ledgers", "term": "Net 7", "days": 7, "date": "02-04-2026", "value": 6608, "ref": "202531070314"},
		{"party": "Franke Faber India Pvt Ltd - Maharashtra", "group": "OEM Purchase Ledgers", "term": "Net 7", "days": 7, "date": "03-04-2026", "value": 28910, "ref": "202531070310"},
		{"party": "MGP Industries", "group": "Job Work & Contract Processing", "term": "Due on receipt", "days": 0, "date": "10-04-2026", "value": 49383, "ref": "9"},
		{"party": "J Square Pack", "group": "RM - Packaging Materials", "term": "Due on receipt", "days": 0, "date": "13-04-2026", "value": 105168, "ref": "JSP26-27/57"},
		{"party": "Fortune Fasteners", "group": "Statutory, Provisions & Payables", "term": "Net 7", "days": 7, "date": "07-04-2026", "value": 120792, "ref": "FF/26-27/010"},
		{"party": "Fortune Fasteners", "group": "Statutory, Provisions & Payables", "term": "Net 7", "days": 7, "date": "07-04-2026", "value": 65856, "ref": "FF/26-27/011"},
		{"party": "Franke Faber Pvt Ltd", "group": "OEM Purchase Ledgers", "term": "Net 15", "days": 15, "date": "01-04-2026", "value": 30878, "ref": "202581034957"},
		{"party": "Fortune Fasteners", "group": "Statutory, Provisions & Payables", "term": "Net 7", "days": 7, "date": "10-04-2026", "value": 2876, "ref": "FF/26-27/019"},
		{"party": "Fortune Fasteners", "group": "Statutory, Provisions & Payables", "term": "Net 7", "days": 7, "date": "11-04-2026", "value": 3786, "ref": "FF/26-27/026"},
		{"party": "Aadhavan Packers", "group": "RM - Packaging Materials", "term": "Net 15", "days": 15, "date": "17-05-2026", "value": 5000, "ref": "2026-BB077"},
		{"party": "Royal Udyog", "group": "OEM Purchase Ledgers", "term": "Net 30", "days": 30, "date": "02-05-2026", "value": 245000, "ref": "2026-BB171"},
		{"party": "Concept Design Innovation", "group": "OEM Purchase Ledgers", "term": "Net 15", "days": 15, "date": "24-05-2026", "value": 17579, "ref": "CDI-P032"},
		{"party": "Thirumal Fab", "group": "Job Work & Contract Processing", "term": "Net 7", "days": 7, "date": "01-06-2026", "value": 47709, "ref": "TF-P033"},
		{"party": "Thirumal Fab", "group": "Job Work & Contract Processing", "term": "Net 7", "days": 7, "date": "01-06-2026", "value": 36022, "ref": "TF-P034"},
		{"party": "Thirumal Fab", "group": "Job Work & Contract Processing", "term": "Net 7", "days": 7, "date": "02-06-2026", "value": 58989, "ref": "TF-P041"},
		{"party": "AK Engineering", "group": "OEM Purchase Ledgers", "term": "Net 15", "days": 15, "date": "25-05-2026", "value": 204000, "ref": "AK-P047"},
		{"party": "S.P . Industries", "group": "RM - Packaging Materials", "term": "Due on receipt", "days": 0, "date": "02-06-2026", "value": 55357, "ref": "SP-P127"},
		{"party": "Aadhavan Packers", "group": "RM - Packaging Materials", "term": "Net 30", "days": 30, "date": "07-05-2026", "value": 3238, "ref": "2026-BB133"},
		{"party": "Tata Steel Ltd", "group": "RM - Raw Materials", "term": "Net 30", "days": 30, "date": "10-05-2026", "value": 1450000, "ref": "TS-P001"},
		{"party": "JSW Coated", "group": "RM - Raw Materials", "term": "Net 30", "days": 30, "date": "12-05-2026", "value": 850000, "ref": "JSW-P012"},
		{"party": "Reliance Polymers", "group": "RM - Raw Materials", "term": "Net 15", "days": 15, "date": "20-05-2026", "value": 620000, "ref": "RP-P055"},
		{"party": "Bharat Forge", "group": "OEM Purchase Ledgers", "term": "Net 45", "days": 45, "date": "15-04-2026", "value": 1150000, "ref": "BF-P099"},
	]

	base_date = datetime.strptime(base_date_str, "%Y-%m-%d").date()
	invoices = []
	for idx, s in enumerate(suppliers):
		bill_date = datetime.strptime(s["date"], "%d-%m-%Y").date()
		final_date = bill_date + timedelta(days=s["days"])
		
		# Compute payment status
		age_days = (base_date - final_date).days
		if age_days > 0:
			payment_status = f"Overdue {age_days}d"
		else:
			payment_status = f"Due in {abs(age_days)}d"
			
		invoices.append({
			"name": f"ACC-PINV-2026-{idx+1:05d}",
			"party": s["party"],
			"party_id": s["party"].replace(" ", "-").lower(),
			"party_group": s["group"],
			"ref_no": s["ref"],
			"bill_date": bill_date.strftime("%d-%m-%Y"),
			"credit_term": s["term"],
			"final_date": final_date.strftime("%d-%m-%Y"),
			"value": float(s["value"]),
			"outstanding": float(s["value"]), # All synthetic unpaid in full
			"payment_status": payment_status,
			"age_days": age_days,
			"is_real": False
		})
		
	return invoices

def get_synthetic_receivables(base_date_str):
	# Baseline synthetic customers from screenshots
	# Base date is June 3, 2026
	customers = [
		{"party": "MGP Industries", "group": "Supplier Return Parties", "term": "Net 7", "days": 7, "date": "08-04-2026", "value": 136759, "ref": "2026-00013"},
		{"party": "Arrow Links", "group": "Scrap Buyers", "term": "Net 7", "days": 7, "date": "13-04-2026", "value": 19824, "ref": "2026-00041"},
		{"party": "Franke Faber India Pvt Ltd", "group": "Finished Goods Customers", "term": "Net 21", "days": 21, "date": "01-04-2026", "value": 1468711, "ref": "2026-00003"},
		{"party": "S K Enterprises (Tiruvallur)", "group": "Supplier Return Parties", "term": "Due on receipt", "days": 0, "date": "24-04-2026", "value": 15256, "ref": "2026-00054"},
		{"party": "Rishaba Engineering Company", "group": "Component Customers", "term": "Due on receipt", "days": 0, "date": "24-04-2026", "value": 358751, "ref": "2026-00066"},
		{"party": "MGP Industries", "group": "Supplier Return Parties", "term": "Net 7", "days": 7, "date": "18-04-2026", "value": 3437, "ref": "2026-00015"},
		{"party": "Havells India Limited", "group": "Finished Goods Customers", "term": "Net 15", "days": 15, "date": "11-04-2026", "value": 2650143, "ref": "2026-00014"},
		{"party": "Butterfly Gandhimathi Appliances Limited", "group": "Finished Goods Customers", "term": "Net 30", "days": 30, "date": "25-04-2026", "value": 3416000, "ref": "2026-00099"},
		{"party": "Thirumal Fab", "group": "Component Customers", "term": "Net 7", "days": 7, "date": "15-05-2026", "value": 878000, "ref": "2026-00122"},
		{"party": "Hawkins Cookers Limited", "group": "Finished Goods Customers", "term": "Net 15", "days": 15, "date": "20-05-2026", "value": 193560, "ref": "2026-00130"},
		{"party": "Concept Design Innovation", "group": "Finished Goods Customers", "term": "Net 30", "days": 30, "date": "01-05-2026", "value": 193400, "ref": "2026-00105"},
		{"party": "Fortune Fasteners", "group": "Component Customers", "term": "Net 15", "days": 15, "date": "25-05-2026", "value": 136000, "ref": "2026-00115"},
		{"party": "Retail Sales", "group": "Finished Goods Customers", "term": "Due on receipt", "days": 0, "date": "02-06-2026", "value": 74497, "ref": "2026-00199"},
		{"party": "United Trading Company", "group": "Finished Goods Customers", "term": "Net 7", "days": 7, "date": "27-05-2026", "value": 5368, "ref": "2026-00144"},
		{"party": "Versuni India Home Solutions Ltd", "group": "Finished Goods Customers", "term": "Net 30", "days": 30, "date": "05-05-2026", "value": 341000, "ref": "2026-00166"},
		{"party": "Metalcomp Industries", "group": "Finished Goods Customers", "term": "Net 15", "days": 15, "date": "28-05-2026", "value": 48717, "ref": "2026-00188"},
		{"party": "Indcon Manufacturing Private limited", "group": "Finished Goods Customers", "term": "Net 30", "days": 30, "date": "01-05-2026", "value": 154000, "ref": "2026-00212"},
		{"party": "Telmat Materials & Technologies India P Ltd", "group": "Finished Goods Customers", "term": "Net 15", "days": 15, "date": "18-05-2026", "value": 290000, "ref": "2026-00223"},
	]

	base_date = datetime.strptime(base_date_str, "%Y-%m-%d").date()
	invoices = []
	for idx, c in enumerate(customers):
		bill_date = datetime.strptime(c["date"], "%d-%m-%Y").date()
		final_date = bill_date + timedelta(days=c["days"])
		
		# Compute payment status
		age_days = (base_date - final_date).days
		if age_days > 0:
			payment_status = f"Overdue {age_days}d"
		else:
			payment_status = f"Due in {abs(age_days)}d"
			
		invoices.append({
			"name": f"ACC-SINV-2026-{idx+1:05d}",
			"party": c["party"],
			"party_id": c["party"].replace(" ", "-").lower(),
			"party_group": c["group"],
			"ref_no": c["ref"],
			"bill_date": bill_date.strftime("%d-%m-%Y"),
			"credit_term": c["term"],
			"final_date": final_date.strftime("%d-%m-%Y"),
			"value": float(c["value"]),
			"outstanding": float(c["value"]),
			"payment_status": payment_status,
			"age_days": age_days,
			"is_real": False
		})
		
	return invoices


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
