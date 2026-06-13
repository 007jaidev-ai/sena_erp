frappe.provide('frappe.pages');

frappe.pages['cash-flow-planner'] = frappe.pages['cash-flow-planner'] || {};
frappe.pages['cash-flow-planner'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Cash Flow Planner',
		single_column: true
	});
	wrapper.cash_flow_planner = new CashFlowPlanner(wrapper, page);
};
frappe.pages['cash_flow_planner'] = frappe.pages['cash-flow-planner'];

/* ============================================================
   Cash Flow Planner — high-fidelity redesign (handoff port)
   Year → Month → Week DFS calendar, three block states,
   consolidated Plan ▾ toolbar, single status strip + facilities,
   collapsible side-by-side ledger. Vanilla JS + jQuery.
   ============================================================ */

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// MONEY UNIT: every amount on a block (b.amountP), the opening cash (this.openingP),
// column/KPI sums, and these limits are SIGNED INTEGER PAISE (₹1 = 100). Floats are
// used only at the display edge (fmtShort) and the lakhs toolbar input. Keeping money
// integer means a long chain of edits and sums can never drift a paisa in or out.
var PAISE = 100;
var CC_LIMIT = 6e7 * PAISE, BD_LIMIT = 4e7 * PAISE, SOFT = 0.8;   // ₹6Cr / ₹4Cr in paise
var HIGH_VALUE_P = 5e5 * PAISE;                                   // "high value" ≥ ₹5L, in paise
var _NOW = new Date();
var TODAY = new Date(_NOW.getFullYear(), _NOW.getMonth(), _NOW.getDate());   // real today (local midnight)
function _mondayOnOrBefore(d) { var x = new Date(d); var wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); x.setHours(0, 0, 0, 0); return x; }
var HORIZON_START = _mondayOnOrBefore(TODAY);      // Monday of the current week

class CashFlowPlanner {
	constructor(wrapper, page) {
		this.wrapper = $(wrapper);
		this.page = page;
		this.base_date = TODAY.getFullYear() + '-' + String(TODAY.getMonth() + 1).padStart(2, '0') + '-' + String(TODAY.getDate()).padStart(2, '0');

		this.blocks = [];
		this.openingP = 80 * 1e5 * PAISE;   // ₹80L of opening cash, in paise
		this.horizonWeeks = 6;
		this.view = { level: 'month', year: 2026, month: 5, weekStart: new Date(HORIZON_START), day: null };
		this.past = [];
		this.future = [];
		this.search = { pay: '', rec: '' };
		this.filters = { pay: { priority: false, highValue: false, overdue: false }, rec: { priority: false, highValue: false, overdue: false } };
		this.openFolders = {};
		this.ledgerOpen = true;
		this.planOpen = false;
		this.moreOpen = false;
		// Multi-sort: an ordered list per side. Array order = priority. Each entry
		// carries a `step` (1=asc, 2=desc, 3=asc, 4→removed) for the click cycle.
		this.ledgerSort = { pay: [{ column: 'final', direction: 'asc', step: 1 }], rec: [{ column: 'final', direction: 'asc', step: 1 }] };
		this.contra = {};
		this.notes = {};
		this.dragId = null;
		this.cols = [];

		// Curtain panels + focus mode
		this.payOpen = true;
		this.recOpen = true;
		this.focusMode = false;
		// Each reservoir panel has two collapsible sections: Upcoming (unscheduled,
		// soonest-first) and Scheduled (already-placed, greyed). And per-column
		// same-entity groups can be expanded inline in the timeline.
		this.resSec = { pay: { up: true, sch: false }, rec: { up: true, sch: false } };
		this.openColGroups = {};

		// Partial-payment splitting: each block carries a parentId (the original
		// invoice); familyCeil[parentId] is the conserved total all its pieces must
		// always sum to. _pieceSeq names new split pieces deterministically.
		this.familyCeil = {};
		this._pieceSeq = 0;

		// Persisted credit-term corrections / one-off date moves, keyed by invoice id.
		this.termOverrides = {};
		// Persisted block provenance { id: 'user'|'planned' } so the tag survives a
		// reload (a restored placement with no entry here defaults to 'auto').
		this.origins = {};

		// Draft-vs-shared concurrency state. You edit a PRIVATE draft; Publish promotes
		// it to the shared board (optimistic-locked on baseRev vs sharedRev).
		this.baseRev = 0; this.sharedRev = 0; this.behind = false;
		this.publishedBy = null; this.publishedAt = null;

		this.init();
	}

	init() {
		this.page.main.html(frappe.render_template('cash_flow_planner', {}));
		this.$root = this.wrapper.find('#cfp-root');
		this.bind_events();
		this.load_data();
	}

	/* ============================ DATA ============================ */
	load_data() {
		var me = this;
		me.showStatus('loading', 'Loading planner…');
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.get_planner_data',
			args: { base_date: this.base_date },
			error: function() {
				me.showStatus('error', 'Couldn’t load the board. The server may be busy or an invoice is missing a total.');
			},
			callback: function(r) {
				var d = r.message || {};
				(d.contra_parties || []).forEach(p => me.contra[p] = true);
				// Draft/shared concurrency status for the Publish flow.
				var bm = d.board_meta || {};
				me.baseRev = bm.base_rev || 0; me.sharedRev = bm.shared_rev || 0;
				me.behind = !!bm.behind; me.publishedBy = bm.published_by || null; me.publishedAt = bm.published_at || null;
				me.notes = (d.config && d.config.notes) || {};
				// Opening cash is integer paise on the wire (legacy lakhs float tolerated).
				if (d.config && d.config.opening_balance_paise != null) me.openingP = Math.round(parseFloat(d.config.opening_balance_paise));
				else if (d.config && d.config.opening_balance != null) me.openingP = Math.round(parseFloat(d.config.opening_balance) * 1e5 * PAISE);
				if (d.config && d.config.horizon) me.horizonWeeks = parseInt(d.config.horizon) || 6;

				// Persisted credit-term overrides — applied server-side already (the
				// invoices arrive corrected); we keep the map so Save round-trips it.
				me.termOverrides = (d.config && d.config.term_overrides) || {};
				// Persisted provenance so 'you'/'planned' survive a reload (toBlock reads it).
				me.origins = (d.config && d.config.origins) || {};
				var sched = (d.config && d.config.schedules) || {};
				me.blocks = [];
				(d.payables || []).forEach(inv => me.blocks.push(me.toBlock(inv, 'pay', sched)));
				(d.receivables || []).forEach(inv => me.blocks.push(me.toBlock(inv, 'rec', sched)));
				me.addFacilityBlocks();
				me.familyCeil = {}; me._pieceSeq = 0;
				me.restoreFragments((d.config && d.config.fragments) || {});
				// "Paid" is a planning-only sticker saved in our own config — it never
				// touches the real invoice. Apply it once, after every block (incl. split
				// pieces) exists, keyed by block id.
				var paidMap = (d.config && d.config.paid) || {};
				me.blocks.forEach(b => { if (paidMap[b.id]) b.paid = true; });
				me.hideStatus();
				me._scrollPending = true;
				me.render();
			}
		});
	}

	toBlock(inv, side, sched) {
		// Server sends money as integer paise (outstanding_paise / value_paise).
		var outP = parseInt(inv.outstanding_paise, 10) || 0;
		var key = sched[inv.name];
		var pd = key ? this.keyToDate(key) : null;
		// Credit-term provenance (see _apply_term_override on the server):
		//   termEdited : 'term' (corrected standing term) | 'date' (one-off move) | null
		//   termUnverified : source term was a "Due on receipt" best-effort guess
		//   srcTerm / srcDue : the pre-override source values, so a Reset is exact even
		//                      after several edits (server sends original_* when edited).
		var srcTerm = inv.original_term != null ? inv.original_term : (inv.credit_term || '—');
		var srcDueStr = inv.original_due != null ? inv.original_due : inv.final_date;
		return {
			id: inv.name, ref: inv.ref_no || inv.name, entity: inv.party, grp: inv.party_group,
			contra: !!this.contra[inv.party], side: side, type: side === 'pay' ? 'PAY' : 'REC',
			amountP: side === 'pay' ? -outP : outP,
			due: this.parseDMY(inv.final_date), billDate: this.parseDMY(inv.bill_date),
			term: inv.credit_term || '—', orderValueP: (parseInt(inv.value_paise, 10) || 0) || outP,
			overdue: (inv.age_days || 0) > 0, priority: !!inv.priority || ((inv.age_days || 0) > 0 && outP >= HIGH_VALUE_P), highValue: outP >= HIGH_VALUE_P,
			placedDate: pd, origin: pd ? (this.origins[inv.name] || 'auto') : null, facility: null,
			termVerified: inv.term_verified !== false, termUnverified: !!inv.term_unverified,
			termEdited: inv.term_edited || null, termEditedBy: inv.term_edited_by || null, termEditedAt: inv.term_edited_at || null,
			termOriginal: inv.original_term || null, dueOriginal: inv.original_due ? this.parseDMY(inv.original_due) : null,
			srcTerm: srcTerm, srcDue: this.parseDMY(srcDueStr)
		};
	}

	// A few bank-facility lines (the backend carries no financing rows)
	addFacilityBlocks() {
		// Cash-flow sign: a DRAW puts cash in your account (+), a REPAYMENT takes it
		// out (−). (Facility utilization is tracked separately in renderStatus.)
		// Amounts in paise (₹18L draw, ₹24L draw, ₹9L repayment).
		var specs = [
			['CC', 'financing', 1800000 * PAISE, 'Cash Credit draw'],
			['BD', 'bd', 2400000 * PAISE, 'Bill Discounting draw'],
			['CC', 'financing', -900000 * PAISE, 'CC repayment']
		];
		specs.forEach((f, i) => {
			this.blocks.push({
				id: 'FIN-' + f[0] + '-' + (401 + i), ref: 'FIN-' + f[0] + '-' + (401 + i),
				entity: f[3], grp: 'Bank facilities', contra: false,
				side: 'pay', type: f[0], facility: f[1],
				amountP: f[2], due: this.addDays(TODAY, 4 + i * 7), billDate: this.addDays(TODAY, 4 + i * 7),
				term: '—', orderValueP: Math.abs(f[2]), overdue: false, priority: false, highValue: true,
				placedDate: null, origin: null
			});
		});
	}

	/* ===================== date / format helpers ===================== */
	parseDMY(s) { if (!s) return new Date(TODAY); var p = String(s).split('-'); return new Date(+p[2], (+p[1]) - 1, +p[0]); }
	// Date → 'dd-mm-yyyy' (the on-disk / override date format the server expects).
	toDMY(d) { return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); }
	daysBetween(a, b) { return Math.round((this.startOfDay(b) - this.startOfDay(a)) / 86400000); }
	keyToDate(key) {
		if (/^\d{4}-\d{2}-\d{2}$/.test(key)) { var p = key.split('-'); return new Date(+p[0], (+p[1]) - 1, +p[2]); }
		if (/-W\d+$/.test(key)) { var w = parseInt(key.split('-W')[1]); return this.addDays(HORIZON_START, (w - 23) * 7); }
		if (/^\d{4}-\d{2}-w\d+$/.test(key)) { var q = key.split('-'); var n = parseInt(q[2].substring(1)); return new Date(+q[0], (+q[1]) - 1, 1 + (n - 1) * 7); }
		if (/^\d{4}-\d{2}$/.test(key)) { var m = key.split('-'); return new Date(+m[0], (+m[1]) - 1, 1); }
		if (/^\d{4}$/.test(key)) return new Date(+key, 0, 1);
		return null;
	}
	dateToKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
	addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
	sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
	startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
	mondayOnOrBefore(d) { var x = new Date(d); var wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); x.setHours(0, 0, 0, 0); return x; }
	clampDate(d, lo, hi) { return d < lo ? new Date(lo) : d > hi ? new Date(hi) : new Date(d); }
	getWeeksOfMonth(year, month) {
		var first = new Date(year, month, 1), last = new Date(year, month + 1, 0), weeks = [];
		var ws = this.mondayOnOrBefore(first), idx = 1;
		while (ws <= last) { weeks.push({ start: new Date(ws), end: this.addDays(ws, 6), idx: idx }); ws = this.addDays(ws, 7); idx++; }
		return weeks;
	}
	get horizonEnd() { return this.addDays(HORIZON_START, this.horizonWeeks * 7 - 1); }

	// Format SIGNED PAISE for display. Paise → rupees happens here and nowhere else,
	// so callers always pass the canonical integer-paise value (b.amountP, sums, etc).
	fmtShort(p) {
		if (p == null || !isFinite(p)) return '₹—';        // never leak NaN/Infinity to the UI
		var n = p / PAISE, a = Math.abs(n), s;
		// 0.99995e7 so e.g. ₹99,99,999 reads as "₹1Cr", not the misleading "₹100L".
		if (a >= 0.99995e7) s = (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + 'Cr';
		else if (a >= 1e5) s = (a / 1e5).toFixed(2).replace(/\.?0+$/, '') + 'L';
		else s = Math.round(a).toLocaleString('en-IN');
		return (n < 0 ? '−' : '') + '₹' + s;
	}
	dstr(d) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
	dstrFull(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
	esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

	/* ===================== derived ===================== */
	get placed() { return this.blocks.filter(b => b.placedDate); }
	get unscheduled() { return this.blocks.filter(b => !b.placedDate); }
	get placedSorted() { return this.placed.slice().sort((a, b) => a.placedDate - b.placedDate); }
	balanceAt(t) { var s = this.openingP; var ps = this.placedSorted; for (var i = 0; i < ps.length; i++) { if (ps[i].placedDate <= t) s += ps[i].amountP; else break; } return s; }

	// Lowest end-of-day running balance over [start, end]. Walks placed cash events
	// in date order so a week/month catches a dip on ANY day inside it, not just its
	// last day. Money-in-hand (opening) + scheduled receipts − scheduled payments.
	minBalanceInRange(start, end) {
		var s0 = this.startOfDay(start).getTime(), e0 = this.startOfDay(end).getTime();
		var ps = this.placedSorted, run = this.openingP, min = Infinity, entered = false;
		for (var i = 0; i < ps.length; i++) {
			var t = this.startOfDay(ps[i].placedDate).getTime();
			if (t > e0) break;
			if (!entered && t >= s0) { min = run; entered = true; }   // balance carried into the period
			run += ps[i].amountP;
			if (t >= s0 && run < min) min = run;                      // balance right after an in-range event
		}
		if (!entered) min = run;                                      // no events in range → flat carried balance
		return min;
	}

	buildColumns() {
		var me = this, v = this.view, placed = this.placed, cols = [];
		if (v.level === 'year') {
			for (var m = 0; m < 12; m++) {
				var start = new Date(v.year, m, 1), end = new Date(v.year, m + 1, 0);
				cols.push({ key: 'm' + m, name: MONTHS[m], range: '' + v.year, start: start, end: end, level: 'year', unit: 'month',
					drillable: true, drillTarget: { level: 'month', year: v.year, month: m },
					blocks: placed.filter(b => b.placedDate >= start && b.placedDate <= end) });
			}
		} else if (v.level === 'month') {
			this.getWeeksOfMonth(v.year, v.month).forEach(w => {
				cols.push({ key: 'w' + w.idx, name: 'Week ' + w.idx, range: me.dstr(w.start) + ' – ' + me.dstr(w.end),
					start: w.start, end: w.end, level: 'month', unit: 'week', drillable: true,
					drillTarget: { level: 'week', weekStart: w.start },
					blocks: placed.filter(b => b.placedDate >= w.start && b.placedDate <= me.addDays(w.end, 1)) });
			});
		} else {
			var ws = this.mondayOnOrBefore(v.weekStart);
			for (var i = 0; i < 7; i++) {
				var day = this.addDays(ws, i), wd = day.getDay();
				cols.push({ key: 'd' + i, name: day.toLocaleDateString('en-GB', { weekday: 'short' }),
					range: me.dstr(day), start: this.startOfDay(day), end: this.startOfDay(day), level: 'day', unit: 'day',
					drillable: false, blocks: placed.filter(b => me.sameDay(b.placedDate, day)),
					isWeekend: (wd === 0 || wd === 6), isToday: me.sameDay(day, TODAY), isPast: this.startOfDay(day) < this.startOfDay(TODAY) });
			}
		}
		var hEnd = this.horizonEnd;
		cols.forEach(c => {
			c.inflow = c.blocks.filter(b => b.amountP > 0).reduce((s, b) => s + b.amountP, 0);
			c.outflow = c.blocks.filter(b => b.amountP < 0).reduce((s, b) => s + b.amountP, 0);
			c.net = c.inflow + c.outflow;
			c.sigma = me.balanceAt(c.end);
			// Shortfall: cash on hand can't cover scheduled payments somewhere in this
			// column. For a day that's the end-of-day balance; for a week/month it's the
			// lowest balance on ANY day inside, so an aggregated view still flags a dip.
			c.minBal = me.minBalanceInRange(c.start, c.end);
			c.shortfall = c.minBal < 0;   // integer paise — any sub-zero balance is a real shortfall
			if (c.isHorizon === undefined) {
				c.isHorizon = c.end >= HORIZON_START && c.start <= hEnd;
				c.isFuture = c.start > hEnd;
				if (c.isPast === undefined) c.isPast = c.end < me.startOfDay(TODAY);
			}
		});
		return cols;
	}

	kpis() {
		var hEnd = this.horizonEnd;
		var hp = this.placed.filter(b => b.placedDate >= HORIZON_START && b.placedDate <= hEnd);
		var horizonNet = hp.reduce((s, b) => s + b.amountP, 0);
		var lowest = Infinity, lowestWk = 1;
		for (var i = 0; i < this.horizonWeeks; i++) {
			var bal = this.balanceAt(this.addDays(HORIZON_START, i * 7 + 6));
			if (bal < lowest) { lowest = bal; lowestWk = i + 1; }
		}
		if (lowest === Infinity) lowest = this.openingP;
		var bills = this.blocks.filter(b => !b.facility);
		var paidBills = bills.filter(b => b.paid);
		return { horizonNet: horizonNet, lowest: lowest, lowestWk: lowestWk,
			unscheduled: this.unscheduled.length, overdue: this.blocks.filter(b => b.overdue).length,
			paidCount: paidBills.length, billCount: bills.length };
	}

	/* ===================== mutations ===================== */
	commit(next) { this.past.push(this.blocks); if (this.past.length > 60) this.past.shift(); this.future = []; this.blocks = next; this.assertConservation(); }
	undo() { if (!this.past.length) return; this.future.unshift(this.blocks); this.blocks = this.past.pop(); this.render(); }
	redo() { if (!this.future.length) return; this.past.push(this.blocks); this.blocks = this.future.shift(); this.render(); }
	placeOnDate(id, date) { var d = this.startOfDay(date); this.commit(this.blocks.map(b => b.id === id ? Object.assign({}, b, { placedDate: d, origin: 'user' }) : b)); }
	unplace(id) { var b = this.blocks.find(x => x.id === id); if (!b || !b.placedDate) return; this.commit(this.blocks.map(x => x.id === id ? Object.assign({}, x, { placedDate: null, origin: null }) : x)); this.toast('Moved back to inbox'); }
	// Planning-only "done" sticker. Flips a block's paid flag — never writes to the
	// real invoice, never moves money. Undoable; persisted in our config on Save.
	togglePaid(id) {
		var b = this.blocks.find(x => x.id === id);
		if (!b || b.facility) return;                 // facility draws aren't bills to "pay"
		var now = !b.paid;
		this.commit(this.blocks.map(x => x.id === id ? Object.assign({}, x, { paid: now }) : x));
		this.toast(now ? 'Marked paid (planning only — invoice untouched)' : 'Marked unpaid');
		this.render();
	}
	// Serialise paid stickers for persistence — { blockId: true }, real blocks only.
	paidMap() { var m = {}; this.blocks.forEach(b => { if (b.paid && !b.facility) m[b.id] = true; }); return m; }
	// Visible identifier for a card: the supplier/bill ref and, when it differs, the
	// ERP invoice number too (e.g. "FF/26-27/010 · ACC-PINV-2026-00005"). Split pieces
	// share the parent ref; their internal #id is noise, so just show the ref.
	idText(b) {
		if (this.isFragment(b)) return b.ref || b.id;
		return (b.ref && b.ref !== b.id) ? b.ref + ' · ' + b.id : (b.ref || b.id);
	}
	// The little paid toggle shown on a card. Reused by reservoir + timeline cards.
	paidBtn(b) {
		return `<button class="paid-toggle${b.paid ? ' on' : ''}" data-paid="${this.esc(b.id)}" aria-pressed="${!!b.paid}" title="${b.paid ? 'Marked paid (planning only) — click to undo' : 'Mark paid — planning only, does not touch the real invoice'}">${b.paid ? '✓' : '○'}</button>`;
	}

	// Credit-term provenance pill. Clickable (data-editterm) so it doubles as the
	// "edit this term" affordance everywhere a term/card is shown. Returns '' for a
	// plain verified term (no badge = trusted, from the source) and for facility lines.
	termBadge(b) {
		if (!b || b.facility) return '';
		var id = this.esc(b.id);
		if (b.termEdited === 'term') {
			var was = b.termOriginal ? ' (was “' + this.esc(b.termOriginal) + '”)' : '';
			var who = b.termEditedBy ? ' · by ' + this.esc(b.termEditedBy) : '';
			return `<span class="term-badge corrected" data-editterm="${id}" title="Credit term corrected to “${this.esc(b.term)}”${was}${who}. Click to change or reset.">✎ term</span>`;
		}
		if (b.termEdited === 'date') {
			var od = b.dueOriginal ? this.daysBetween(b.dueOriginal, b.due) : 0;
			var sign = od > 0 ? '+' : '';
			var wasD = b.dueOriginal ? ' — was ' + this.dstr(b.dueOriginal) + ', term unchanged' : '';
			return `<span class="term-badge moved" data-editterm="${id}" title="Date manually moved to ${this.dstr(b.due)}${wasD}. One-off for this bill. Click to change or reset.">⇄ ${sign}${od}d</span>`;
		}
		if (b.termUnverified) {
			return `<span class="term-badge unverified" data-editterm="${id}" title="Credit term couldn’t be verified from the Tally source — shown as a best-effort “Due on receipt”. Click to confirm the real term or set a one-off date.">? unverified</span>`;
		}
		return '';
	}
	dropOnColumn(id, col) {
		var me = this;
		var b = this.blocks.find(x => x.id === id); if (!b) return;
		var date = col.level === 'day' ? new Date(col.start) : this.clampDate(b.due, col.start, col.end);
		// Guard: never silently schedule into the past — confirm it actually happened.
		if (this.startOfDay(date) < this.startOfDay(TODAY)) {
			this.warnPastPlacement(b, date, function() { me.finalizePlace(id, date); });
			return; // wait for the dialog; card stays put until confirmed
		}
		this.finalizePlace(id, date);
	}

	finalizePlace(id, date) {
		var b = this.blocks.find(x => x.id === id);
		this.placeOnDate(id, date);
		// Nudge: pushing an already-overdue invoice further into the future.
		if (b && b.overdue && this.startOfDay(date) >= this.startOfDay(TODAY)) {
			var od = Math.round((this.startOfDay(TODAY) - this.startOfDay(b.due)) / 86400000);
			if (od > 0) this.toast('Note: ' + b.entity + ' is ' + od + 'd overdue — scheduling it forward delays it further');
		}
		this.render();
	}

	warnPastPlacement(b, date, onProceed) {
		var kind = b.side === 'pay' ? 'payment' : 'receipt';
		var msg = `You're scheduling <b>${this.esc(b.entity)}</b> (${this.fmtShort(b.amountP)}) on `
			+ `<b>${this.dstrFull(date)}</b> — that's before today (${this.dstrFull(TODAY)}).<br><br>`
			+ `The planner is forward-looking. Only place a card in the past if this ${kind} has `
			+ `<b>already happened</b>. Otherwise pick today or a future date.`;
		frappe.warn('Schedule in the past?', msg, onProceed, 'Yes — it already happened', true);
	}

	/* ===================== partial-payment splitting =====================
	   A "value block" is an obligation, so editing it really SPLITS the money
	   into pieces that must always re-sum to the original invoice. Money lives on
	   blocks as signed integer PAISE (b.amountP) end to end, so both the split
	   pieces AND every column/KPI sum stay exact — a long chain of edits can never
	   drift a paisa in or out. Invariant: for each family, Σ|piece| === familyCeil[root]
	   (also paise). b.root is the original invoice id (the family key); b.splitFrom
	   is the sibling a piece was carved from (used to merge it back). =========== */
	toPaise(rupees) { return Math.round((parseFloat(rupees) || 0) * PAISE); }
	fromPaise(p) { return p / PAISE; }
	rootOf(b) { return b.root || b.id; }
	isFragment(b) { return !!b.splitFrom && this.rootOf(b) !== b.id; }

	// Strict money parse: accepts "50000", "₹50,000", "1,00,000.50"; rejects blanks,
	// letters, e-notation, signs, sub-paise. Returns positive paise (int) or null.
	parseMoneyPaise(raw) {
		var s = String(raw == null ? '' : raw).trim().replace(/[₹\s,]/g, '');
		if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
		var p = Math.round(parseFloat(s) * 100);
		return p > 0 ? p : null;
	}

	// Replace the amount text with an inline editor. Done imperatively (no render
	// until commit) because the whole board re-renders via innerHTML, which would
	// destroy a normally-rendered input mid-keystroke.
	beginInlineEdit($amt) {
		if (this._inlineEditing) return;
		var me = this, $card = $amt.closest('[data-id]'), id = $card.data('id');
		var b = this.blocks.find(x => x.id === id);
		if (!b || b.facility) return;                 // facility lines aren't partial-payable here
		this._inlineEditing = id; this._inlineDone = false;
		$card.attr('draggable', 'false');             // don't let a click-drag start while editing
		var cur = Math.abs(b.amountP) / PAISE;        // show rupees in the editor (paise → rupees)
		var $inp = $('<input class="amt-edit" type="text" inputmode="decimal">').val(String(cur));
		$amt.replaceWith($inp);
		$inp.trigger('focus'); try { $inp[0].select(); } catch (e) {}
		var finish = function(save) {
			if (me._inlineDone) return; me._inlineDone = true; me._inlineEditing = null;
			if (save) me.applyEdit(id, $inp.val()); else me.render();
		};
		$inp.on('keydown', function(e) {
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
		$inp.on('blur', function() { finish(true); });
		$inp.on('mousedown click', function(e) { e.stopPropagation(); });
	}

	applyEdit(id, raw) {
		var b = this.blocks.find(x => x.id === id);
		if (!b) { this.render(); return; }
		var newP = this.parseMoneyPaise(raw);
		if (newP == null) { this.toast('Enter a positive amount, e.g. 50000'); this.render(); return; }
		var curP = Math.abs(b.amountP);               // already paise
		if (newP === curP) { this.render(); return; }                 // no-op — no undo entry, no 0-piece
		var sign = b.amountP < 0 ? -1 : 1, root = this.rootOf(b);
		if (this.familyCeil[root] == null) this.familyCeil[root] = curP;  // seed ceiling on first split
		if (newP < curP) this._reduceInto(b, root, sign, curP, newP);
		else this._growFrom(b, root, sign, curP, newP);
	}

	// Partial payment: shrink this block to newP and carve the remainder into a
	// fresh piece that stays UNSCHEDULED (kept aside) so nothing is lost. The edited
	// block keeps its place (scheduled date or reservoir) and its identity.
	_reduceInto(b, root, sign, curP, newP) {
		var me = this, remP = curP - newP;
		var kept = Object.assign({}, b, {
			id: root + '#' + (++this._pieceSeq), root: root, splitFrom: b.id,
			amountP: sign * remP, orderValueP: remP,
			highValue: remP >= HIGH_VALUE_P, placedDate: null, origin: null
		});
		var next = this.blocks.map(x => x.id === b.id
			? Object.assign({}, x, { root: root, amountP: sign * newP, orderValueP: newP, highValue: newP >= HIGH_VALUE_P })
			: x);
		next.push(kept);
		this.commit(next);
		this.toast('Split ' + b.entity + ' — ' + this.fmtShort(newP) + ' here, ' + this.fmtShort(remP) + ' kept aside');
		this.render();
	}

	// Grow this piece up to the family ceiling by absorbing sibling pieces. Capped
	// at familyCeil so it can never invent money the party isn't owed. Pulls from
	// unscheduled siblings first, smallest first; fully-absorbed siblings dissolve.
	_growFrom(b, root, sign, curP, newP) {
		var me = this, ceilP = this.familyCeil[root];
		if (newP > ceilP) {
			this.toast('Capped at ' + this.fmtShort(ceilP) + ' — the full invoice. Reduce or merge a piece to free room.');
			this.render(); return;
		}
		var sibs = this.blocks.filter(x => me.rootOf(x) === root && x.id !== b.id)
			.sort((a, c) => (a.placedDate ? 1 : 0) - (c.placedDate ? 1 : 0) || Math.abs(a.amountP) - Math.abs(c.amountP));
		var avail = sibs.reduce((s, x) => s + Math.abs(x.amountP), 0), needP = newP - curP;
		if (needP > avail) {
			this.toast(avail === 0 ? 'This is the whole invoice — nothing to grow into. Reduce it instead to part-pay.'
				: 'Only ' + this.fmtShort(avail) + ' available in sibling pieces.');
			this.render(); return;
		}
		var take = needP, dissolved = 0, shrunk = {};
		for (var i = 0; i < sibs.length && take > 0; i++) {
			var sp = Math.abs(sibs[i].amountP), t = Math.min(sp, take);
			take -= t;
			if (t >= sp) { shrunk[sibs[i].id] = 0; dissolved++; } else shrunk[sibs[i].id] = sp - t;
		}
		var next = [];
		this.blocks.forEach(function(x) {
			if (x.id === b.id) { next.push(Object.assign({}, x, { root: root, amountP: sign * newP, orderValueP: newP, highValue: newP >= HIGH_VALUE_P })); return; }
			if (Object.prototype.hasOwnProperty.call(shrunk, x.id)) {
				if (shrunk[x.id] === 0) return;             // fully absorbed → merged away
				var ss = x.amountP < 0 ? -1 : 1;
				next.push(Object.assign({}, x, { amountP: ss * shrunk[x.id], orderValueP: shrunk[x.id], highValue: shrunk[x.id] >= HIGH_VALUE_P }));
				return;
			}
			next.push(x);
		});
		this.commit(next);
		this.toast('Grew ' + b.entity + ' to ' + this.fmtShort(newP) + (dissolved ? ' (absorbed ' + dissolved + ' piece' + (dissolved > 1 ? 's' : '') + ')' : ''));
		this.render();
	}

	// Merge a fragment's money back into a sibling — never an ✕ that drops money.
	// Prefers the piece it was split from, then the original, then any sibling.
	mergeBack(id) {
		var me = this, b = this.blocks.find(x => x.id === id);
		if (!b || !this.isFragment(b)) return;
		var root = this.rootOf(b);
		var target = this.blocks.find(x => x.id === b.splitFrom)
			|| this.blocks.find(x => x.id === root)
			|| this.blocks.find(x => me.rootOf(x) === root && x.id !== id);
		if (!target) { this.toast('Nothing to merge into'); return; }
		var sumP = Math.abs(target.amountP) + Math.abs(b.amountP);
		var ts = target.amountP < 0 ? -1 : 1, tid = target.id, amt = this.fmtShort(Math.abs(b.amountP));
		var next = this.blocks.filter(x => x.id !== id).map(x => x.id === tid
			? Object.assign({}, x, { amountP: ts * sumP, orderValueP: sumP, highValue: sumP >= HIGH_VALUE_P })
			: x);
		this.commit(next);
		this.toast('Merged ' + amt + ' back into ' + target.ref);
		this.render();
	}

	// Collapse every split family back onto a single block holding the full ceiling.
	mergeAllFragments() {
		var me = this, next = this.blocks.slice(), merged = 0;
		Object.keys(this.familyCeil).forEach(function(root) {
			var fam = next.filter(x => me.rootOf(x) === root);
			if (fam.length <= 1) return;
			var keep = fam.find(x => x.id === root) || fam[0], sign = keep.amountP < 0 ? -1 : 1, ceilP = me.familyCeil[root];
			next = next.filter(x => me.rootOf(x) !== root || x.id === keep.id)
				.map(x => x.id === keep.id ? Object.assign({}, x, { amountP: sign * ceilP, orderValueP: ceilP, highValue: ceilP >= HIGH_VALUE_P, splitFrom: undefined }) : x);
			merged++;
		});
		if (merged) { this.commit(next); this.toast('Merged fragments in ' + merged + ' invoice' + (merged > 1 ? 's' : '')); }
		else this.toast('No split fragments to merge');
		this.render();
	}

	// Money-conservation tripwire — runs on every commit. Warns (loudly, in console)
	// if a family's pieces stop summing to its captured ceiling, or any piece goes
	// non-positive / NaN. A planning tool must never silently lose or invent money.
	assertConservation() {
		var me = this, ok = true;
		Object.keys(this.familyCeil).forEach(function(root) {
			var fam = me.blocks.filter(x => me.rootOf(x) === root);
			if (!fam.length) return;
			var sumP = fam.reduce((s, x) => s + Math.abs(x.amountP), 0);
			// Integer paise everywhere → this is an EXACT check now (no float tolerance).
			if (sumP !== me.familyCeil[root]) { ok = false; console.warn('[CFP] money conservation broken for ' + root + ': pieces=' + sumP + 'p, ceil=' + me.familyCeil[root] + 'p'); }
			fam.forEach(function(x) { var p = Math.abs(x.amountP); if (!(p > 0) || isNaN(p)) { ok = false; console.warn('[CFP] invalid piece amount', x.id, x.amountP); } });
		});
		return ok;
	}

	// Serialise split families for persistence (backend already round-trips `fragments`).
	fragmentsMap() {
		var me = this, out = {};
		Object.keys(this.familyCeil).forEach(function(root) {
			var pieces = me.blocks.filter(x => me.rootOf(x) === root);
			if (!pieces.length) return;
			if (pieces.length === 1 && pieces[0].id === root) return;   // healed back to a plain invoice
			out[root] = {
				ceil: me.familyCeil[root],
				pieces: pieces.map(p => ({
					id: p.id, amountP: Math.abs(p.amountP),
					placedKey: p.placedDate ? me.dateToKey(p.placedDate) : null,
					splitFrom: p.splitFrom || null, ref: p.ref
				}))
			};
		});
		return out;
	}

	// Rebuild split families from persisted `fragments` after a reload, so a split
	// survives a refresh instead of "healing" and making the remainder reappear.
	restoreFragments(frags) {
		var me = this;
		Object.keys(frags || {}).forEach(function(root) {
			var fam = frags[root];
			if (!fam || !fam.pieces || !fam.pieces.length) return;
			var base = me.blocks.find(b => b.id === root);
			if (!base) return;                              // underlying invoice gone — skip
			// `ceil` was already persisted in paise. Pieces now persist `amountP` (paise);
			// tolerate a legacy save that stored rupees under `amount` by converting it.
			me.familyCeil[root] = parseInt(fam.ceil, 10) || 0;
			me.blocks = me.blocks.filter(b => b.id !== root);
			var sign = base.amountP < 0 ? -1 : 1;
			fam.pieces.forEach(function(p) {
				var magP = p.amountP != null
					? Math.abs(parseInt(p.amountP, 10) || 0)
					: me.toPaise(Math.abs(parseFloat(p.amount) || 0));   // legacy rupees fallback
				me.blocks.push(Object.assign({}, base, {
					id: p.id, root: root, splitFrom: p.splitFrom || undefined,
					amountP: sign * magP, orderValueP: magP, highValue: magP >= HIGH_VALUE_P,
					placedDate: p.placedKey ? me.keyToDate(p.placedKey) : null,
					origin: p.placedKey ? (me.origins[p.id] || 'auto') : null   // persisted provenance, else 'auto'
				}));
				var m = /#(\d+)$/.exec(p.id || '');
				if (m) me._pieceSeq = Math.max(me._pieceSeq, parseInt(m[1]) || 0);
			});
		});
	}

	/* ===================== rendering ===================== */
	render() {
		this.cols = this.buildColumns();
		var html = this.renderToolbar() + this.renderStatus() + this.renderBody() + this.renderLedger();
		this.$root.html(html);
		// Bring the horizon/today columns into view — only when explicitly requested
		// (load / level change / drill), so routine re-renders never yank the scroll.
		if (this._scrollPending) {
			this._scrollPending = false;
			var colsEl = this.$root.find('.tl-cols')[0];
			var $t = this.$root.find('.tl-cols .col.horizon').first();
			if (!$t.length) $t = this.$root.find('.tl-cols .col.today-col').first();
			if (colsEl && $t.length) colsEl.scrollLeft = Math.max(0, $t[0].offsetLeft - colsEl.offsetLeft - 12);
		}
		// Bring a chosen scheduled block into view and flash it (from the side dropdowns).
		if (this._scrollToFlash) {
			this._scrollToFlash = false;
			var fid = this._flashId; this._flashId = null;
			var $el = this.$root.find('.placed').filter(function() { return String($(this).data('id')) === String(fid); });
			if ($el.length) {
				try { $el[0].scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
				$el.addClass('flash');
				setTimeout(() => $el.removeClass('flash'), 1500);
			}
		}
	}

	renderToolbar() {
		var openL = (this.openingP / (1e5 * PAISE)).toFixed(2);   // paise → lakhs for the toolbar input
		var v = this.view;
		var ws = this.mondayOnOrBefore(v.weekStart || HORIZON_START), we = this.addDays(ws, 6);
		var dy = v.day || ws;
		var planMenu = this.planOpen ? `
			<div class="menu" id="cfp-plan-menu">
				<div class="item" data-plan="year">Plan year<span class="k">${v.year}</span></div>
				<div class="item" data-plan="month">Plan month<span class="k">${MONTHS[v.month]} ${v.year}</span></div>
				<div class="item" data-plan="week">Plan week<span class="k">${this.dstr(ws)}–${this.dstr(we)}</span></div>
				<div class="item" data-plan="day">Plan day<span class="k">${this.dstr(dy)}</span></div>
			</div>` : '';
		var moreMenu = this.moreOpen ? `
			<div class="menu" id="cfp-more-menu">
				<div class="item" data-action="publish">⇧ Publish to shared board${this.behind ? ' <span class="k" style="color:var(--out)">moved</span>' : ''}</div>
				<div class="item" data-action="reload-shared">⟳ Reload shared board</div>
				<div class="sep"></div>
				<div class="item" data-action="overdue">⏱ Carry overdue → today</div>
				<div class="sep"></div>
				<div class="item" data-action="saveas">Save as… <span class="k">shared</span></div>
				<div class="item" data-action="load">Load plans…</div>
				<div class="item" data-action="fresh">Start fresh</div>
				<div class="sep"></div>
				<div class="item" data-action="merge">Merge fragments</div>
				<div class="item" data-action="export">Export CSV</div>
				<div class="sep"></div>
				<div class="item danger" data-action="reset">Reset draft → shared</div>
			</div>` : '';
		return `
		<div class="toolbar">
			<div class="tb-title">Cash Flow Planner <span class="demo">Demo · planning</span></div>
			<div class="tb-divider"></div>
			<button class="btn btn-icon" id="cfp-undo" title="Undo" ${this.past.length ? '' : 'disabled'}>↶</button>
			<button class="btn btn-icon" id="cfp-redo" title="Redo" ${this.future.length ? '' : 'disabled'}>↷</button>
			<button class="btn btn-icon" id="cfp-focus" title="Focus timeline — hide both side panels + ledger" aria-pressed="${this.focusMode}">${this.focusMode ? '⛶' : '⤢'}</button>
			<div class="tb-divider"></div>
			<div class="tb-field" title="Opening cash on hand — entered in lakhs (L). 80 = ₹80,00,000">
				<label>Opening cash</label>
				<input class="tb-input num" id="cfp-opening" value="${openL}" inputmode="decimal" aria-label="Opening cash in lakhs">
				<span style="font-size:10px;color:var(--faint);">L</span>
				<span class="tb-openhint" title="Full rupee value">= ${this.fmtShort(this.openingP)}</span>
			</div>
			<div class="tb-spring"></div>
			${this.behind ? `<button class="btn btn-ghost behind-chip" id="cfp-behind" title="The shared board was published by ${this.esc(this.publishedBy || 'someone')} after you started. Click to reload it (discards your unpublished draft).">⟳ shared moved</button>` : ''}
			<button class="btn btn-ghost" id="cfp-save" title="Save your PRIVATE draft (only you see it until you Publish)">Save draft</button>
			<button class="btn btn-primary" id="cfp-publish" title="Publish your draft to the shared board everyone sees">⇧ Publish${this.behind ? ' ⚠' : ''}</button>
			<div class="menu-wrap">
				<button class="btn btn-icon" id="cfp-more-btn" title="More">⋯</button>
				${moreMenu}
			</div>
			<div class="menu-wrap">
				<button class="btn btn-primary" id="cfp-plan-btn">Plan <span class="caret">▾</span></button>
				${planMenu}
			</div>
		</div>`;
	}

	renderStatus() {
		var k = this.kpis();
		// Every KPI here is derived from PLACED cash only. With an empty board that
		// makes "Lowest cash = opening" read like a healthy runway when really nothing
		// has been scheduled — so call that out explicitly.
		var nothingPlaced = this.placed.length === 0;
		var fac = (name, color, used, limit) => {
			var pct = Math.min(100, (used / limit) * 100);
			var state = used >= limit ? 'hard' : used >= limit * SOFT ? 'soft' : 'ok';
			var note = state === 'ok' ? 'Within facility' : state === 'soft' ? '⚠ Past soft limit — review before drawing more' : '⚠ At/over limit — confirm headroom before drawing more';
			return `<div class="fac ${state}">
				<div class="fhead"><span class="fname" style="color:${color}">${name}</span>
					<span class="fval">${this.fmtShort(used)} / ${this.fmtShort(limit)}${state === 'hard' ? ' 🔒' : ''}</span></div>
				<div class="ftrack"><div class="ffill" style="width:${pct}%"></div><div class="fsoft" style="left:${SOFT * 100}%"></div></div>
				<div class="fnote">${note}</div></div>`;
		};
		// Net drawn on each facility = draws (+cash) minus repayments (−cash), floored at 0.
		var facCC = Math.max(0, this.placed.filter(b => b.facility === 'financing').reduce((s, b) => s + b.amountP, 0));
		var facBD = Math.max(0, this.placed.filter(b => b.facility === 'bd').reduce((s, b) => s + b.amountP, 0));
		return `
		<div class="status">
			<div class="statstrip">
				<div class="s ${nothingPlaced ? '' : (k.horizonNet >= 0 ? 'good' : '')}"><div class="k">Horizon net · ${this.horizonWeeks} wks</div><div class="v" ${(!nothingPlaced && k.horizonNet < 0) ? 'style="color:var(--out)"' : ''}>${this.fmtShort(nothingPlaced ? 0 : k.horizonNet)}</div>${nothingPlaced ? '<div class="s-note">nothing scheduled yet</div>' : ''}</div>
				<div class="s" title="Projected low point of cash on hand across the horizon, counting only SCHEDULED movements. Unscheduled bills (in the side panels) aren't included yet."><div class="k">Lowest cash${nothingPlaced ? '' : ' · wk ' + k.lowestWk}</div><div class="v" ${(!nothingPlaced && k.lowest < 0) ? 'style="color:var(--out)"' : ''}>${this.fmtShort(k.lowest)}</div><div class="s-note">${nothingPlaced ? '= opening · nothing scheduled' : 'scheduled only'}</div></div>
				<div class="s ${k.overdue > 0 ? 'alert' : ''}"><div class="k">${k.overdue > 0 ? '⚠ ' : ''}Overdue</div><div class="v">${k.overdue}<small>items</small></div></div>
				<div class="s"><div class="k">Unscheduled</div><div class="v">${k.unscheduled}</div></div>
				<div class="s ${k.paidCount > 0 ? 'good' : ''}" title="Bills you've ticked off as paid — planning only, the real invoices are untouched"><div class="k">✓ Paid <small>planned</small></div><div class="v">${k.paidCount}<small>/${k.billCount}</small></div></div>
			</div>
			<div class="facilities">
				${fac('Cash Credit (CC)', 'var(--cc)', facCC, CC_LIMIT)}
				${fac('Bill Discounting (BD)', 'var(--bd)', facBD, BD_LIMIT)}
			</div>
		</div>`;
	}

	renderBody() {
		// When a curtain is closed, shrink that side to a thin rail so the timeline
		// takes the reclaimed space. Only emit an inline grid when something is
		// collapsed, so the default + responsive CSS still apply when both are open.
		var collapsed = !this.payOpen || !this.recOpen;
		var L = this.payOpen ? '250px' : '46px', R = this.recOpen ? '250px' : '46px';
		var st = collapsed ? ` style="grid-template-columns:${L} minmax(0,1fr) ${R}"` : '';
		return `<div class="body"${st}>
			${this.renderReservoir('pay', 'Payables & financing', 'what we owe + facility draws')}
			${this.renderTimeline()}
			${this.renderReservoir('rec', 'Receivables', 'what customers owe us')}
		</div>`;
	}

	/* Is this placed-date inside the period the timeline is currently showing? */
	inCurrentView(d) {
		if (!d) return false;
		var v = this.view, x = this.startOfDay(d);
		if (v.level === 'year') return d.getFullYear() === v.year;
		if (v.level === 'month') return d.getFullYear() === v.year && d.getMonth() === v.month;
		var ws = this.mondayOnOrBefore(v.weekStart || HORIZON_START), we = this.addDays(ws, 6);
		return x >= ws && x <= this.startOfDay(we);
	}

	/* Collapsed curtain: a thin rail with expand + a scheduled-count badge. */
	renderReservoirRail(side, title) {
		var n = this.placed.filter(b => b.side === side).length;
		return `<div class="reservoir ${side} collapsed-rail">
			<button class="rail-exp" data-curtain="${side}" title="Expand — ${this.esc(title)}">${side === 'pay' ? '⟩' : '⟨'}</button>
			<div class="rail-count" title="${n} scheduled">${n}</div>
			<div class="rail-title">${this.esc(title)}</div>
		</div>`;
	}

	// Relative timing vs "today" — drives the forward-looking "in 5d / 3d late" pill.
	relWhen(due) {
		var days = Math.round((this.startOfDay(due) - this.startOfDay(TODAY)) / 86400000);
		if (days === 0) return { txt: 'due today', cls: 'due-today' };
		if (days < 0) return { txt: (-days) + 'd late', cls: 'due-late' };
		return { txt: 'in ' + days + 'd', cls: 'due-soon' };
	}

	// True when a block sits on/after today but its real due date has already passed —
	// i.e. it was carried forward out of the past. You can't transact in the past, so
	// the plan lands it on today; this flag drives the "was due …" indicator so the
	// past due date stays visible and the item never looks on-time.
	isCarriedLate(b) {
		if (!b.placedDate || b.facility) return false;
		return this.startOfDay(b.placedDate) >= this.startOfDay(TODAY) && this.startOfDay(b.due) < this.startOfDay(TODAY);
	}
	daysLate(b) { return Math.round((this.startOfDay(TODAY) - this.startOfDay(b.due)) / 86400000); }

	// A scheduled block shown inside the "Scheduled" reservoir section — greyed to
	// signal it's already committed; click to jump to it, drag to reschedule.
	renderSchedCard(b) {
		var cls = ['block', 'sched-card', 'chosen', b.side === 'rec' ? 'rec' : 'pay'];
		if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd');
		var late = this.isCarriedLate(b); if (late) cls.push('late-carried');
		if (b.paid) cls.push('paid');
		var when = late
			? `<span class="sched-when late" title="Was due ${this.dstr(b.due)} (${this.daysLate(b)}d ago) — placed ${this.dstr(b.placedDate)}">⏱ ${this.dstr(b.placedDate)}</span>`
			: `<span class="sched-when">${this.dstr(b.placedDate)}</span>`;
		return `<div class="${cls.join(' ')}" draggable="true" data-id="${this.esc(b.id)}" data-goto="${this.esc(b.id)}" title="Click to jump · drag to reschedule">
			<div class="brow1">
				<span class="bname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</span>
				${this.isFragment(b) ? '<span class="part-chip" title="Split piece">part</span>' : ''}
				${b.paid ? '<span class="paid-chip" title="Marked paid — planning only">✓</span>' : ''}
				<span style="flex:1"></span>
				${b.facility ? '' : this.paidBtn(b)}
				${when}
				<span class="bamt ${b.amountP < 0 ? 'neg' : 'pos'}">${this.fmtShort(b.amountP)}</span>
			</div>
			<div class="sched-ref" title="${this.esc(this.idText(b))}">${this.esc(this.idText(b))}</div>
		</div>`;
	}

	/* Jump the timeline to a scheduled block and flash it. */
	gotoScheduled(id) {
		var b = this.blocks.find(x => x.id === id);
		if (!b || !b.placedDate) { this.render(); return; }
		if (!this.inCurrentView(b.placedDate)) {
			var d = b.placedDate;
			if (this.view.level === 'year') this.view.year = d.getFullYear();
			else if (this.view.level === 'month') { this.view.year = d.getFullYear(); this.view.month = d.getMonth(); }
			else this.view.weekStart = this.mondayOnOrBefore(d);
		}
		this._flashId = id;
		this._scrollToFlash = true;
		this.render();
	}

	toggleFocus() {
		this.focusMode = !this.focusMode;
		if (this.focusMode) {
			this._restore = { pay: this.payOpen, rec: this.recOpen, led: this.ledgerOpen };
			this.payOpen = false; this.recOpen = false; this.ledgerOpen = false;
		} else {
			var r = this._restore || { pay: true, rec: true, led: true };
			this.payOpen = r.pay; this.recOpen = r.rec; this.ledgerOpen = r.led;
		}
		this.render();
	}

	renderReservoir(side, title, sub) {
		if ((side === 'pay' && !this.payOpen) || (side === 'rec' && !this.recOpen)) {
			return this.renderReservoirRail(side, title);
		}
		var me = this, q = this.search[side].trim().toLowerCase(), f = this.filters[side];
		var dueT = b => this.startOfDay(b.due).getTime();
		var matches = b => {
			if (q && !(b.entity.toLowerCase().includes(q) || b.ref.toLowerCase().includes(q))) return false;
			if (f.priority && !b.priority) return false;
			if (f.highValue && !b.highValue) return false;
			if (f.overdue && !b.overdue) return false;
			return true;
		};
		// ---- Upcoming (unscheduled), grouped by company, soonest-first ----
		var list = this.unscheduled.filter(b => b.side === side).filter(matches);
		var groups = {};
		list.forEach(b => { (groups[b.entity] = groups[b.entity] || { contra: b.contra, items: [] }).items.push(b); });
		// Folders ordered by who is due soonest; rows inside a folder by due date too.
		var names = Object.keys(groups).sort((a, b) => Math.min.apply(null, groups[a].items.map(dueT)) - Math.min.apply(null, groups[b].items.map(dueT)));
		names.forEach(n => groups[n].items.sort((a, b) => dueT(a) - dueT(b)));
		var totalAmt = list.reduce((s, b) => s + b.amountP, 0);
		var foldersHtml = names.length === 0
			? `<div class="res-empty">Nothing matches — everything here is scheduled, or filtered out.</div>`
			: names.map((n, i) => {
				var g = groups[n], total = g.items.reduce((s, x) => s + x.amountP, 0);
				var fkey = side + '::' + n;
				var open = this.openFolders[fkey] !== undefined ? this.openFolders[fkey] : (i < 2 && names.length <= 8);
				var soon = this.relWhen(g.items[0].due);
				var body = open ? `<div class="folder-body">${g.items.map(b => this.renderBlock(b, side)).join('')}</div>` : '';
				return `<div class="folder">
					<div class="folder-head ${open ? 'open' : ''} ${g.contra ? 'contra' : ''}" data-folder="${this.esc(fkey)}">
						<span class="tw">▶</span>
						<span class="fname" title="${this.esc(n)}">${this.esc(n)}</span>
						${g.contra ? '<span class="contra-ic" title="Contra">⇄</span>' : ''}
						<span class="due-pill ${soon.cls}" title="soonest in this company">${soon.txt}</span>
						<span class="cnt">${g.items.length}</span>
						<span class="ftot ${total < 0 ? 'neg' : 'pos'}">${this.fmtShort(total)}</span>
					</div>${body}</div>`;
			}).join('');

		// ---- Scheduled (already placed), soonest-first, greyed ----
		var schedList = this.placed.filter(b => b.side === side).filter(matches).sort((a, b) => a.placedDate - b.placedDate);
		var schedTotal = schedList.reduce((s, b) => s + b.amountP, 0);
		var schedHtml = schedList.length === 0
			? `<div class="res-empty">Nothing scheduled yet — drag from Upcoming onto the timeline.</div>`
			: schedList.map(b => this.renderSchedCard(b)).join('');

		var sec = this.resSec[side], pill = (key, label) => `<span class="pill" data-side="${side}" data-filter="${key}" aria-pressed="${f[key]}">${label}</span>`;
		var curtain = side === 'pay'
			? `<button class="res-curtain" data-curtain="pay" title="Collapse panel">⟨</button>`
			: `<button class="res-curtain" data-curtain="rec" title="Collapse panel">⟩</button>`;
		return `<div class="reservoir ${side}">
			<div class="res-head">
				<div class="res-ctrl">${curtain}</div>
				<div class="rtitle"><span class="dot"></span>${title}<span class="${totalAmt < 0 ? 'neg' : 'pos'}" style="margin-left:auto;font-family:var(--f-num);font-weight:700;font-size:12px;">${this.fmtShort(totalAmt)}</span></div>
				<div class="rsub">${list.length} upcoming · ${schedList.length} scheduled · ${sub}</div>
				<input class="res-search" data-side="${side}" placeholder="Search entity or block id…" value="${this.esc(this.search[side])}">
				<div class="res-pills">${pill('priority', '★ Priority')}${pill('highValue', '▲ High value')}${pill('overdue', '⏱ Overdue')}</div>
			</div>
			<div class="res-sections">
				<div class="res-sec">
					<div class="sec-head ${sec.up ? 'open' : ''}" data-sec="up" data-side="${side}" title="Look ahead — what's coming due, soonest first. Drag any onto the timeline to pull it into a week.">
						<span class="tw">▶</span><span class="sec-name">Upcoming · soonest first</span>
						<span class="cnt">${list.length}</span><span class="sec-tot ${totalAmt < 0 ? 'neg' : 'pos'}">${this.fmtShort(totalAmt)}</span>
					</div>
					${sec.up ? `<div class="sec-body res-body" data-resbody="${side}">${foldersHtml}</div>` : ''}
				</div>
				<div class="res-sec">
					<div class="sec-head ${sec.sch ? 'open' : ''}" data-sec="sch" data-side="${side}" title="Already committed — click one to jump to it, drag to reschedule">
						<span class="tw">▶</span><span class="sec-name">Scheduled</span>
						<span class="cnt">${schedList.length}</span><span class="sec-tot ${schedTotal < 0 ? 'neg' : 'pos'}">${this.fmtShort(schedTotal)}</span>
					</div>
					${sec.sch ? `<div class="sec-body sched-list">${schedHtml}</div>` : ''}
				</div>
			</div>
		</div>`;
	}

	renderBlock(b, side) {
		var cls = ['block']; if (b.side === 'rec') cls.push('rec'); if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd'); if (b.paid) cls.push('paid');
		var flags = (b.priority ? '★' : '') + (b.overdue ? '⏱' : '');
		return `<div class="${cls.join(' ')}" draggable="true" data-id="${this.esc(b.id)}">
			<div class="bbody">
				<div class="brow1">
					<span class="btype">${b.type}</span>
					<span class="bname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</span>
					${b.contra ? '<span style="color:var(--contra);font-size:11px;" title="Contra — customer & vendor">⇄</span>' : ''}
					${this.isFragment(b) ? '<span class="part-chip" title="Split piece — part of the original invoice">part</span>' : ''}
					${b.paid ? '<span class="paid-chip" title="Marked paid — planning only">✓ paid</span>' : ''}
					${flags ? `<span class="bflags">${flags}</span>` : ''}
					<span style="flex:1"></span>
					${b.facility ? '' : this.paidBtn(b)}
					${this.isFragment(b) ? `<button class="merge-back" data-merge="${this.esc(b.id)}" title="Merge this piece back into the invoice">↩</button>` : ''}
					<span class="bamt ${b.amountP < 0 ? 'neg' : 'pos'}${b.facility ? '' : ' editable'}"${b.facility ? '' : ' title="Click to edit — type a smaller value to part-pay"'}>${this.fmtShort(b.amountP)}</span>
				</div>
				<div class="brow2"><span class="due-pill ${this.relWhen(b.due).cls}">${this.relWhen(b.due).txt}</span><span style="flex:1"></span><span class="card-id" title="${this.esc(this.idText(b))}">${this.esc(this.idText(b))}</span></div>
				<div class="bmeta">
					<span class="bdue">due ${this.dstr(b.due)}</span>
					${this.termBadge(b)}
					${b.highValue ? '<span class="tpill early">High value</span>' : ''}
					<span style="flex:1"></span>
					<span class="bid">${this.esc(b.ref)}</span>
				</div>
			</div>
		</div>`;
	}

	renderTimeline() {
		var me = this, v = this.view;
		var seg = (lvl, label) => `<button data-level="${lvl}" aria-pressed="${v.level === lvl}">${label}</button>`;
		var crumb;
		if (v.level === 'year') crumb = `<b>${v.year}</b> · months`;
		else if (v.level === 'month') crumb = `<span class="up" data-level="year">${v.year}</span> › <b>${MONTHS[v.month]}</b> · weeks`;
		else crumb = `<span class="up" data-level="year">${v.year}</span> › <span class="up" data-level="month">${MONTHS[this.mondayOnOrBefore(v.weekStart).getMonth()]}</span> › <b>${this.dstr(this.mondayOnOrBefore(v.weekStart))}</b> · days`;

		var viewNet = this.cols.reduce((s, c) => s + c.net, 0);
		var colsHtml = this.cols.map((c, idx) => this.renderColumn(c, idx)).join('');
		// First-run orientation: the bills aren't missing, they're in the side panels.
		var emptyHint = this.placed.length === 0
			? `<div class="tl-empty-hint">Nothing scheduled yet — drag bills from the side panels onto a day/week, or use <b>Plan ▾</b> to pull a whole period onto the board.</div>`
			: '';
		return `<div class="timeline">
			<div class="tl-nav">
				<div class="zseg">${seg('year', 'Year')}${seg('month', 'Month')}${seg('week', 'Week')}</div>
				<span class="lvlchip">${v.level} view</span>
				<span class="crumb">${crumb}</span>
				<span class="tl-net">view net <b class="${viewNet < 0 ? 'neg' : 'pos'}">${this.fmtShort(viewNet)}</b></span>
			</div>
			${emptyHint}
			<div class="tl-cols">${colsHtml}</div>
		</div>`;
	}

	// Column contents: 2+ blocks from the SAME company in one timeframe collapse
	// into a single expandable group so a busy day stays readable.
	columnBody(c) {
		var me = this, groups = {};
		c.blocks.forEach(b => { (groups[b.entity] = groups[b.entity] || []).push(b); });
		var names = Object.keys(groups).sort((a, b) => Math.abs(groups[b].reduce((s, x) => s + x.amountP, 0)) - Math.abs(groups[a].reduce((s, x) => s + x.amountP, 0)));
		return names.map(function(n) {
			var items = groups[n];
			if (items.length === 1) return me.renderPlaced(items[0]);
			var gkey = me.dateToKey(c.start) + '::' + items[0].side + '::' + n;
			var open = !!me.openColGroups[gkey], total = items.reduce((s, x) => s + x.amountP, 0);
			var inner = open ? items.map(b => me.renderPlaced(b, true)).join('') : '';
			return `<div class="pgroup ${items[0].side === 'rec' ? 'rec' : 'pay'}">
				<div class="pg-head ${open ? 'open' : ''}" data-group="${me.esc(gkey)}" title="${items.length} bills · ${me.esc(n)} — click to ${open ? 'collapse' : 'expand'}">
					<span class="tw">▶</span>
					<span class="pg-name" title="${me.esc(n)}">${me.esc(n)}</span>
					<span class="pg-cnt">${items.length}</span>
					<span class="pg-amt ${total < 0 ? 'neg' : 'pos'}">${me.fmtShort(total)}</span>
				</div>${inner}</div>`;
		}).join('');
	}

	renderColumn(c, idx) {
		var cls = ['col']; if (c.isHorizon) cls.push('horizon'); if (c.isFuture) cls.push('future'); if (c.isToday) cls.push('today-col'); if (c.isWeekend) cls.push('weekend');
		if (c.shortfall) cls.push('shortfall');
		var isSel = c.level === 'day' && this.view.day && this.sameDay(c.start, this.view.day);
		if (isSel) cls.push('sel-day');
		var netStr = c.net === 0 ? '₹0' : this.fmtShort(c.net);
		var netCls = c.net < 0 ? 'neg' : c.net > 0 ? 'pos' : '';
		// Subtle shortfall marker — cash dips below ₹0 somewhere in this period.
		var shortLabel = c.unit === 'day' ? 'this day' : ('a day this ' + c.unit);
		var shortFlag = c.shortfall ? `<span class="short-flag" title="Cash shortfall — money in hand + scheduled receipts won't cover scheduled payments on ${shortLabel} (low: ${this.fmtShort(c.minBal)})">⚠</span>` : '';
		var tag = c.isToday ? '<span class="ch-tag today">Today</span>' : (c.isPast && !c.isToday ? '<span class="ch-tag past">Past</span>' : '');
		var body = c.blocks.length === 0
			? `<div class="col-empty">${c.isFuture ? 'Drop a block here to schedule it.' : c.isPast ? 'No movements pencilled in.' : 'Drag a block onto this ' + c.unit + '.'}</div>`
			: this.columnBody(c);
		var headSel = c.level === 'day' ? ` selectable" data-selday="${idx}` : '';
		return `<div class="${cls.join(' ')}">
			<div class="col-head${headSel}">
				<div class="ch-top">
					<span class="ch-name ${c.drillable ? 'drillable' : ''}" data-colidx="${idx}">${c.name}</span>
					${shortFlag}
					${tag}
					<span class="ch-net ${netCls}" ${c.net === 0 ? 'style="color:var(--faint)"' : ''}>${netStr}</span>
				</div>
				${c.range ? `<div class="ch-range">${c.range}${c.drillable ? ' · click to drill ▸' : ''}</div>` : ''}
			</div>
			<div class="col-stats">
				<span class="io pos">▲ ${c.inflow === 0 ? '0' : this.fmtShort(c.inflow)}</span>
				<span class="io neg">▽ ${c.outflow === 0 ? '0' : this.fmtShort(Math.abs(c.outflow))}</span>
				<span class="sigma ${c.sigma < 0 ? 'negbal' : ''}"><span class="slab">Σ</span>${this.fmtShort(c.sigma)}</span>
			</div>
			<div class="col-body" data-colidx="${idx}">${body}</div>
		</div>`;
	}

	// Compact at rest (name + bold amount + tiny timing); on hover the card lifts and
	// expands a detail row (ref · due date · term) and un-truncates the full name.
	renderPlaced(b, grouped) {
		var late = this.isCarriedLate(b);
		// 'auto' (restored from a save) and 'planned' (placed by the Plan tool) are both
		// app-decided, so both get the lighter "suggested" treatment; only a manual drag
		// ('user') is shown as solidly yours.
		var cls = ['placed', b.side === 'rec' ? 'rec' : 'pay']; if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd'); if (b.origin === 'auto' || b.origin === 'planned') cls.push('suggested'); if (grouped) cls.push('in-group'); if (late) cls.push('carried-late'); if (b.paid) cls.push('paid');
		// Provenance tag: paid > restored-from-save > Plan-tool > you-placed-it-by-hand.
		var tag = b.paid ? '<span class="ptag paid">✓ paid</span>'
			: b.origin === 'auto' ? '<span class="ptag auto">auto</span>'
			: b.origin === 'planned' ? '<span class="ptag planned">✦ planned</span>'
			: '<span class="ptag user">✓ you</span>';
		var rw = this.relWhen(b.due);
		// Placed-date only matters when the card isn't already inside a same-day group.
		var datePill = grouped ? '' : `<span class="pdate" title="placed">${this.dstr(b.placedDate)}</span>`;
		var term = b.term && b.term !== '—' ? ' · ' + this.esc(b.term) : '';
		// Carried-late banner: the card sits on/after today but the real due date is
		// already past — keep that unmistakable so it never reads as an on-time plan.
		// Only claim "placed today" when it genuinely is today.
		var lateBanner = late
			? `<div class="late-banner" title="Due date already passed — planned forward so this payment isn't lost">⏱ Was due ${this.dstr(b.due)} · ${this.daysLate(b)}d late${this.sameDay(b.placedDate, TODAY) ? ' · placed today' : ''}</div>`
			: '';
		return `<div class="${cls.join(' ')}" draggable="true" data-id="${this.esc(b.id)}">
			<div class="ptop">${tag}${this.isFragment(b) ? '<span class="part-chip" title="Split piece">part</span>' : ''}<span class="pname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</span><span style="flex:1"></span>${this.isFragment(b) ? `<button class="merge-back" data-merge="${this.esc(b.id)}" title="Merge this piece back into the invoice">↩</button>` : ''}${b.facility ? '' : this.paidBtn(b)}</div>
			<div class="prow"><span class="pamt${b.facility ? '' : ' editable'}"${b.facility ? '' : ' title="Click to edit — type a smaller value to part-pay"'}>${this.fmtShort(b.amountP)}</span><span class="due-pill ${rw.cls} pwhen">${rw.txt}</span></div>
			${b.facility ? '' : `<div class="pref" title="${this.esc(this.idText(b))}">${this.esc(this.idText(b))}</div>`}
			${lateBanner}
			<div class="pdetail">
				<span class="pid" title="${this.esc(b.ref)}">${this.esc(b.ref)}</span>
				<span class="pdue">due ${this.dstr(b.due)}${term}</span>
				${this.termBadge(b)}
				${datePill}
			</div>
		</div>`;
	}

	ledgerVal(b, key) {
		switch (key) {
			case 'name': return b.entity.toLowerCase();
			case 'term': return (b.term || '').toLowerCase();
			case 'order': return b.orderValueP || Math.abs(b.amountP);
			case 'outstanding': return Math.abs(b.amountP);
			default: return b.due.getTime(); // 'final'
		}
	}

	sortLedgerRows(rows, side) {
		var me = this, keys = this.ledgerSort[side] || [];
		if (!keys.length) return rows.slice();
		return rows.slice().sort((a, b) => {
			for (var i = 0; i < keys.length; i++) {                 // priority = array order
				var k = keys[i], dir = k.direction === 'desc' ? -1 : 1;
				var va = me.ledgerVal(a, k.column), vb = me.ledgerVal(b, k.column);
				if (va < vb) return -1 * dir;
				if (va > vb) return 1 * dir;
			}
			return 0;                                               // equal on every key → stable
		});
	}

	// Header-click cycle, shared model with the standalone ledger page:
	//   off → asc(1) → desc(2) → asc(3) → off.  additive (shift/ctrl/cmd) keeps the
	//   other columns and appends/cycles this one; plain click collapses to this one.
	cycleLedgerSort(side, col, additive) {
		var keys = this.ledgerSort[side] || (this.ledgerSort[side] = []);
		var idx = keys.findIndex(k => k.column === col);
		if (idx >= 0) {
			// Already a sort level — cycle THIS column in place and keep every other
			// level untouched (plain or modifier click; toggling one must never drop
			// the others). 4th step removes just this column.
			this._advanceSortStep(keys, idx);
		} else if (additive) {
			keys.push({ column: col, direction: 'asc', step: 1 });   // add a new level
		} else {
			this.ledgerSort[side] = [{ column: col, direction: 'asc', step: 1 }]; // fresh single sort
		}
	}
	_advanceSortStep(keys, idx) {
		var k = keys[idx];
		k.step = (k.step || 1) + 1;
		if (k.step >= 4) { keys.splice(idx, 1); return; }       // 4th click clears the column
		k.direction = (k.step === 2) ? 'desc' : 'asc';          // 1,3 → asc · 2 → desc
	}

	renderLedger() {
		var th = (side, key, label, right) => {
			var keys = this.ledgerSort[side] || [];
			var idx = keys.findIndex(k => k.column === key);
			var active = idx >= 0;
			var arrow = active ? (keys[idx].direction === 'desc' ? ' ▾' : ' ▴') : '';
			var pri = (active && keys.length > 1) ? `<span class="sort-pri">${idx + 1}</span>` : '';
			return `<th class="${right ? 'r ' : ''}sortable${active ? ' active' : ''}" data-sort="${key}" data-side="${side}" title="Click to sort · Shift/Ctrl-click to add another sort level">${label}${arrow}${pri}</th>`;
		};
		var panel = (side, title) => {
			var rows = this.blocks.filter(b => side === 'pay' ? (b.side === 'pay' && !b.facility) : b.side === 'rec');
			var out = rows.reduce((s, b) => s + Math.abs(b.amountP), 0);
			var ord = rows.reduce((s, b) => s + (b.orderValueP || Math.abs(b.amountP)), 0);
			var sorted = this.sortLedgerRows(rows, side).slice(0, 80);
			var trs = sorted.map(b => {
				var od = Math.round((this.startOfDay(TODAY) - this.startOfDay(b.due)) / 86400000);
				return `<tr>
					<td><div class="lname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</div><div class="lgrp">${this.esc(b.ref)}</div></td>
					<td><span class="term term-edit" data-editterm="${this.esc(b.id)}" title="Click to edit the credit term or set a one-off date">${this.esc(b.term)}</span> ${this.termBadge(b)}</td>
					<td class="num"><div class="dbill">${this.dstr(b.billDate)}</div><div class="dfinal${b.termEdited === 'date' ? ' moved' : ''}">${this.dstr(b.due)}</div>${b.termEdited === 'date' && b.dueOriginal ? `<div class="was-date" title="Original term-implied due date">was ${this.dstr(b.dueOriginal)}</div>` : ''}${b.overdue ? `<div class="odbadge" style="margin-top:2px">OD ${od}d</div>` : ''}</td>
					<td class="num r" style="color:var(--muted)">${this.fmtShort(b.orderValueP || Math.abs(b.amountP))}</td>
					<td class="num r" style="font-weight:700">${this.fmtShort(Math.abs(b.amountP))}</td>
				</tr>`;
			}).join('');
			return `<div class="lz-panel ${side}">
				<div class="lp-head"><span class="dot"></span>${title}<span class="lp-out">Order ${this.fmtShort(ord)} · Outstanding ${this.fmtShort(out)}</span></div>
				<div class="lp-scroll"><table class="ledger">
					<thead><tr>${th(side, 'name', side === 'pay' ? 'Supplier' : 'Customer')}${th(side, 'term', 'Term')}${th(side, 'final', 'Bill · Final')}${th(side, 'order', 'Order value', true)}${th(side, 'outstanding', 'Outstanding', true)}</tr></thead>
					<tbody>${trs}</tbody>
				</table></div>
			</div>`;
		};
		return `<div class="ledger-zone ${this.ledgerOpen ? '' : 'collapsed'}">
			<div class="lz-head" id="cfp-ledger-head">
				<span class="lztitle">Credit terms ledger</span>
				<span class="lzsub">per-invoice reference · see the full picture so nothing is missed</span>
				<span class="tw">▲</span>
			</div>
			<div class="lz-body">
				${panel('pay', 'Payables — what we owe vendors')}
				${panel('rec', 'Receivables — what customers owe us')}
			</div>
		</div>`;
	}

	toast(msg) {
		this.wrapper.find('.cfp-toast').remove();
		var $t = $(`<div class="cfp-toast">${this.esc(msg)}</div>`);
		this.wrapper.find('#cfp-app').append($t);
		clearTimeout(this._toastT);
		this._toastT = setTimeout(() => $t.remove(), 2200);
	}

	/* Loading / error overlay over the whole board. kind = 'loading' | 'error'. */
	showStatus(kind, msg) {
		var me = this, $app = this.wrapper.find('#cfp-app');
		var $o = $app.find('.cfp-status-overlay');
		if (!$o.length) { $o = $('<div class="cfp-status-overlay"></div>'); $app.append($o); }
		var inner = kind === 'error'
			? `<div class="cfp-status-icon">⚠</div><div class="cfp-status-msg">${this.esc(msg)}</div><button class="cfp-status-retry">Retry</button>`
			: `<div class="cfp-spinner"></div><div class="cfp-status-msg">${this.esc(msg)}</div>`;
		$o.attr('class', 'cfp-status-overlay show' + (kind === 'error' ? ' error' : '')).html(inner);
		$o.find('.cfp-status-retry').on('click', () => me.load_data());
	}
	hideStatus() { this.wrapper.find('#cfp-app .cfp-status-overlay').removeClass('show error').empty(); }

	/* ===================== events (delegated, bound once) ===================== */
	bind_events() {
		var me = this, $w = this.wrapper;

		// Toolbar
		$w.on('click', '#cfp-undo', () => me.undo());
		$w.on('click', '#cfp-redo', () => me.redo());
		$w.on('change', '#cfp-opening', function() {
			var v = parseFloat($(this).val());
			if (isNaN(v)) { me.toast('Opening cash must be a number in lakhs — e.g. 80 = ₹80L'); me.render(); return; }
			me.openingP = Math.round(v * 1e5 * PAISE);   // lakhs entered → paise
			// Units sanity: this field is LAKHS. Over 1,00,000 L (₹1,000 Cr) on an SMB
			// board almost always means the user typed rupees by mistake — warn, but
			// still apply (non-destructive; they may genuinely mean it).
			if (Math.abs(v) > 1e5) me.toast('Heads up: that’s ' + me.fmtShort(me.openingP) + ' — this field is in lakhs (80 = ₹80L)');
			me.render();
		});
		$w.on('click', '#cfp-save', () => me.save());
		$w.on('click', '#cfp-publish', () => me.publishPlanner(false));
		$w.on('click', '#cfp-behind', () => me.confirmReloadShared());
		$w.on('click', '#cfp-focus', () => me.toggleFocus());
		// Curtain collapse / expand (works for both the in-panel button and the rail)
		$w.on('click', '[data-curtain]', function(e) { e.stopPropagation(); var s = $(this).data('curtain'); if (s === 'pay') me.payOpen = !me.payOpen; else me.recOpen = !me.recOpen; me.render(); });
		// Reservoir section toggles (Upcoming / Scheduled)
		$w.on('click', '.sec-head', function() { var sec = $(this).data('sec'), side = $(this).data('side'); me.resSec[side][sec] = !me.resSec[side][sec]; me.render(); });
		// Jump to a committed block from the Scheduled section (drag still reschedules)
		$w.on('click', '.sched-card', function(e) { if ($(e.target).closest('.merge-back, .amt-edit, .paid-toggle').length) return; me.gotoScheduled($(this).data('goto')); });
		// Expand/collapse a same-company group inside a timeline column
		$w.on('click', '.pg-head', function() { var k = $(this).data('group'); me.openColGroups[k] = !$(this).hasClass('open'); me.render(); });
		$w.on('click', '#cfp-plan-btn', function(e) { e.stopImmediatePropagation(); me.planOpen = !me.planOpen; me.moreOpen = false; me.render(); });
		$w.on('click', '#cfp-plan-menu .item', function() { me.planPeriod($(this).data('plan')); });
		$w.on('click', '#cfp-more-btn', function(e) { e.stopImmediatePropagation(); me.moreOpen = !me.moreOpen; me.planOpen = false; me.render(); });
		$w.on('click', '#cfp-more-menu .item', function() { me.planAction($(this).data('action')); });
		// close menus on outside click
		$w.on('click', function(e) {
			var inWrap = $(e.target).closest('.menu-wrap').length;
			if ((me.planOpen || me.moreOpen) && !inWrap) { me.planOpen = false; me.moreOpen = false; me.render(); }
		});

		// Zoom segmented + breadcrumb up
		$w.on('click', '.zseg button', function() { me.setLevel($(this).data('level')); });
		$w.on('click', '.crumb .up', function() { me.setLevel($(this).data('level')); });

		// Drill via column head
		$w.on('click', '.ch-name.drillable', function() { var c = me.cols[$(this).data('colidx')]; if (c && c.drillTarget) { Object.assign(me.view, c.drillTarget); if (c.drillTarget.level === 'week') me.view.day = null; me._scrollPending = true; me.render(); } });
		// Select a day (the "Plan day" target) at the week level
		$w.on('click', '.col-head.selectable', function() { var c = me.cols[$(this).data('selday')]; if (c) { me.view.day = new Date(c.start); me.render(); } });
		// Ledger column sort
		$w.on('click', '.ledger th.sortable', function(e) { var side = $(this).data('side'), key = $(this).data('sort'); me.cycleLedgerSort(side, key, e.shiftKey || e.ctrlKey || e.metaKey); me.render(); });

		// Reservoir search + pills + folders
		$w.on('input', '.res-search', function() { me.search[$(this).data('side')] = $(this).val(); me.render(); });
		$w.on('click', '.pill', function() { var s = $(this).data('side'), k = $(this).data('filter'); me.filters[s][k] = !me.filters[s][k]; me.render(); });
		$w.on('click', '.folder-head', function() { var key = $(this).data('folder'); me.openFolders[key] = !$(this).hasClass('open'); me.render(); });

		// Ledger collapse
		$w.on('click', '#cfp-ledger-head', () => { me.ledgerOpen = !me.ledgerOpen; me.render(); });

		// Inline amount editing (partial payment) + merge-back. mousedown is stopped
		// so grabbing the amount/↩ on a draggable card doesn't kick off a drag.
		$w.on('mousedown', '.bamt.editable, .pamt.editable, .merge-back, .paid-toggle, [data-editterm]', function(e) { e.stopPropagation(); });
		$w.on('click', '.bamt.editable, .pamt.editable', function(e) { e.stopPropagation(); e.preventDefault(); me.beginInlineEdit($(this)); });
		$w.on('click', '.merge-back', function(e) { e.stopImmediatePropagation(); e.preventDefault(); me.mergeBack($(this).data('merge')); });
		// Mark paid / unpaid — planning-only sticker, never touches the real invoice.
		$w.on('click', '.paid-toggle', function(e) { e.stopImmediatePropagation(); e.preventDefault(); me.togglePaid($(this).data('paid')); });
		// Edit a bill's credit term / set a one-off date — opens the dialog.
		$w.on('click', '[data-editterm]', function(e) { e.stopImmediatePropagation(); e.preventDefault(); me.editTerm($(this).data('editterm')); });

		// Drag & drop (HTML5, delegated)
		$w.on('dragstart', '.block, .placed', function(e) {
			if (me._inlineEditing || $(e.target).is('input.amt-edit, .merge-back, .paid-toggle, [data-editterm]')) { e.preventDefault(); return false; }
			me.dragId = $(this).data('id');
			try { e.originalEvent.dataTransfer.setData('text/id', me.dragId); e.originalEvent.dataTransfer.effectAllowed = 'move'; } catch (err) {}
			$(this).addClass('dragging');
		});
		$w.on('dragend', '.block, .placed', function() { $(this).removeClass('dragging'); });
		$w.on('dragover', '.col-body, .res-body', function(e) { e.preventDefault(); $(this).addClass('drop-active'); });
		$w.on('dragleave', '.col-body, .res-body', function() { $(this).removeClass('drop-active'); });
		$w.on('drop', '.col-body', function(e) {
			e.preventDefault(); $(this).removeClass('drop-active');
			var id = me.dragId; var c = me.cols[$(this).data('colidx')];
			if (id && c) me.dropOnColumn(id, c); me.dragId = null; me.render();
		});
		$w.on('drop', '.res-body', function(e) {
			e.preventDefault(); $(this).removeClass('drop-active');
			var id = me.dragId; if (id) me.unplace(id); me.dragId = null; me.render();
		});
	}

	setLevel(lvl) {
		if (lvl === 'year') this.view.level = 'year';
		else if (lvl === 'month') { this.view.level = 'month'; if (this.view.month == null) this.view.month = 5; }
		else { this.view.level = 'week'; if (!this.view.weekStart) this.view.weekStart = new Date(HORIZON_START); }
		this._scrollPending = true;
		this.render();
	}

	/* ===================== period planning ===================== */
	// Plan year/month/week/day: schedule every unscheduled invoice whose DUE date
	// falls in the period you're currently navigated to, onto its due date.
	planPeriod(level) {
		this.planOpen = false;
		var me = this, v = this.view, count = 0, match;
		if (level === 'year') match = d => d.getFullYear() === v.year;
		else if (level === 'month') match = d => d.getFullYear() === v.year && d.getMonth() === v.month;
		else if (level === 'week') {
			var ws = this.mondayOnOrBefore(v.weekStart || HORIZON_START), we = this.addDays(ws, 6);
			match = d => { var x = me.startOfDay(d); return x >= ws && x <= we; };
		} else {
			var day = v.day || this.mondayOnOrBefore(v.weekStart || HORIZON_START);
			match = d => me.sameDay(d, day);
		}
		var today = this.startOfDay(TODAY), carried = 0;
		var next = this.blocks.map(b => {
			if (b.placedDate || b.facility) return b;
			if (match(b.due)) {
				count++;
				// Never schedule a payment in the past — if it's already overdue, carry
				// it to today (it shows a "was due …" badge so the lateness stays visible).
				var d = me.startOfDay(b.due);
				if (d < today) { d = today; carried++; }
				// Placed by the Plan tool (app chose the date), not a manual drag → 'planned'.
				return Object.assign({}, b, { placedDate: d, origin: 'planned' });
			}
			return b;
		});
		if (count) {
			this.commit(next);
			var msg = 'Planned ' + count + ' invoice' + (count > 1 ? 's' : '') + ' due in this ' + level;
			if (carried) msg += ' · ' + carried + ' overdue moved to today';
			this.toast(msg);
		}
		else this.toast('Nothing unscheduled is due in this ' + level);
		this.render();
	}

	// Carry EVERY unscheduled, already-overdue invoice onto today in one move. A
	// payment you haven't transacted yet can't sit in the past — landing it on today
	// makes it actionable now, and each card keeps a "was due …" badge so the real
	// (past) due date stays visible. Undoable like any other placement.
	placeOverdueOnToday() {
		var me = this, today = this.startOfDay(TODAY), n = 0;
		var next = this.blocks.map(b => {
			if (b.placedDate || b.facility) return b;
			// App-chosen placement (onto today) triggered by a click → 'planned', not 'you'.
			if (me.startOfDay(b.due) < today) { n++; return Object.assign({}, b, { placedDate: today, origin: 'planned' }); }
			return b;
		});
		if (n) { this.commit(next); this.toast('Moved ' + n + ' overdue item' + (n > 1 ? 's' : '') + ' onto today — each still shows its original due date'); }
		else this.toast('No overdue items waiting — nothing to carry forward');
		this.render();
	}

	/* ===================== actions / persistence ===================== */
	planAction(action) {
		this.moreOpen = false; this.planOpen = false;
		if (action === 'save') this.save();
		else if (action === 'publish') this.publishPlanner(false);
		else if (action === 'reload-shared') this.confirmReloadShared();
		else if (action === 'saveas') this.saveAs();
		else if (action === 'load') this.loadPlans();
		else if (action === 'fresh') this.startFresh();
		else if (action === 'overdue') this.placeOverdueOnToday();
		else if (action === 'merge') this.mergeAllFragments();
		else if (action === 'export') this.exportCsv();
		else if (action === 'reset') this.reset();
		else this.render();
	}

	schedulesMap() { var m = {}; this.placed.forEach(b => { if (!b.facility) m[b.id] = this.dateToKey(b.placedDate); }); return m; }
	// Persist only the meaningful provenance ('user'/'planned'); a placed block absent
	// here restores as 'auto', which is exactly "restored from a save".
	originsMap() { var m = {}; this.placed.forEach(b => { if (!b.facility && (b.origin === 'user' || b.origin === 'planned')) m[b.id] = b.origin; }); return m; }

	/* ===================== credit-term editing =====================
	   A bill's credit term is best-effort from the Tally import. The user can
	   correct it two ways, chosen in the dialog:
	     • "the supplier's credit term" → fixes the TERM itself (recomputes the due
	       date) and offers to apply to the supplier's other unverified bills.
	     • "a one-off date move"        → leaves the term, just shifts THIS bill's
	       date; the card shows it was manually moved.
	   Overrides persist immediately (save_term_override), keyed by the invoice id
	   (= the split family root), so they survive reload without a full Save. ===== */
	editTerm(id) {
		var me = this;
		var b = this.blocks.find(x => x.id === id);
		if (!b || b.facility) return;
		var name = this.rootOf(b);                       // a split piece edits its parent invoice
		var billDate = b.billDate || TODAY;
		// Preset day buckets; 'custom' reveals a free day field.
		var DAY_PRESETS = [
			{ value: '0', label: 'Due on receipt' }, { value: '15', label: 'Net 15' },
			{ value: '30', label: 'Net 30' }, { value: '45', label: 'Net 45' },
			{ value: '60', label: 'Net 60' }, { value: '90', label: 'Net 90' },
			{ value: 'custom', label: 'Custom…' }
		];
		// Seed the form from the current state so re-opening shows what's set.
		var curDays = /Net\s+(\d+)/.exec(b.term || '');
		var seedDays = curDays ? curDays[1] : '0';
		var seedPreset = DAY_PRESETS.some(p => p.value === seedDays) ? seedDays : 'custom';
		var srcNote = b.termUnverified
			? '<span style="color:var(--out,#c0392b)">unverified — best-effort “Due on receipt”</span>'
			: 'verified from Tally source';

		var d = new frappe.ui.Dialog({
			title: 'Credit term — ' + (b.ref || name),
			fields: [
				{ fieldtype: 'HTML', fieldname: 'cur', options:
					'<div style="font-size:12px;color:var(--text-muted,#6b7280);margin-bottom:4px">'
					+ 'Current: <b>' + frappe.utils.escape_html(b.term || '—') + '</b> · due <b>'
					+ this.dstr(b.due) + '</b><br>Bill date ' + this.dstr(billDate) + ' · ' + srcNote + '</div>' },
				{ fieldtype: 'Select', fieldname: 'scope', label: 'This is', reqd: 1,
					default: b.termEdited === 'date' ? 'date' : 'term',
					options: [
						{ value: 'term', label: "The supplier's credit term (corrects it going forward)" },
						{ value: 'date', label: 'A one-off date move (this bill only — term unchanged)' }
					] },
				{ fieldtype: 'Select', fieldname: 'preset', label: 'Credit term',
					default: seedPreset, options: DAY_PRESETS, depends_on: "eval:doc.scope=='term'" },
				{ fieldtype: 'Int', fieldname: 'custom_days', label: 'Custom days',
					default: seedDays, depends_on: "eval:doc.scope=='term' && doc.preset=='custom'" },
				{ fieldtype: 'Date', fieldname: 'due_date', label: 'New due date',
					default: this.dateToKey(b.due), depends_on: "eval:doc.scope=='date'" },
				{ fieldtype: 'HTML', fieldname: 'preview', options: '' }
			],
			primary_action_label: 'Save',
			primary_action: function(v) {
				var ov = me._buildTermOverride(b, v);
				if (!ov) return;                          // validation already toasted
				d.hide();
				me.saveTermOverride(name, ov, b);
			}
		});

		// Live preview of the resulting term/date as the user edits.
		var refresh = function() {
			var v = d.get_values(true) || {};
			d.fields_dict.preview.$wrapper.html(me._termPreviewHtml(b, v));
		};
		['scope', 'preset', 'custom_days', 'due_date'].forEach(function(f) {
			if (d.fields_dict[f]) d.fields_dict[f].df.onchange = refresh;
		});

		// Offer a Reset when an override is currently in effect.
		if (b.termEdited) {
			d.set_secondary_action_label('Reset to source');
			d.set_secondary_action(function() { d.hide(); me.saveTermOverride(name, null, b); });
		}
		d.show();
		refresh();
	}

	// Turn the chosen days/preset into {days, label}. days 0 ⇒ "Due on receipt".
	_termSpec(v) {
		var days = v.preset === 'custom' ? (parseInt(v.custom_days, 10) || 0) : (parseInt(v.preset, 10) || 0);
		return { days: days, label: days ? 'Net ' + days : 'Due on receipt' };
	}

	_termPreviewHtml(b, v) {
		if (v.scope === 'date') {
			if (!v.due_date) return '<div style="font-size:12px;color:var(--text-muted,#6b7280)">Pick a new due date.</div>';
			var nd = this.keyToDate(v.due_date), od = this.daysBetween(b.due, nd), sign = od > 0 ? '+' : '';
			return '<div style="font-size:12px">→ due <b>' + this.dstr(nd) + '</b> · <b>' + sign + od + 'd</b> vs current'
				+ ' <span style="color:var(--text-muted,#6b7280)">(credit term “' + frappe.utils.escape_html(b.term) + '” unchanged)</span></div>';
		}
		var s = this._termSpec(v), due = s.days ? this.addDays(b.billDate || TODAY, s.days) : (b.billDate || TODAY);
		return '<div style="font-size:12px">→ <b>' + frappe.utils.escape_html(s.label) + '</b> · new due <b>' + this.dstr(due) + '</b>'
			+ ' <span style="color:var(--text-muted,#6b7280)">(from bill date ' + this.dstr(b.billDate || TODAY) + ')</span></div>';
	}

	_buildTermOverride(b, v) {
		if (v.scope === 'date') {
			if (!v.due_date) { this.toast('Pick a new due date for the one-off move'); return null; }
			return { kind: 'date', due_date: this.toDMY(this.keyToDate(v.due_date)) };
		}
		var s = this._termSpec(v);
		if (v.preset === 'custom' && !(s.days > 0)) { this.toast('Enter a positive number of credit days'); return null; }
		return { kind: 'term', days: s.days, term_label: s.label };
	}

	// Persist one bill's override (or null to clear), patch the live board in place
	// (so unsaved scheduling isn't lost), then offer to fan a standing term out to
	// the supplier's other unverified bills.
	saveTermOverride(name, override, srcBlock) {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_term_override',
			args: { invoice_name: name, override: override ? JSON.stringify(override) : '' },
			callback: function(r) {
				var meta = (r.message && r.message.override) || override || null;
				if (meta) me.termOverrides[name] = meta; else delete me.termOverrides[name];
				me._applyTermLocally(name, override, meta);
				if (!override) { me.toast('Reverted to the source term'); me.render(); return; }
				if (override.kind === 'term') me.toast('Credit term set to ' + (override.term_label));
				else me.toast('Date moved (one-off) — term unchanged');
				me.render();
				// Standing term correction → offer to apply to sibling unverified bills.
				if (override.kind === 'term' && srcBlock) me._offerApplyToSiblings(srcBlock, override);
			}
		});
	}

	// Patch every block of this invoice family (the bill + any split pieces) so the
	// edit shows immediately without a reload. Mirrors the server's _apply_term_override.
	_applyTermLocally(name, override, meta) {
		var me = this;
		this.blocks.filter(b => me.rootOf(b) === name).forEach(function(b) {
			if (!override) {                              // reset → restore the source values
				b.term = b.srcTerm; b.due = new Date(b.srcDue);
				b.termEdited = null; b.termOriginal = null; b.dueOriginal = null;
				b.termEditedBy = null; b.termEditedAt = null;
				b.termVerified = b.srcTerm !== 'Due on receipt'; b.termUnverified = !b.termVerified;
			} else if (override.kind === 'term') {
				b.termOriginal = b.srcTerm; b.dueOriginal = new Date(b.srcDue);
				b.term = override.term_label;
				b.due = override.days ? me.addDays(b.billDate || TODAY, override.days) : new Date(b.billDate || TODAY);
				b.termEdited = 'term'; b.termVerified = true; b.termUnverified = false;
				b.termEditedBy = meta && meta.edited_by; b.termEditedAt = meta && meta.edited_at;
			} else {                                      // one-off date move
				b.dueOriginal = new Date(b.srcDue); b.termOriginal = b.srcTerm;
				b.due = me.parseDMY(override.due_date);
				b.termEdited = 'date';
				b.termEditedBy = meta && meta.edited_by; b.termEditedAt = meta && meta.edited_at;
			}
			// Overdue state follows the (possibly new) due date.
			b.overdue = me.startOfDay(b.due) < me.startOfDay(TODAY);
		});
	}

	// After a standing-term correction, find this supplier's OTHER still-unverified
	// bills and offer to apply the same term — never silently (per the design).
	_offerApplyToSiblings(srcBlock, override) {
		var me = this;
		var sibs = this.blocks.filter(b => !b.facility && b.entity === srcBlock.entity
			&& this.rootOf(b) !== this.rootOf(srcBlock) && b.termUnverified && b.termEdited == null);
		// De-dupe by invoice root (split pieces share one bill).
		var roots = {}; sibs.forEach(b => { roots[me.rootOf(b)] = true; });
		var names = Object.keys(roots);
		if (!names.length) return;
		frappe.confirm(
			'Apply <b>' + frappe.utils.escape_html(override.term_label) + '</b> to '
			+ names.length + ' other unverified ' + frappe.utils.escape_html(srcBlock.entity)
			+ ' bill' + (names.length > 1 ? 's' : '') + ' too?',
			function() {
				var pending = names.length;
				names.forEach(function(nm) {
					frappe.call({
						method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_term_override',
						args: { invoice_name: nm, override: JSON.stringify(override) },
						callback: function(r) {
							var meta = (r.message && r.message.override) || override;
							me.termOverrides[nm] = meta;
							me._applyTermLocally(nm, override, meta);
							if (--pending === 0) { me.toast('Applied to ' + names.length + ' more bill' + (names.length > 1 ? 's' : '')); me.render(); }
						}
					});
				});
			}
		);
	}

	// Persist the current board to THIS USER'S private draft (not the shared board).
	// cb(resp) runs on success — used by Publish/Save-as to chain on a fresh draft.
	_saveDraft(cb) {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_planner_data',
			args: { opening_balance: this.openingP / (1e5 * PAISE), opening_balance_paise: Math.round(this.openingP),
				horizon: this.horizonWeeks + ' wks', scenario: 'Realistic',
				schedules: JSON.stringify(this.schedulesMap()), origins: JSON.stringify(this.originsMap()), notes: JSON.stringify(this.notes || {}),
				custom_amounts: JSON.stringify({}), fragments: JSON.stringify(this.fragmentsMap()),
				paid: JSON.stringify(this.paidMap()), term_overrides: JSON.stringify(this.termOverrides || {}) },
			callback: function(r) { if (cb) cb(r && r.message); }
		});
	}

	save() {
		var me = this;
		this._saveDraft(function() { me.planOpen = false; me.toast('Draft saved (private — Publish to share)'); me.render(); });
	}

	// Promote this user's draft to the shared board. Saves the draft first (so the
	// latest edits go up), then publishes under an optimistic lock. If someone else
	// published since we forked, the server returns a conflict and we ask the user.
	publishPlanner(force) {
		var me = this;
		this._saveDraft(function() {
			frappe.call({
				method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.publish_planner',
				args: { force: force ? 1 : 0 },
				callback: function(r) {
					var m = (r && r.message) || {};
					if (m.status === 'conflict') { me._publishConflict(m); return; }
					me.baseRev = m.rev; me.sharedRev = m.rev; me.behind = false;
					me.publishedBy = m.published_by; me.planOpen = false; me.moreOpen = false;
					me.toast('Published to the shared board (rev ' + m.rev + ')');
					me.render();
				}
			});
		});
	}

	// Conflict resolver: another user published after we forked. Offer to overwrite
	// (force) or to take theirs (reload, discarding our draft). Never silent.
	_publishConflict(m) {
		var me = this;
		var who = m.published_by ? frappe.utils.escape_html(m.published_by) : 'another user';
		var when = m.published_at ? ' (' + frappe.utils.escape_html(String(m.published_at).replace('T', ' ').slice(0, 16)) + ')' : '';
		var dlg = new frappe.ui.Dialog({
			title: 'Shared board changed',
			fields: [{ fieldtype: 'HTML', options:
				'<div style="font-size:13px;line-height:1.5">The shared board was published by <b>' + who + '</b>' + when
				+ ', after you started editing.<br><br>Publishing now would <b>overwrite their changes</b>. You can:'
				+ '<ul style="margin:8px 0 0 18px;padding:0">'
				+ '<li><b>Reload shared</b> — take their version (discards your unpublished draft).</li>'
				+ '<li><b>Force publish</b> — overwrite their changes with yours.</li></ul></div>' }],
			primary_action_label: 'Force publish',
			primary_action: function() { dlg.hide(); me.publishPlanner(true); }
		});
		dlg.set_secondary_action_label('Reload shared');
		dlg.set_secondary_action(function() { dlg.hide(); me.reloadShared(); });
		dlg.show();
	}

	// Confirm before discarding the draft (the menu/chip entry point).
	confirmReloadShared() {
		var me = this;
		frappe.confirm(
			'Reload the shared board? This <b>discards your unpublished draft changes</b> and loads the latest published board' + (this.publishedBy ? ' (by ' + frappe.utils.escape_html(this.publishedBy) + ')' : '') + '.',
			function() { me.reloadShared(); }
		);
	}

	// Discard this user's draft and re-fork from the latest shared board.
	reloadShared() {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.discard_draft',
			callback: function() { me.toast('Loaded the shared board'); me.past = []; me.future = []; me.load_data(); }
		});
	}

	saveAs() {
		var me = this;
		frappe.prompt({ label: 'Plan name', fieldname: 'plan_name', fieldtype: 'Data', reqd: 1 }, function(v) {
			// Save the draft first, THEN snapshot it into the shared plan library, so
			// the named plan reflects the latest edits (no save/snapshot race).
			me._saveDraft(function() {
				frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_named_plan',
					args: { plan_name: v.plan_name }, callback: function() { me.toast('Saved as “' + v.plan_name + '” (shared library)'); } });
			});
		}, 'Save plan as', 'Save');
	}

	loadPlans() {
		var me = this;
		frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.list_named_plans', callback: function(r) {
			var plans = r.message || [];
			if (!plans.length) { me.toast('No saved plans yet'); me.render(); return; }
			frappe.prompt({ label: 'Plan', fieldname: 'plan_name', fieldtype: 'Select', options: plans.map(p => p.plan_name).join('\n'), reqd: 1 }, function(v) {
				frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.load_named_plan', args: { plan_name: v.plan_name }, callback: function(r2) {
					var cfg = r2.message || {};
					if (cfg.opening_balance_paise != null) me.openingP = Math.round(parseFloat(cfg.opening_balance_paise));
					else if (cfg.opening_balance != null) me.openingP = Math.round(parseFloat(cfg.opening_balance) * 1e5 * PAISE);
					if (cfg.horizon) me.horizonWeeks = parseInt(cfg.horizon) || 6;
					var sched = cfg.schedules || {}, paid = cfg.paid || {};
					me.origins = cfg.origins || {};
					me.blocks = me.blocks.map(b => { var k = sched[b.id]; return Object.assign({}, b, { placedDate: k ? me.keyToDate(k) : null, origin: k ? (me.origins[b.id] || 'auto') : null, paid: !!paid[b.id] }); });
					// Re-apply this plan's credit-term overrides; invoices not in the map
					// revert to their source term (so switching plans is clean).
					me.termOverrides = cfg.term_overrides || {};
					var roots = {}; me.blocks.forEach(b => { if (!b.facility) roots[me.rootOf(b)] = true; });
					Object.keys(roots).forEach(function(nm) { var ov = me.termOverrides[nm] || null; me._applyTermLocally(nm, ov, ov); });
					me.past = []; me.future = [];
					me.toast('Loaded “' + v.plan_name + '”'); me.render();
				}});
			}, 'Load plan', 'Load');
		}});
	}

	exportCsv() {
		var me = this;
		frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.export_planner_csv', args: { base_date: this.base_date, schedules: JSON.stringify(this.schedulesMap()), paid: JSON.stringify(this.paidMap()) }, callback: function(r) {
			var csv = r.message || ''; var blob = new Blob([csv], { type: 'text/csv' }); var url = URL.createObjectURL(blob);
			var a = document.createElement('a'); a.href = url; a.download = 'cash_flow_planner.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
			me.toast('Exported to CSV'); me.render();
		}});
	}

	reset() {
		var me = this;
		frappe.confirm('Reset your draft to the shared board? This discards your unpublished draft changes — the shared board everyone sees is untouched.', function() {
			frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.reset_planner_data', callback: function() {
				me.past = []; me.future = []; me.toast('Draft reset to the shared board'); me.load_data();
			}});
		});
	}

	// Start fresh — empty the board to plan from scratch: unschedule everything,
	// clear every ✓ paid mark, and recombine split pieces into whole invoices. No
	// data is deleted (invoices + amounts stay); it's one undoable step, saved on Save.
	// Differs from Reset, which reloads the saved seed placement from the server.
	startFresh() {
		var me = this;
		frappe.confirm(
			'Start fresh? This clears all scheduling and ✓ paid marks and recombines any split pieces, giving you an empty board to plan on. Your invoices and amounts are kept — nothing is deleted.',
			function() {
				var next = me.blocks.slice();
				// recombine any split families back into a single whole invoice
				Object.keys(me.familyCeil).forEach(function(root) {
					var fam = next.filter(x => me.rootOf(x) === root);
					if (fam.length <= 1) return;
					var keep = fam.find(x => x.id === root) || fam[0], sign = keep.amountP < 0 ? -1 : 1, ceilP = me.familyCeil[root];
					next = next.filter(x => me.rootOf(x) !== root || x.id === keep.id)
						.map(x => x.id === keep.id ? Object.assign({}, x, { amountP: sign * ceilP, orderValueP: ceilP, highValue: ceilP >= HIGH_VALUE_P, splitFrom: undefined }) : x);
				});
				// clear all scheduling + paid stickers → everything back to the side panels
				next = next.map(b => Object.assign({}, b, { placedDate: null, origin: null, paid: false }));
				me.familyCeil = {};
				me.commit(next);
				me.toast('Fresh board — everything moved back to the side panels');
				me.render();
			}
		);
	}
}
