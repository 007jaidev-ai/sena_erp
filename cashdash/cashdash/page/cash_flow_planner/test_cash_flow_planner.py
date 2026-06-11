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
		# Snapshot the real config so tests never clobber a user's saved board.
		self.cfg_path = cfp.get_config_file_path()
		self.had = os.path.exists(self.cfg_path)
		if self.had:
			shutil.copy(self.cfg_path, self.cfg_path + ".test_bak")

	def tearDown(self):
		if self.had:
			shutil.move(self.cfg_path + ".test_bak", self.cfg_path)
		elif os.path.exists(self.cfg_path):
			os.remove(self.cfg_path)

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
		self.assertEqual(c["opening_balance"], 120.0, "opening balance reset")
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


if __name__ == "__main__":
	# Allow running directly: ./env/bin/python .../test_cash_flow_planner.py <site>
	import sys
	site = sys.argv[1] if len(sys.argv) > 1 else "avinash.localhost"
	sites_path = sys.argv[2] if len(sys.argv) > 2 else "/home/jaidev/Desktop/frappebuilds/bench/sites"
	frappe.init(site=site, sites_path=sites_path)
	frappe.connect()
	unittest.main(argv=[sys.argv[0]])
