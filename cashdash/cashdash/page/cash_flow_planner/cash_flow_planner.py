import frappe
import json
import os
import re
import csv
import io
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta

try:
	import fcntl  # POSIX advisory file locks (bench runs on Linux/Mac)
except ImportError:  # pragma: no cover - non-POSIX fallback
	fcntl = None

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
	# from a Tally export sqlite. User term overrides (corrected credit terms or
	# one-off date moves) are layered on top per bill.
	bills = load_tally_bills(base_date, config.get("term_overrides", {}))

	# Inject saved review notes / custom amounts. The synthetic arg is now empty:
	# merge_invoices just overlays the persisted overrides onto the real bills.
	payables = merge_invoices(bills["payables"], [], config.get("notes", {}), config.get("custom_amounts", {}), base_date)
	receivables = merge_invoices(bills["receivables"], [], config.get("notes", {}), config.get("custom_amounts", {}), base_date)

	# Group filters are derived from the data so they always match party_group.
	supplier_groups = distinct_groups(payables)
	customer_groups = distinct_groups(receivables)

	# Detect contra parties
	contra_parties = get_contra_parties(payables, receivables)

	# Draft-vs-shared status so the UI can show "someone published after you started"
	# and gate the Publish action with optimistic concurrency.
	shared = _load_shared()
	board_meta = {
		"base_rev": config.get("base_rev", 0),
		"shared_rev": shared.get("rev", 0),
		"behind": shared.get("rev", 0) > config.get("base_rev", 0),
		"published_by": shared.get("published_by"),
		"published_at": shared.get("published_at"),
		"user": frappe.session.user,
	}

	return {
		"payables": payables,
		"receivables": receivables,
		"config": config,
		"supplier_groups": supplier_groups,
		"customer_groups": customer_groups,
		"contra_parties": contra_parties,
		"board_meta": board_meta,
	}

@frappe.whitelist()
def save_planner_data(opening_balance, horizon, scenario, schedules, notes, cc_utilization=0, bd_utilization=0, custom_amounts=None, fragments=None, paid=None, term_overrides=None, origins=None, opening_balance_paise=None):
	"""
	Saves the planner configurations and schedules to a local JSON file.

	`paid` is a planning-only map { invoice_name: true } of bills the user has
	ticked off as paid ON THE BOARD. It is NOT a real payment — no Payment Entry
	is created and no invoice is touched. When omitted (None), the existing paid
	map is preserved so a partial save (e.g. the ledger's note save) can't wipe it.

	`term_overrides` is a map { invoice_name: {...} } of user corrections to a
	bill's credit term (kind="term") or a one-off manual date move (kind="date").
	Like the other optional maps, it's preserved when not passed.

	Writes the CURRENT USER'S PRIVATE DRAFT — never the shared board. Use
	publish_planner() to promote a draft to the shared board everyone sees.
	"""
	def mutate(cfg):
		# Opening cash persists as INTEGER PAISE. Prefer the explicit paise arg; fall
		# back to converting the legacy lakhs float for older clients.
		if opening_balance_paise is not None:
			cfg["opening_balance_paise"] = int(round(float(opening_balance_paise)))
		elif opening_balance is not None:
			cfg["opening_balance_paise"] = int(round(float(opening_balance) * 1e5 * 100))
		cfg.pop("opening_balance", None)
		cfg["horizon"] = horizon
		cfg["scenario"] = scenario
		cfg["schedules"] = json.loads(schedules or "{}")
		cfg["notes"] = json.loads(notes or "{}")
		# Provenance of each placed block ({id: 'user'|'planned'}) so the tag survives
		# a reload. Optional → preserved when not passed.
		if origins is not None:
			cfg["origins"] = json.loads(origins)
		# Optional maps preserve the existing value when not passed, so a partial save
		# from another screen can never silently wipe the draft's working state.
		if custom_amounts is not None:
			cfg["custom_amounts"] = json.loads(custom_amounts)
		if fragments is not None:
			cfg["fragments"] = json.loads(fragments)
		if paid is not None:
			cfg["paid"] = json.loads(paid)
		if term_overrides is not None:
			cfg["term_overrides"] = json.loads(term_overrides)
		cfg["cc_utilization"] = float(cc_utilization or 0)
		cfg["bd_utilization"] = float(bd_utilization or 0)

	cfg = _update_draft(mutate)
	return {"status": "success", "message": "Draft saved", "base_rev": cfg.get("base_rev", 0)}

@frappe.whitelist()
def save_review_note(invoice_name, note=None):
	"""
	Updates ONLY the review note for one invoice in the persisted config.
	The ledger uses this instead of save_planner_data so adding a note never
	touches the planner's schedules / splits / opening balance (data-loss guard).
	"""
	if not invoice_name:
		frappe.throw("invoice_name is required")

	def mutate(cfg):
		notes = cfg.get("notes", {})
		if note:
			notes[invoice_name] = note
		else:
			notes.pop(invoice_name, None)
		cfg["notes"] = notes

	_update_draft(mutate)
	return {"status": "success", "message": "Note saved"}


@frappe.whitelist()
def save_term_override(invoice_name, override=None):
	"""
	Persist (or clear) ONE bill's credit-term override, without touching the rest
	of the planner state — same data-loss guard as save_review_note.

	`override` is a JSON object:
	  {"kind": "term", "days": 45, "term_label": "Net 45"}   # corrected standing term
	  {"kind": "date", "due_date": "29-06-2026"}             # one-off manual date move
	Both carry "edited_at" / "edited_by" for the audit badge. Passing override=None
	(or an empty value) REMOVES the override, reverting the bill to the source term.
	"""
	if not invoice_name:
		frappe.throw("invoice_name is required")

	parsed = None
	if override:
		parsed = json.loads(override) if isinstance(override, str) else override
	if parsed:
		parsed.setdefault("edited_by", frappe.session.user)
		parsed.setdefault("edited_at", frappe.utils.now())

	def mutate(cfg):
		overrides = cfg.get("term_overrides", {})
		if parsed:
			overrides[invoice_name] = parsed
		else:
			overrides.pop(invoice_name, None)
		cfg["term_overrides"] = overrides

	_update_draft(mutate)
	return {"status": "success", "message": "Credit term saved", "override": parsed}


@frappe.whitelist()
def reset_planner_data():
	"""
	Resets the CURRENT USER'S draft to the shared board (drops their draft file so
	the next load re-forks from what is published). Never touches the shared board
	or other users' drafts.
	"""
	path = _draft_path()
	if os.path.exists(path):
		os.remove(path)
	return {"status": "success", "message": "Draft reset to the shared board"}


@frappe.whitelist()
def discard_draft():
	"""
	Re-forks the current user's draft from the latest shared board, discarding their
	unpublished draft changes. Used to resolve a publish conflict by taking 'theirs'.
	"""
	shared = _load_shared()
	cfg = _board_only(shared)
	cfg["base_rev"] = shared.get("rev", 0)
	_atomic_write_json(_draft_path(), cfg)
	return {"status": "success", "base_rev": cfg["base_rev"]}


@frappe.whitelist()
def publish_planner(force=0):
	"""
	Promote the current user's draft to the SHARED board everyone sees.

	Optimistic concurrency: succeeds only if the draft's base_rev still equals the
	shared rev (nobody published since this user forked). Otherwise returns
	{"status": "conflict", ...} so the UI can offer reload-or-force rather than
	silently overwriting the other user's work. `force=1` overwrites regardless.

	The whole shared write is flock-serialised + atomic, so two simultaneous
	publishes can't corrupt the file or both 'win'.
	"""
	force = int(force or 0)
	draft = _load_draft()
	draft_base = int(draft.get("base_rev", 0))
	spath = get_config_file_path()

	with _file_lock(spath):
		shared = _read_json(spath) or {}
		cur_rev = int(shared.get("rev", 0))
		if not force and draft_base != cur_rev:
			return {
				"status": "conflict",
				"shared_rev": cur_rev,
				"base_rev": draft_base,
				"published_by": shared.get("published_by"),
				"published_at": shared.get("published_at"),
			}
		new_rev = max(cur_rev, draft_base) + 1
		new_shared = _board_only(draft)
		new_shared.update({
			"rev": new_rev,
			"published_by": frappe.session.user,
			"published_at": frappe.utils.now(),
			# Preserve the global named-plan library across publishes.
			"saved_plans": shared.get("saved_plans", {}),
		})
		_atomic_write_json(spath, new_shared)

	# Advance the draft's base_rev so the user can keep editing and publish again.
	_update_draft(lambda cfg: cfg.__setitem__("base_rev", new_rev))
	return {"status": "success", "rev": new_rev, "published_by": frappe.session.user}

# ======================================================================
#  Persistence — shared board + per-user private drafts, on HARDENED files
#  -------------------------------------------------------------------
#  The old design was a single global JSON with unlocked read-modify-write, so
#  two Accounts users silently clobbered each other (last write wins) and a crash
#  mid-write could truncate the file for everyone. Now:
#
#   • Each user edits a PRIVATE DRAFT file — no cross-user contention while editing.
#   • One SHARED BOARD file (the original filename, for back-compat) is the published
#     source of truth, carrying a monotonic `rev`.
#   • PUBLISH promotes a draft → shared, but only if the draft's base_rev still equals
#     the shared rev (optimistic lock). If someone published in between → CONFLICT,
#     surfaced to the user (reload or force) instead of silently overwriting.
#   • Every write is flock()-serialized and atomic (temp file + os.replace), so
#     readers never see a half-written file and a crash leaves the prior file intact.
#   • Named plans live in the shared file = one global plan library.
# ======================================================================

# Board fields a draft/shared snapshot carries (everything except meta + saved_plans).
# Money is INTEGER PAISE on the wire too: opening cash persists as opening_balance_paise.
# `origins` records HOW each placed block got there ({id: 'user'|'planned'}) so the
# provenance tag survives a reload/publish instead of collapsing to 'auto'.
BOARD_KEYS = (
	"opening_balance_paise", "horizon", "scenario", "schedules", "origins", "notes",
	"custom_amounts", "fragments", "paid", "term_overrides",
	"cc_utilization", "bd_utilization",
)


def _planner_dir():
	site_path = frappe.get_site_path("private", "files")
	if not os.path.exists(site_path):
		os.makedirs(site_path)
	return site_path


def get_config_file_path():
	"""Path to the SHARED board file (kept at the original name for back-compat)."""
	return os.path.join(_planner_dir(), "cash_flow_planner_data.json")


def _draft_path(user=None):
	"""Per-user private draft file. The username is sanitised for the filename."""
	user = user or frappe.session.user or "guest"
	safe = re.sub(r"[^A-Za-z0-9._-]", "_", user)
	return os.path.join(_planner_dir(), "cash_flow_planner_draft__%s.json" % safe)


@contextmanager
def _file_lock(path):
	"""Advisory exclusive lock for a read-modify-write on `path`. Uses a sidecar
	`.lock` file so the lock is independent of the atomic-replace of the data file.
	A no-op (best effort) where fcntl is unavailable."""
	if fcntl is None:
		yield
		return
	lock_path = path + ".lock"
	f = open(lock_path, "w")
	try:
		fcntl.flock(f, fcntl.LOCK_EX)
		yield
	finally:
		try:
			fcntl.flock(f, fcntl.LOCK_UN)
		finally:
			f.close()


def _atomic_write_json(path, data):
	"""Write JSON to a temp file in the same dir, fsync, then os.replace() onto the
	target — an atomic rename. A reader never sees a partial file, and a crash
	mid-write leaves the previous good file intact (no torn/truncated JSON)."""
	fd, tmp = tempfile.mkstemp(prefix=".cfp_", suffix=".tmp", dir=os.path.dirname(path))
	try:
		with os.fdopen(fd, "w") as f:
			json.dump(data, f, indent=4)
			f.flush()
			os.fsync(f.fileno())
		os.replace(tmp, path)
	except Exception:
		try:
			os.remove(tmp)
		except OSError:
			pass
		raise


def _read_json(path):
	try:
		with open(path, "r") as f:
			return json.load(f)
	except (OSError, ValueError):
		return None


def _default_board():
	return {
		"opening_balance_paise": int(80 * 1e5 * 100),  # ₹80.00L of opening cash, in paise
		"horizon": "6 wks",
		"scenario": "Realistic",
		# No seeded schedules/notes: they keyed off the old synthetic ACC-* invoice
		# names and would never match the real TLY-* bills. The board starts empty
		# and the user schedules real bills onto weeks themselves.
		"schedules": {}, "origins": {}, "notes": {}, "custom_amounts": {}, "fragments": {},
		"paid": {}, "term_overrides": {}, "cc_utilization": 0, "bd_utilization": 0,
	}


def _normalize_board(cfg):
	"""Migrate a legacy board in place and backfill missing keys with defaults.
	Legacy: opening_balance (lakhs float) → opening_balance_paise (integer paise)."""
	if "opening_balance_paise" not in cfg and "opening_balance" in cfg:
		try:
			cfg["opening_balance_paise"] = int(round(float(cfg["opening_balance"]) * 1e5 * 100))
		except (TypeError, ValueError):
			cfg["opening_balance_paise"] = _default_board()["opening_balance_paise"]
	cfg.pop("opening_balance", None)
	for k, v in _default_board().items():
		cfg.setdefault(k, v)
	return cfg


def _board_only(cfg):
	"""Extract just the board fields (drop rev / base_rev / saved_plans / meta)."""
	base = _default_board()
	for k in BOARD_KEYS:
		if k in cfg:
			base[k] = cfg[k]
	return base


def _load_shared():
	"""The published shared board. Seeds a default at rev 0 the first time. An old
	single-file config without `rev` is adopted in place as rev 0 (graceful migration)."""
	path = get_config_file_path()
	cfg = _read_json(path)
	if cfg is None:
		with _file_lock(path):
			cfg = _read_json(path)            # re-check under lock (lost-seed race)
			if cfg is None:
				cfg = _board_only({})
				cfg.update({"rev": 0, "published_by": None, "published_at": None, "saved_plans": {}})
				_atomic_write_json(path, cfg)
	cfg.setdefault("rev", 0)
	cfg.setdefault("saved_plans", {})
	_normalize_board(cfg)
	return cfg


def _load_draft(user=None):
	"""This user's private working draft. Forks from the shared board the first time
	so a new user starts from what is currently published."""
	path = _draft_path(user)
	cfg = _read_json(path)
	if cfg is None:
		shared = _load_shared()
		cfg = _board_only(shared)
		cfg["base_rev"] = shared.get("rev", 0)
		_atomic_write_json(path, cfg)
	cfg.setdefault("base_rev", 0)
	_normalize_board(cfg)
	return cfg


def _update_draft(mutate):
	"""Locked, atomic read-modify-write of the current user's draft. `mutate(cfg)`
	edits the board dict in place. Serialises a user's own concurrent tabs and can
	never tear the file."""
	path = _draft_path()
	with _file_lock(path):
		cfg = _read_json(path)
		if cfg is None:                        # fork from shared on first touch
			shared = _load_shared()
			cfg = _board_only(shared)
			cfg["base_rev"] = shared.get("rev", 0)
		cfg.setdefault("base_rev", 0)
		_normalize_board(cfg)
		mutate(cfg)
		_atomic_write_json(path, cfg)
	return cfg


def load_persisted_config():
	"""Back-compat accessor: 'the board the current user is editing' = their draft."""
	return _load_draft()

def get_bill_data_path():
	"""Path to the committed extract of real outstanding bills."""
	return frappe.get_app_path("cashdash", "data", "tally_bills.json")


def distinct_groups(rows):
	"""Sorted distinct party_group values present in the given bills. The ledger
	JS prepends its own 'All groups' option, so this returns only the real groups."""
	return sorted({r.get("party_group") for r in rows if r.get("party_group")})


def load_tally_bills(base_date_str, term_overrides=None):
	"""Load the real outstanding bills from data/tally_bills.json and recompute the
	time-relative fields (age_days, payment_status) against base_date. Returns
	{"payables": [...], "receivables": [...]} in the planner's invoice dict shape.

	The data file is produced by importer/import_tally_bills.py from a Tally export
	and carries real per-bill credit terms (e.g. "Net 45") and due dates — replacing
	the old hash-assumed terms. Missing file => empty board (no synthetic fallback).

	`term_overrides` (keyed by bill name) layers user corrections on top of the
	source term/date. Overrides are applied BEFORE the age/overdue math so a
	corrected term or a moved date immediately drives the overdue pills.
	"""
	base_date = datetime.strptime(base_date_str, "%Y-%m-%d").date()
	term_overrides = term_overrides or {}
	path = get_bill_data_path()
	if not os.path.exists(path):
		return {"payables": [], "receivables": []}

	with open(path, "r") as f:
		raw = json.load(f)

	def hydrate(rows):
		out = []
		for r in rows:
			item = dict(r)
			item["party_id"] = r.get("party_id") or r.get("party")
			# Money is carried as INTEGER PAISE end to end (₹1 = 100). The frontend
			# reads value_paise / outstanding_paise and never re-parses a rupee float,
			# so a long chain of sums can't drift. _coerce_paise tolerates a legacy
			# data file that still has rupee floats under value / outstanding.
			item["value_paise"] = _coerce_paise(r.get("value_paise"), r.get("value"))
			item["outstanding_paise"] = _coerce_paise(r.get("outstanding_paise"), r.get("outstanding"))
			item.setdefault("is_real", True)

			# Layer the user's term/date correction (if any) onto credit_term /
			# final_date and stamp the provenance flags the UI badges off of.
			_apply_term_override(item, term_overrides.get(item.get("name")))

			# Overdue math runs on the EFFECTIVE final_date (post-override).
			final_date = _parse_ddmmyyyy(item.get("final_date"))
			age_days = (base_date - final_date).days if final_date else 0
			item["age_days"] = age_days
			item["payment_status"] = f"Overdue {age_days}d" if age_days > 0 else f"Due in {abs(age_days)}d"
			out.append(item)
		return out

	return {
		"payables": hydrate(raw.get("payables", [])),
		"receivables": hydrate(raw.get("receivables", [])),
	}


def _apply_term_override(item, ov):
	"""Mutate one hydrated bill dict to reflect its credit-term provenance and any
	user override. Always sets:
	  - term_verified  : True when the SOURCE term was matched in Tally (not a
	                     "Due on receipt" fallback).
	  - term_unverified: convenience inverse the UI badges off of (an override that
	                     confirms/sets the term clears it).
	When an override exists, also sets credit_term / final_date to the corrected
	values and records term_edited ("term" | "date") plus the pre-override
	original_term / original_due and edit metadata for the audit badge.
	"""
	source_term = item.get("credit_term")
	source_due = item.get("final_date")
	# Source provenance: prefer the importer's explicit flag; fall back to the
	# "Due on receipt" sentinel for a legacy data file without it.
	verified = item.get("term_verified")
	if verified is None:
		verified = source_term not in (None, "", "Due on receipt")
	item["term_verified"] = bool(verified)
	item["term_unverified"] = not item["term_verified"]
	item["term_edited"] = None

	if not ov:
		return

	kind = ov.get("kind")
	item["original_term"] = source_term
	item["original_due"] = source_due
	item["term_edited_at"] = ov.get("edited_at")
	item["term_edited_by"] = ov.get("edited_by")

	if kind == "term":
		days = int(ov.get("days") or 0)
		label = ov.get("term_label") or ("Net %d" % days if days else "Due on receipt")
		item["credit_term"] = label
		bill_date = _parse_ddmmyyyy(item.get("bill_date"))
		if days and bill_date:
			item["final_date"] = (bill_date + timedelta(days=days)).strftime("%d-%m-%Y")
		elif bill_date:
			item["final_date"] = bill_date.strftime("%d-%m-%Y")   # Due on receipt → bill date
		# A user-set term is, by definition, verified now.
		item["term_verified"] = True
		item["term_unverified"] = False
		item["term_edited"] = "term"
	elif kind == "date":
		# One-off: the credit term label is left as-is; only this bill's date moves.
		if ov.get("due_date"):
			item["final_date"] = ov["due_date"]
		item["term_edited"] = "date"


def _coerce_paise(paise_val, rupee_val=None):
	"""Return integer paise. Prefer an already-paise value; fall back to converting a
	legacy rupee float (round to the nearest paisa). Empty/None -> 0."""
	if paise_val not in (None, ""):
		try:
			return int(round(float(paise_val)))
		except (TypeError, ValueError):
			return 0
	if rupee_val in (None, ""):
		return 0
	try:
		return int(round(float(rupee_val) * 100))
	except (TypeError, ValueError):
		return 0


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
			# Custom override stored as rupees historically; normalise to integer paise.
			item["outstanding_paise"] = _coerce_paise(None, saved_amounts[name])
			
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
	Snapshots the current user's DRAFT board as a named plan in the SHARED, global
	plan library (so any Accounts user can load it later). Does not publish to the
	live shared board. The shared write is flock-serialised + atomic.
	"""
	if not plan_name or not plan_name.strip():
		frappe.throw("Plan name is required")

	plan_name = plan_name.strip()
	draft = _load_draft()
	snapshot = _board_only(draft)
	snapshot["saved_at"] = datetime.now().isoformat()
	snapshot["saved_by"] = frappe.session.user

	_load_shared()  # ensure the shared file exists before we lock + edit it
	spath = get_config_file_path()
	with _file_lock(spath):
		shared = _read_json(spath) or {}
		shared.setdefault("saved_plans", {})[plan_name] = snapshot
		_atomic_write_json(spath, shared)

	return {"status": "success", "message": f"Plan '{plan_name}' saved successfully"}


@frappe.whitelist()
def load_named_plan(plan_name):
	"""
	Loads and returns the data for a previously saved named plan from the shared
	library.
	"""
	if not plan_name or not plan_name.strip():
		frappe.throw("Plan name is required")

	plan_name = plan_name.strip()
	saved_plans = _load_shared().get("saved_plans", {})

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
	_load_shared()
	spath = get_config_file_path()
	with _file_lock(spath):
		shared = _read_json(spath) or {}
		saved_plans = shared.get("saved_plans", {})
		if plan_name not in saved_plans:
			frappe.throw(f"Plan '{plan_name}' not found")
		del saved_plans[plan_name]
		shared["saved_plans"] = saved_plans
		_atomic_write_json(spath, shared)

	return {"status": "success", "message": f"Plan '{plan_name}' deleted successfully"}


@frappe.whitelist()
def list_named_plans():
	"""
	Returns a list of saved plan names (from the shared library) with their timestamps.
	"""
	saved_plans = _load_shared().get("saved_plans", {})

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
		"Final Date", "Value", "Outstanding", "Scheduled To", "Type", "Status", "Paid (planned)",
		"Term Source"
	])

	def rupees(paise):
		# Render integer paise as a plain rupee amount (2 dp) for the CSV.
		return "%.2f" % ((_coerce_paise(paise) or 0) / 100.0)

	def term_source(inv):
		# Provenance of the Credit Term cell, so an export shows what's trustworthy.
		if inv.get("term_edited") == "term":
			return "Edited (term, was %s)" % (inv.get("original_term") or "?")
		if inv.get("term_edited") == "date":
			return "Edited (one-off date, was %s)" % (inv.get("original_due") or "?")
		return "Verified" if inv.get("term_verified") else "Unverified"

	def write_rows(rows, kind):
		for inv in rows:
			name = inv.get("name", "")
			writer.writerow([
				inv.get("party", ""), name, inv.get("ref_no", ""),
				inv.get("bill_date", ""), inv.get("credit_term", ""), inv.get("final_date", ""),
				rupees(inv.get("value_paise")), rupees(inv.get("outstanding_paise")),
				sched.get(name, ""), kind, inv.get("payment_status", ""),
				"Yes" if paid_map.get(name) else "",
				term_source(inv)
			])

	write_rows(payables, "Payable")
	write_rows(receivables, "Receivable")

	csv_content = output.getvalue()
	output.close()
	return csv_content
