import frappe
import json
import os
from datetime import datetime, timedelta

@frappe.whitelist()
def get_planner_data(base_date="2026-06-03"):
	"""
	Returns a dictionary containing:
	- payables: list of purchase invoices
	- receivables: list of sales invoices
	- config: saved planner settings (opening balance, horizon, scenario, schedules, notes)
	- supplier_groups: list of supplier group names
	- customer_groups: list of customer group names
	"""
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

	return {
		"payables": payables,
		"receivables": receivables,
		"config": config,
		"supplier_groups": supplier_groups,
		"customer_groups": customer_groups
	}

@frappe.whitelist()
def save_planner_data(opening_balance, horizon, scenario, schedules, notes, cc_utilization=0, bd_utilization=0, custom_amounts=None):
	"""
	Saves the planner configurations and schedules to a local JSON file.
	"""
	config_path = get_config_file_path()
	data = {
		"opening_balance": float(opening_balance or 0),
		"horizon": horizon,
		"scenario": scenario,
		"schedules": json.loads(schedules or "{}"),
		"notes": json.loads(notes or "{}"),
		"custom_amounts": json.loads(custom_amounts or "{}"),
		"cc_utilization": float(cc_utilization or 0),
		"bd_utilization": float(bd_utilization or 0)
	}
	
	with open(config_path, "w") as f:
		json.dump(data, f, indent=4)
		
	return {"status": "success", "message": "Planner state saved successfully"}

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
		"cc_utilization": 0,
		"bd_utilization": 0
	}

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
	
	records = frappe.get_all(doctype, filters=filters, fields=fields)
	invoices = []
	for r in records:
		# Calculate synthetic or actual credit terms
		post_date = r.posting_date
		due_date = r.due_date
		
		credit_days = 0
		if post_date and due_date:
			credit_days = (due_date - post_date).days
			
		term_str = f"Net {credit_days}" if credit_days > 0 else "Due on receipt"
		
		# Compute payment status
		age_days = (base_date - due_date).days
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
			"value": float(r.grand_total),
			"outstanding": float(r.outstanding_amount),
			"payment_status": payment_status,
			"age_days": age_days,
			"is_real": True
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


