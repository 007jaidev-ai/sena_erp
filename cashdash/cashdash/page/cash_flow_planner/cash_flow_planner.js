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
var CC_LIMIT = 6e7, BD_LIMIT = 4e7, SOFT = 0.8;
var TODAY = new Date(2026, 5, 3);                 // demo "today" — Jun 3 2026
var HORIZON_START = new Date(2026, 5, 1);          // Mon Jun 1 2026

class CashFlowPlanner {
	constructor(wrapper, page) {
		this.wrapper = $(wrapper);
		this.page = page;
		this.base_date = '2026-06-03';

		this.blocks = [];
		this.opening = 80 * 1e5;
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
		this.ledgerSort = { pay: { key: 'final', dir: 'asc' }, rec: { key: 'final', dir: 'asc' } };
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
				me.notes = (d.config && d.config.notes) || {};
				if (d.config && d.config.opening_balance != null) me.opening = parseFloat(d.config.opening_balance) * 1e5;
				if (d.config && d.config.horizon) me.horizonWeeks = parseInt(d.config.horizon) || 6;

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
		var out = parseFloat(inv.outstanding) || 0;
		var key = sched[inv.name];
		var pd = key ? this.keyToDate(key) : null;
		return {
			id: inv.name, ref: inv.ref_no || inv.name, entity: inv.party, grp: inv.party_group,
			contra: !!this.contra[inv.party], side: side, type: side === 'pay' ? 'PAY' : 'REC',
			amount: side === 'pay' ? -out : out,
			due: this.parseDMY(inv.final_date), billDate: this.parseDMY(inv.bill_date),
			term: inv.credit_term || '—', orderValue: parseFloat(inv.value) || out,
			overdue: (inv.age_days || 0) > 0, priority: !!inv.priority, highValue: out >= 5e5,
			placedDate: pd, origin: pd ? 'auto' : null, facility: null
		};
	}

	// A few bank-facility lines (the backend carries no financing rows)
	addFacilityBlocks() {
		var specs = [
			['CC', 'financing', -1800000, 'Cash Credit draw'],
			['BD', 'bd', -2400000, 'Bill Discounting draw'],
			['CC', 'financing', 900000, 'CC repayment']
		];
		specs.forEach((f, i) => {
			this.blocks.push({
				id: 'FIN-' + f[0] + '-' + (401 + i), ref: 'FIN-' + f[0] + '-' + (401 + i),
				entity: f[3], grp: 'Bank facilities', contra: false,
				side: 'pay', type: f[0], facility: f[1],
				amount: f[2], due: this.addDays(TODAY, 4 + i * 7), billDate: this.addDays(TODAY, 4 + i * 7),
				term: '—', orderValue: Math.abs(f[2]), overdue: false, priority: false, highValue: true,
				placedDate: null, origin: null
			});
		});
	}

	/* ===================== date / format helpers ===================== */
	parseDMY(s) { if (!s) return new Date(TODAY); var p = String(s).split('-'); return new Date(+p[2], (+p[1]) - 1, +p[0]); }
	keyToDate(key) {
		if (/^\d{4}-\d{2}-\d{2}$/.test(key)) { var p = key.split('-'); return new Date(+p[0], (+p[1]) - 1, +p[2]); }
		if (/-W\d+$/.test(key)) { var w = parseInt(key.split('-W')[1]); return this.addDays(new Date(2026, 5, 1), (w - 23) * 7); }
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

	fmtShort(n) {
		var a = Math.abs(n), s;
		if (a >= 1e7) s = (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + 'Cr';
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
	balanceAt(t) { var s = this.opening; var ps = this.placedSorted; for (var i = 0; i < ps.length; i++) { if (ps[i].placedDate <= t) s += ps[i].amount; else break; } return s; }

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
			c.inflow = c.blocks.filter(b => b.amount > 0).reduce((s, b) => s + b.amount, 0);
			c.outflow = c.blocks.filter(b => b.amount < 0).reduce((s, b) => s + b.amount, 0);
			c.net = c.inflow + c.outflow;
			c.sigma = me.balanceAt(c.end);
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
		var horizonNet = hp.reduce((s, b) => s + b.amount, 0);
		var lowest = Infinity, lowestWk = 1;
		for (var i = 0; i < this.horizonWeeks; i++) {
			var bal = this.balanceAt(this.addDays(HORIZON_START, i * 7 + 6));
			if (bal < lowest) { lowest = bal; lowestWk = i + 1; }
		}
		if (lowest === Infinity) lowest = this.opening;
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
		var msg = `You're scheduling <b>${this.esc(b.entity)}</b> (${this.fmtShort(b.amount)}) on `
			+ `<b>${this.dstrFull(date)}</b> — that's before today (${this.dstrFull(TODAY)}).<br><br>`
			+ `The planner is forward-looking. Only place a card in the past if this ${kind} has `
			+ `<b>already happened</b>. Otherwise pick today or a future date.`;
		frappe.warn('Schedule in the past?', msg, onProceed, 'Yes — it already happened', true);
	}

	/* ===================== partial-payment splitting =====================
	   A "value block" is an obligation, so editing it really SPLITS the money
	   into pieces that must always re-sum to the original invoice. Money lives on
	   blocks as signed RUPEES (b.amount), but every split decision is computed in
	   integer PAISE so a long chain of edits can never drift a rupee in or out.
	   Invariant: for each family, Σ|piece| === familyCeil[root]. b.root is the
	   original invoice id (the family key); b.splitFrom is the sibling a piece was
	   carved from (used to merge it back). ============================== */
	toPaise(rupees) { return Math.round((parseFloat(rupees) || 0) * 100); }
	fromPaise(p) { return p / 100; }
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
		var cur = Math.round(Math.abs(b.amount) * 100) / 100;
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
		var curP = this.toPaise(Math.abs(b.amount));
		if (newP === curP) { this.render(); return; }                 // no-op — no undo entry, no 0-piece
		var sign = b.amount < 0 ? -1 : 1, root = this.rootOf(b);
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
			amount: sign * this.fromPaise(remP), orderValue: this.fromPaise(remP),
			highValue: remP >= this.toPaise(5e5), placedDate: null, origin: null
		});
		var next = this.blocks.map(x => x.id === b.id
			? Object.assign({}, x, { root: root, amount: sign * me.fromPaise(newP), orderValue: me.fromPaise(newP), highValue: newP >= me.toPaise(5e5) })
			: x);
		next.push(kept);
		this.commit(next);
		this.toast('Split ' + b.entity + ' — ' + this.fmtShort(this.fromPaise(newP)) + ' here, ' + this.fmtShort(this.fromPaise(remP)) + ' kept aside');
		this.render();
	}

	// Grow this piece up to the family ceiling by absorbing sibling pieces. Capped
	// at familyCeil so it can never invent money the party isn't owed. Pulls from
	// unscheduled siblings first, smallest first; fully-absorbed siblings dissolve.
	_growFrom(b, root, sign, curP, newP) {
		var me = this, ceilP = this.familyCeil[root];
		if (newP > ceilP) {
			this.toast('Capped at ' + this.fmtShort(this.fromPaise(ceilP)) + ' — the full invoice. Reduce or merge a piece to free room.');
			this.render(); return;
		}
		var sibs = this.blocks.filter(x => me.rootOf(x) === root && x.id !== b.id)
			.sort((a, c) => (a.placedDate ? 1 : 0) - (c.placedDate ? 1 : 0) || me.toPaise(Math.abs(a.amount)) - me.toPaise(Math.abs(c.amount)));
		var avail = sibs.reduce((s, x) => s + me.toPaise(Math.abs(x.amount)), 0), needP = newP - curP;
		if (needP > avail) {
			this.toast(avail === 0 ? 'This is the whole invoice — nothing to grow into. Reduce it instead to part-pay.'
				: 'Only ' + this.fmtShort(this.fromPaise(avail)) + ' available in sibling pieces.');
			this.render(); return;
		}
		var take = needP, dissolved = 0, shrunk = {};
		for (var i = 0; i < sibs.length && take > 0; i++) {
			var sp = me.toPaise(Math.abs(sibs[i].amount)), t = Math.min(sp, take);
			take -= t;
			if (t >= sp) { shrunk[sibs[i].id] = 0; dissolved++; } else shrunk[sibs[i].id] = sp - t;
		}
		var next = [];
		this.blocks.forEach(function(x) {
			if (x.id === b.id) { next.push(Object.assign({}, x, { root: root, amount: sign * me.fromPaise(newP), orderValue: me.fromPaise(newP), highValue: newP >= me.toPaise(5e5) })); return; }
			if (Object.prototype.hasOwnProperty.call(shrunk, x.id)) {
				if (shrunk[x.id] === 0) return;             // fully absorbed → merged away
				var ss = x.amount < 0 ? -1 : 1;
				next.push(Object.assign({}, x, { amount: ss * me.fromPaise(shrunk[x.id]), orderValue: me.fromPaise(shrunk[x.id]), highValue: shrunk[x.id] >= me.toPaise(5e5) }));
				return;
			}
			next.push(x);
		});
		this.commit(next);
		this.toast('Grew ' + b.entity + ' to ' + this.fmtShort(this.fromPaise(newP)) + (dissolved ? ' (absorbed ' + dissolved + ' piece' + (dissolved > 1 ? 's' : '') + ')' : ''));
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
		var sumP = this.toPaise(Math.abs(target.amount)) + this.toPaise(Math.abs(b.amount));
		var ts = target.amount < 0 ? -1 : 1, tid = target.id, amt = this.fmtShort(Math.abs(b.amount));
		var next = this.blocks.filter(x => x.id !== id).map(x => x.id === tid
			? Object.assign({}, x, { amount: ts * me.fromPaise(sumP), orderValue: me.fromPaise(sumP), highValue: sumP >= me.toPaise(5e5) })
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
			var keep = fam.find(x => x.id === root) || fam[0], sign = keep.amount < 0 ? -1 : 1, ceilP = me.familyCeil[root];
			next = next.filter(x => me.rootOf(x) !== root || x.id === keep.id)
				.map(x => x.id === keep.id ? Object.assign({}, x, { amount: sign * me.fromPaise(ceilP), orderValue: me.fromPaise(ceilP), highValue: ceilP >= me.toPaise(5e5), splitFrom: undefined }) : x);
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
			var sumP = fam.reduce((s, x) => s + me.toPaise(Math.abs(x.amount)), 0);
			if (Math.abs(sumP - me.familyCeil[root]) > 1) { ok = false; console.warn('[CFP] money conservation broken for ' + root + ': pieces=' + sumP + 'p, ceil=' + me.familyCeil[root] + 'p'); }
			fam.forEach(function(x) { var p = me.toPaise(Math.abs(x.amount)); if (!(p > 0) || isNaN(p)) { ok = false; console.warn('[CFP] invalid piece amount', x.id, x.amount); } });
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
					id: p.id, amount: Math.abs(p.amount),
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
			me.familyCeil[root] = fam.ceil;
			me.blocks = me.blocks.filter(b => b.id !== root);
			var sign = base.amount < 0 ? -1 : 1;
			fam.pieces.forEach(function(p) {
				var mag = Math.abs(parseFloat(p.amount) || 0);
				me.blocks.push(Object.assign({}, base, {
					id: p.id, root: root, splitFrom: p.splitFrom || undefined,
					amount: sign * mag, orderValue: mag, highValue: mag >= 5e5,
					placedDate: p.placedKey ? me.keyToDate(p.placedKey) : null,
					origin: p.placedKey ? 'user' : null
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
		var openL = (this.opening / 1e5).toFixed(2);
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
				<div class="item" data-action="overdue">⏱ Carry overdue → today</div>
				<div class="sep"></div>
				<div class="item" data-action="saveas">Save as…</div>
				<div class="item" data-action="load">Load plans…</div>
				<div class="sep"></div>
				<div class="item" data-action="merge">Merge fragments</div>
				<div class="item" data-action="export">Export CSV</div>
				<div class="sep"></div>
				<div class="item danger" data-action="reset">Reset board</div>
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
				<span class="tb-openhint" title="Full rupee value">= ${this.fmtShort(this.opening)}</span>
			</div>
			<div class="tb-spring"></div>
			<button class="btn btn-ghost" id="cfp-save">Save</button>
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
			var note = state === 'ok' ? 'Within facility' : state === 'soft' ? '⚠ Past soft limit — review before drawing more' : 'Hard limit reached — over-limit draws blocked';
			return `<div class="fac ${state}">
				<div class="fhead"><span class="fname" style="color:${color}">${name}</span>
					<span class="fval">${this.fmtShort(used)} / ${this.fmtShort(limit)}${state === 'hard' ? ' 🔒' : ''}</span></div>
				<div class="ftrack"><div class="ffill" style="width:${pct}%"></div><div class="fsoft" style="left:${SOFT * 100}%"></div></div>
				<div class="fnote">${note}</div></div>`;
		};
		var facCC = this.placed.filter(b => b.facility === 'financing' && b.amount < 0).reduce((s, b) => s + Math.abs(b.amount), 0);
		var facBD = this.placed.filter(b => b.facility === 'bd' && b.amount < 0).reduce((s, b) => s + Math.abs(b.amount), 0);
		return `
		<div class="status">
			<div class="statstrip">
				<div class="s ${nothingPlaced ? '' : (k.horizonNet >= 0 ? 'good' : '')}"><div class="k">Horizon net · ${this.horizonWeeks} wks</div><div class="v" ${(!nothingPlaced && k.horizonNet < 0) ? 'style="color:var(--out)"' : ''}>${this.fmtShort(nothingPlaced ? 0 : k.horizonNet)}</div>${nothingPlaced ? '<div class="s-note">nothing scheduled yet</div>' : ''}</div>
				<div class="s"><div class="k">Lowest cash${nothingPlaced ? '' : ' · wk ' + k.lowestWk}</div><div class="v" ${(!nothingPlaced && k.lowest < 0) ? 'style="color:var(--out)"' : ''}>${this.fmtShort(k.lowest)}</div>${nothingPlaced ? '<div class="s-note">= opening · nothing scheduled</div>' : ''}</div>
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
				<span class="bamt ${b.amount < 0 ? 'neg' : 'pos'}">${this.fmtShort(b.amount)}</span>
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
		var totalAmt = list.reduce((s, b) => s + b.amount, 0);
		var foldersHtml = names.length === 0
			? `<div class="res-empty">Nothing matches — everything here is scheduled, or filtered out.</div>`
			: names.map((n, i) => {
				var g = groups[n], total = g.items.reduce((s, x) => s + x.amount, 0);
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
		var schedTotal = schedList.reduce((s, b) => s + b.amount, 0);
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
					<span class="bamt ${b.amount < 0 ? 'neg' : 'pos'}${b.facility ? '' : ' editable'}"${b.facility ? '' : ' title="Click to edit — type a smaller value to part-pay"'}>${this.fmtShort(b.amount)}</span>
				</div>
				<div class="brow2"><span class="due-pill ${this.relWhen(b.due).cls}">${this.relWhen(b.due).txt}</span><span style="flex:1"></span><span class="card-id" title="${this.esc(this.idText(b))}">${this.esc(this.idText(b))}</span></div>
				<div class="bmeta">
					<span class="bdue">due ${this.dstr(b.due)}</span>
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
		return `<div class="timeline">
			<div class="tl-nav">
				<div class="zseg">${seg('year', 'Year')}${seg('month', 'Month')}${seg('week', 'Week')}</div>
				<span class="lvlchip">${v.level} view</span>
				<span class="crumb">${crumb}</span>
				<span class="tl-net">view net <b class="${viewNet < 0 ? 'neg' : 'pos'}">${this.fmtShort(viewNet)}</b></span>
			</div>
			<div class="tl-cols">${colsHtml}</div>
		</div>`;
	}

	// Column contents: 2+ blocks from the SAME company in one timeframe collapse
	// into a single expandable group so a busy day stays readable.
	columnBody(c) {
		var me = this, groups = {};
		c.blocks.forEach(b => { (groups[b.entity] = groups[b.entity] || []).push(b); });
		var names = Object.keys(groups).sort((a, b) => Math.abs(groups[b].reduce((s, x) => s + x.amount, 0)) - Math.abs(groups[a].reduce((s, x) => s + x.amount, 0)));
		return names.map(function(n) {
			var items = groups[n];
			if (items.length === 1) return me.renderPlaced(items[0]);
			var gkey = me.dateToKey(c.start) + '::' + items[0].side + '::' + n;
			var open = !!me.openColGroups[gkey], total = items.reduce((s, x) => s + x.amount, 0);
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
		var isSel = c.level === 'day' && this.view.day && this.sameDay(c.start, this.view.day);
		if (isSel) cls.push('sel-day');
		var netStr = c.net === 0 ? '₹0' : this.fmtShort(c.net);
		var netCls = c.net < 0 ? 'neg' : c.net > 0 ? 'pos' : '';
		var tag = c.isToday ? '<span class="ch-tag today">Today</span>' : (c.isPast && !c.isToday ? '<span class="ch-tag past">Past</span>' : '');
		var body = c.blocks.length === 0
			? `<div class="col-empty">${c.isFuture ? 'Drop a block here to schedule it.' : c.isPast ? 'No movements pencilled in.' : 'Drag a block onto this ' + c.unit + '.'}</div>`
			: this.columnBody(c);
		var headSel = c.level === 'day' ? ` selectable" data-selday="${idx}` : '';
		return `<div class="${cls.join(' ')}">
			<div class="col-head${headSel}">
				<div class="ch-top">
					<span class="ch-name ${c.drillable ? 'drillable' : ''}" data-colidx="${idx}">${c.name}</span>
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
		var cls = ['placed', b.side === 'rec' ? 'rec' : 'pay']; if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd'); if (b.origin === 'auto') cls.push('suggested'); if (grouped) cls.push('in-group'); if (late) cls.push('carried-late'); if (b.paid) cls.push('paid');
		var tag = b.paid ? '<span class="ptag paid">✓ paid</span>' : (b.origin === 'auto' ? '<span class="ptag auto">auto</span>' : '<span class="ptag user">✓ you</span>');
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
			<div class="prow"><span class="pamt${b.facility ? '' : ' editable'}"${b.facility ? '' : ' title="Click to edit — type a smaller value to part-pay"'}>${this.fmtShort(b.amount)}</span><span class="due-pill ${rw.cls} pwhen">${rw.txt}</span></div>
			${b.facility ? '' : `<div class="pref" title="${this.esc(this.idText(b))}">${this.esc(this.idText(b))}</div>`}
			${lateBanner}
			<div class="pdetail">
				<span class="pid" title="${this.esc(b.ref)}">${this.esc(b.ref)}</span>
				<span class="pdue">due ${this.dstr(b.due)}${term}</span>
				${datePill}
			</div>
		</div>`;
	}

	sortLedgerRows(rows, side) {
		var s = this.ledgerSort[side], dir = s.dir === 'desc' ? -1 : 1;
		var val = b => {
			switch (s.key) {
				case 'name': return b.entity.toLowerCase();
				case 'term': return (b.term || '').toLowerCase();
				case 'order': return b.orderValue || Math.abs(b.amount);
				case 'outstanding': return Math.abs(b.amount);
				default: return b.due.getTime(); // 'final'
			}
		};
		return rows.slice().sort((a, b) => {
			var va = val(a), vb = val(b);
			if (va < vb) return -1 * dir;
			if (va > vb) return 1 * dir;
			return 0;
		});
	}

	renderLedger() {
		var th = (side, key, label, right) => {
			var s = this.ledgerSort[side];
			var arrow = s.key === key ? (s.dir === 'desc' ? ' ▾' : ' ▴') : '';
			return `<th class="${right ? 'r ' : ''}sortable${s.key === key ? ' active' : ''}" data-sort="${key}" data-side="${side}">${label}${arrow}</th>`;
		};
		var panel = (side, title) => {
			var rows = this.blocks.filter(b => side === 'pay' ? (b.side === 'pay' && !b.facility) : b.side === 'rec');
			var out = rows.reduce((s, b) => s + Math.abs(b.amount), 0);
			var ord = rows.reduce((s, b) => s + (b.orderValue || Math.abs(b.amount)), 0);
			var sorted = this.sortLedgerRows(rows, side).slice(0, 80);
			var trs = sorted.map(b => {
				var od = Math.round((this.startOfDay(TODAY) - this.startOfDay(b.due)) / 86400000);
				return `<tr>
					<td><div class="lname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</div><div class="lgrp">${this.esc(b.ref)}</div></td>
					<td><span class="term">${this.esc(b.term)}</span></td>
					<td class="num"><div class="dbill">${this.dstr(b.billDate)}</div><div class="dfinal">${this.dstr(b.due)}</div>${b.overdue ? `<div class="odbadge" style="margin-top:2px">OD ${od}d</div>` : ''}</td>
					<td class="num r" style="color:var(--muted)">${this.fmtShort(b.orderValue || Math.abs(b.amount))}</td>
					<td class="num r" style="font-weight:700">${this.fmtShort(Math.abs(b.amount))}</td>
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
			me.opening = v * 1e5;
			// Units sanity: this field is LAKHS. Over 1,00,000 L (₹1,000 Cr) on an SMB
			// board almost always means the user typed rupees by mistake — warn, but
			// still apply (non-destructive; they may genuinely mean it).
			if (Math.abs(v) > 1e5) me.toast('Heads up: that’s ' + me.fmtShort(me.opening) + ' — this field is in lakhs (80 = ₹80L)');
			me.render();
		});
		$w.on('click', '#cfp-save', () => me.save());
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
		$w.on('click', '.ledger th.sortable', function() { var side = $(this).data('side'), key = $(this).data('sort'); var s = me.ledgerSort[side]; if (s.key === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc'; else { s.key = key; s.dir = 'asc'; } me.render(); });

		// Reservoir search + pills + folders
		$w.on('input', '.res-search', function() { me.search[$(this).data('side')] = $(this).val(); me.render(); });
		$w.on('click', '.pill', function() { var s = $(this).data('side'), k = $(this).data('filter'); me.filters[s][k] = !me.filters[s][k]; me.render(); });
		$w.on('click', '.folder-head', function() { var key = $(this).data('folder'); me.openFolders[key] = !$(this).hasClass('open'); me.render(); });

		// Ledger collapse
		$w.on('click', '#cfp-ledger-head', () => { me.ledgerOpen = !me.ledgerOpen; me.render(); });

		// Inline amount editing (partial payment) + merge-back. mousedown is stopped
		// so grabbing the amount/↩ on a draggable card doesn't kick off a drag.
		$w.on('mousedown', '.bamt.editable, .pamt.editable, .merge-back, .paid-toggle', function(e) { e.stopPropagation(); });
		$w.on('click', '.bamt.editable, .pamt.editable', function(e) { e.stopPropagation(); e.preventDefault(); me.beginInlineEdit($(this)); });
		$w.on('click', '.merge-back', function(e) { e.stopImmediatePropagation(); e.preventDefault(); me.mergeBack($(this).data('merge')); });
		// Mark paid / unpaid — planning-only sticker, never touches the real invoice.
		$w.on('click', '.paid-toggle', function(e) { e.stopImmediatePropagation(); e.preventDefault(); me.togglePaid($(this).data('paid')); });

		// Drag & drop (HTML5, delegated)
		$w.on('dragstart', '.block, .placed', function(e) {
			if (me._inlineEditing || $(e.target).is('input.amt-edit, .merge-back, .paid-toggle')) { e.preventDefault(); return false; }
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
				return Object.assign({}, b, { placedDate: d, origin: 'user' });
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
			if (me.startOfDay(b.due) < today) { n++; return Object.assign({}, b, { placedDate: today, origin: 'user' }); }
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
		else if (action === 'saveas') this.saveAs();
		else if (action === 'load') this.loadPlans();
		else if (action === 'overdue') this.placeOverdueOnToday();
		else if (action === 'merge') this.mergeAllFragments();
		else if (action === 'export') this.exportCsv();
		else if (action === 'reset') this.reset();
		else this.render();
	}

	schedulesMap() { var m = {}; this.placed.forEach(b => { if (!b.facility) m[b.id] = this.dateToKey(b.placedDate); }); return m; }

	save() {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_planner_data',
			args: { opening_balance: this.opening / 1e5, horizon: this.horizonWeeks + ' wks', scenario: 'Realistic',
				schedules: JSON.stringify(this.schedulesMap()), notes: JSON.stringify(this.notes || {}),
				custom_amounts: JSON.stringify({}), fragments: JSON.stringify(this.fragmentsMap()),
				paid: JSON.stringify(this.paidMap()) },
			callback: function() { me.planOpen = false; me.toast('Plan saved'); me.render(); }
		});
	}

	saveAs() {
		var me = this;
		frappe.prompt({ label: 'Plan name', fieldname: 'plan_name', fieldtype: 'Data', reqd: 1 }, function(v) {
			me.save();
			frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_named_plan',
				args: { plan_name: v.plan_name }, callback: function() { me.toast('Saved as “' + v.plan_name + '”'); } });
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
					if (cfg.opening_balance != null) me.opening = parseFloat(cfg.opening_balance) * 1e5;
					if (cfg.horizon) me.horizonWeeks = parseInt(cfg.horizon) || 6;
					var sched = cfg.schedules || {}, paid = cfg.paid || {};
					me.blocks = me.blocks.map(b => { var k = sched[b.id]; return Object.assign({}, b, { placedDate: k ? me.keyToDate(k) : null, origin: k ? 'auto' : null, paid: !!paid[b.id] }); });
					me.past = []; me.future = [];
					me.toast('Loaded “' + v.plan_name + '”'); me.render();
				}});
			}, 'Load plan', 'Load');
		}});
	}

	exportCsv() {
		var me = this;
		frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.export_planner_csv', args: { base_date: this.base_date }, callback: function(r) {
			var csv = r.message || ''; var blob = new Blob([csv], { type: 'text/csv' }); var url = URL.createObjectURL(blob);
			var a = document.createElement('a'); a.href = url; a.download = 'cash_flow_planner.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
			me.toast('Exported to CSV'); me.render();
		}});
	}

	reset() {
		var me = this;
		frappe.confirm('Reset the board to the saved seed placement?', function() {
			frappe.call({ method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.reset_planner_data', callback: function() {
				me.past = []; me.future = []; me.toast('Board reset'); me.load_data();
			}});
		});
	}
}
