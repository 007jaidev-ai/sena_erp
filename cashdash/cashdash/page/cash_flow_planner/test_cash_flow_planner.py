"""
Tests for the Cash Flow Planner backend.

Run with:  bench --site <site> run-tests --module \
  cashdash.cashdash.page.cash_flow_planner.test_cash_flow_planner

These cover the financial-safety invariants and regressions for the data-loss
bugs fixed in this module (C1: partial saves must not wipe planner state).
"""
import json
import os
import shutil
import unittest

import frappe

from cashdash.cashdash.page.cash_flow_planner import cash_flow_planner as cfp


class TestCashFlowPlanner(unittest.TestCase):
	def setUp(self):
		# Snapshot the shared board AND this user's draft (saves write the draft now),
		# so tests never clobber a real user's board. Extra draft files created by
		# multi-user tests are tracked in _extra_drafts and removed in tearDown.
		self._paths = [cfp.get_config_file_path(), cfp._draft_path()]
		self._extra_drafts = []
		self._snap = {}
		for p in self._paths:
			self._snap[p] = os.path.exists(p)
			if self._snap[p]:
				shutil.copy(p, p + ".test_bak")
			elif os.path.exists(p):
				os.remove(p)

	def tearDown(self):
		for p in self._paths:
			if self._snap.get(p):
				shutil.move(p + ".test_bak", p)
			elif os.path.exists(p):
				os.remove(p)
		for p in self._extra_drafts:
			if os.path.exists(p):
				os.remove(p)

	def _as_user(self, user):
		"""Switch the acting user and ensure their draft is cleaned up afterwards."""
		frappe.set_user(user)
		self.addCleanup(frappe.set_user, "Administrator")
		dp = cfp._draft_path(user)
		if dp not in self._paths and dp not in self._extra_drafts:
			self._extra_drafts.append(dp)
		return dp

	# ---- real bills load from the committed data file with real credit terms ----
	def test_load_tally_bills_returns_real_terms(self):
		bills = cfp.load_tally_bills("2026-06-09")
		rows = bills["payables"] + bills["receivables"]
		self.assertTrue(rows, "no bills loaded from data/tally_bills.json")
		# Every bill carries a real credit term string and a stable TLY-* id.
		for r in rows:
			self.assertTrue(r["name"].startswith("TLY-"))
			self.assertIn("credit_term", r)
			self.assertNotIn("assumed_term", r)  # the hash-assumed term is gone
		# At least some bills have a real "Net N" term (not all "Due on receipt").
		self.assertTrue(any(r["credit_term"].startswith("Net ") for r in rows))

	# ---- C1 regression: a notes-only save must NOT wipe the planner ----
	def test_save_review_note_preserves_planner_state(self):
		cfp.save_planner_data(
			opening_balance=120, horizon="8 wks", scenario="Realistic",
			schedules=json.dumps({"ACC-PINV-2026-00001": "2026-06-15"}),
			notes="{}",
			custom_amounts=json.dumps({"ACC-PINV-2026-00002": 9999}),
			fragments=json.dumps({"ACC-PINV-2026-00001": {"ceil": 100, "pieces": []}}),
			paid=json.dumps({"ACC-PINV-2026-00003": True}),
		)
		cfp.save_review_note("ACC-PINV-2026-00001", "cheque 5521")
		c = cfp.load_persisted_config()
		self.assertEqual(len(c["schedules"]), 1, "schedules wiped by a note save")
		self.assertEqual(len(c["custom_amounts"]), 1, "custom_amounts wiped")
		self.assertEqual(len(c["fragments"]), 1, "fragments/splits wiped")
		# Opening cash persists as integer paise (120 lakhs = ₹1,20,00,000 = 1.2e9 paise).
		self.assertEqual(c["opening_balance_paise"], 1_200_000_000, "opening balance reset")
		self.assertEqual(c["horizon"], "8 wks", "horizon reset")
		self.assertEqual(c["notes"]["ACC-PINV-2026-00001"], "cheque 5521")

	# ---- C1 regression: a partial save_planner_data must preserve omitted maps ----
	def test_partial_save_preserves_omitted_maps(self):
		cfp.save_planner_data(
			opening_balance=100, horizon="6 wks", scenario="Realistic",
			schedules="{}", notes="{}",
			custom_amounts=json.dumps({"A": 5}),
			fragments=json.dumps({"B": {"ceil": 1}}),
			paid=json.dumps({"C": True}),
		)
		# A later save that omits the optional maps must not erase them.
		cfp.save_planner_data(
			opening_balance=100, horizon="6 wks", scenario="Realistic",
			schedules="{}", notes="{}",
		)
		c = cfp.load_persisted_config()
		self.assertEqual(c["custom_amounts"], {"A": 5})
		self.assertEqual(c["fragments"], {"B": {"ceil": 1}})
		self.assertEqual(c["paid"], {"C": True})

	# ---- CSV reflects the live board state passed from the screen ----
	def test_csv_uses_live_schedules_and_paid(self):
		# Pick a real bill name from the loaded data so the test tracks the actual
		# invoice ids the planner serves (TLY-*), not a hardcoded synthetic one.
		data = cfp.get_planner_data(base_date="2026-06-09")
		rows = data["payables"] + data["receivables"]
		self.assertTrue(rows, "no bills loaded from data/tally_bills.json")
		name = rows[0]["name"]
		csv_out = cfp.export_planner_csv(
			base_date="2026-06-09",
			schedules=json.dumps({name: "2026-06-20"}),
			paid=json.dumps({name: True}),
		)
		self.assertIn("Paid (planned)", csv_out)
		# the scheduled date + paid flag from the live state should appear on the row
		line = [ln for ln in csv_out.splitlines() if name in ln]
		self.assertTrue(line, "invoice row missing from CSV")
		self.assertIn("2026-06-20", line[0])
		self.assertIn("Yes", line[0])

	# ---- provenance + opening cash persist (and as integer paise) ----
	def test_origins_and_opening_paise_round_trip(self):
		cfp.save_planner_data(
			opening_balance_paise=990_000_000,  # ₹99,00,000
			opening_balance=99,                 # legacy lakhs also sent; paise wins
			horizon="6 wks", scenario="Realistic", schedules="{}", notes="{}",
			origins=json.dumps({"TLY-P-00001": "user", "TLY-P-00002": "planned"}),
		)
		c = cfp.load_persisted_config()
		self.assertEqual(c["opening_balance_paise"], 990_000_000)
		self.assertNotIn("opening_balance", c, "legacy lakhs key should be dropped")
		self.assertEqual(c["origins"]["TLY-P-00001"], "user")
		self.assertEqual(c["origins"]["TLY-P-00002"], "planned")

	# ---- concurrency: per-user drafts isolate edits (no silent clobber) ----
	def test_drafts_are_per_user_isolated(self):
		self._as_user("Administrator")
		cfp.save_planner_data(99, "6 wks", "Realistic", "{}", "{}")
		self._as_user("Guest")
		cfp.save_planner_data(50, "6 wks", "Realistic", "{}", "{}")
		# Each user reads back their own draft, untouched by the other.
		self._as_user("Guest")
		self.assertEqual(cfp.load_persisted_config()["opening_balance"], 50.0)
		self._as_user("Administrator")
		self.assertEqual(cfp.load_persisted_config()["opening_balance"], 99.0)

	# ---- publish: optimistic lock turns a clobber into a surfaced conflict ----
	def test_publish_optimistic_conflict(self):
		# Reset the shared board to a known empty state for a deterministic rev.
		shared_path = cfp.get_config_file_path()
		cfp._atomic_write_json(shared_path, dict(cfp._board_only({}), rev=0, saved_plans={}))

		self._as_user("Administrator")
		cfp.discard_draft()  # fork at rev 0
		self._as_user("Guest")
		cfp.discard_draft()  # fork at rev 0

		# Admin publishes first → shared rev 1.
		self._as_user("Administrator")
		cfp.save_planner_data(99, "6 wks", "Realistic", "{}", "{}")
		r = cfp.publish_planner()
		self.assertEqual(r["status"], "success")
		self.assertEqual(r["rev"], 1)

		# Guest, still based on rev 0, must get a CONFLICT — not a silent overwrite.
		self._as_user("Guest")
		cfp.save_planner_data(50, "6 wks", "Realistic", "{}", "{}")
		r = cfp.publish_planner()
		self.assertEqual(r["status"], "conflict")
		self.assertEqual(r["shared_rev"], 1)
		# Shared board is still Admin's 99 — Guest did not clobber it.
		self.assertEqual(cfp._load_shared()["opening_balance"], 99.0)

		# Force publish resolves it → rev 2 = Guest's 50.
		r = cfp.publish_planner(force=1)
		self.assertEqual(r["status"], "success")
		self.assertEqual(r["rev"], 2)
		self.assertEqual(cfp._load_shared()["opening_balance"], 50.0)

	# ---- hardening: concurrent locked writers never lose an update or tear the file ----
	def test_file_lock_serializes_writers(self):
		import threading
		path = os.path.join(cfp._planner_dir(), "cfp_test_counter.json")
		self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
		cfp._atomic_write_json(path, {"n": 0})

		def worker():
			for _ in range(100):
				with cfp._file_lock(path):
					cur = cfp._read_json(path) or {"n": 0}
					cur["n"] += 1
					cfp._atomic_write_json(path, cur)

		threads = [threading.Thread(target=worker) for _ in range(8)]
		[t.start() for t in threads]
		[t.join() for t in threads]
		self.assertEqual(cfp._read_json(path)["n"], 800, "lost update — lock failed")


if __name__ == "__main__":
	# Allow running directly: ./env/bin/python .../test_cash_flow_planner.py <site>
	import sys
	site = sys.argv[1] if len(sys.argv) > 1 else "avinash.localhost"
	sites_path = sys.argv[2] if len(sys.argv) > 2 else "/home/jaidev/Desktop/frappebuilds/bench/sites"
	frappe.init(site=site, sites_path=sites_path)
	frappe.connect()
	unittest.main(argv=[sys.argv[0]])
