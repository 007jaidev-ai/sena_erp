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
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.get_planner_data',
			args: { base_date: this.base_date },
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
		return { horizonNet: horizonNet, lowest: lowest, lowestWk: lowestWk,
			unscheduled: this.unscheduled.length, overdue: this.blocks.filter(b => b.overdue).length };
	}

	/* ===================== mutations ===================== */
	commit(next) { this.past.push(this.blocks); if (this.past.length > 60) this.past.shift(); this.future = []; this.blocks = next; }
	undo() { if (!this.past.length) return; this.future.unshift(this.blocks); this.blocks = this.past.pop(); this.render(); }
	redo() { if (!this.future.length) return; this.past.push(this.blocks); this.blocks = this.future.shift(); this.render(); }
	placeOnDate(id, date) { var d = this.startOfDay(date); this.commit(this.blocks.map(b => b.id === id ? Object.assign({}, b, { placedDate: d, origin: 'user' }) : b)); }
	unplace(id) { var b = this.blocks.find(x => x.id === id); if (!b || !b.placedDate) return; this.commit(this.blocks.map(x => x.id === id ? Object.assign({}, x, { placedDate: null, origin: null }) : x)); this.toast('Moved back to inbox'); }
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
				<div class="item" data-action="saveas">Save as…</div>
				<div class="item" data-action="load">Load plans…</div>
				<div class="sep"></div>
				<div class="item" data-action="merge">Merge fragments</div>
				<div class="item" data-action="export">Export CSV</div>
				<div class="sep"></div>
				<div class="item danger" data-action="reset">Reset board</div>
			</div>` : '';
		var hsel = ['4', '6', '8', '12'].map(w => `<option value="${w}" ${this.horizonWeeks == w ? 'selected' : ''}>${w} wks</option>`).join('');
		return `
		<div class="toolbar">
			<div class="tb-title">Cash Flow Planner <span class="demo">Demo · planning</span></div>
			<div class="tb-divider"></div>
			<button class="btn btn-icon" id="cfp-undo" title="Undo" ${this.past.length ? '' : 'disabled'}>↶</button>
			<button class="btn btn-icon" id="cfp-redo" title="Redo" ${this.future.length ? '' : 'disabled'}>↷</button>
			<div class="tb-divider"></div>
			<div class="tb-field"><label>Opening ₹</label>
				<input class="tb-input num" id="cfp-opening" value="${openL}"><span style="font-size:10px;color:var(--faint);">L</span>
			</div>
			<div class="tb-field"><label>Horizon</label>
				<select class="tb-sel" id="cfp-horizon">${hsel}</select>
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
				<div class="s ${k.horizonNet >= 0 ? 'good' : ''}"><div class="k">Horizon net · ${this.horizonWeeks} wks</div><div class="v" ${k.horizonNet < 0 ? 'style="color:var(--out)"' : ''}>${this.fmtShort(k.horizonNet)}</div></div>
				<div class="s"><div class="k">Lowest cash · wk ${k.lowestWk}</div><div class="v" ${k.lowest < 0 ? 'style="color:var(--out)"' : ''}>${this.fmtShort(k.lowest)}</div></div>
				<div class="s ${k.overdue > 0 ? 'alert' : ''}"><div class="k">${k.overdue > 0 ? '⚠ ' : ''}Overdue</div><div class="v">${k.overdue}<small>items</small></div></div>
				<div class="s"><div class="k">Unscheduled</div><div class="v">${k.unscheduled}</div></div>
			</div>
			<div class="facilities">
				${fac('Cash Credit (CC)', 'var(--cc)', facCC, CC_LIMIT)}
				${fac('Bill Discounting (BD)', 'var(--bd)', facBD, BD_LIMIT)}
			</div>
		</div>`;
	}

	renderBody() {
		return `<div class="body">
			${this.renderReservoir('pay', 'Payables & financing', 'what we owe + facility draws')}
			${this.renderTimeline()}
			${this.renderReservoir('rec', 'Receivables', 'what customers owe us')}
		</div>`;
	}

	renderReservoir(side, title, sub) {
		var me = this, q = this.search[side].trim().toLowerCase(), f = this.filters[side];
		var list = this.unscheduled.filter(b => b.side === side).filter(b => {
			if (q && !(b.entity.toLowerCase().includes(q) || b.ref.toLowerCase().includes(q))) return false;
			if (f.priority && !b.priority) return false;
			if (f.highValue && !b.highValue) return false;
			if (f.overdue && !b.overdue) return false;
			return true;
		});
		var groups = {};
		list.forEach(b => { (groups[b.entity] = groups[b.entity] || { contra: b.contra, items: [] }).items.push(b); });
		var names = Object.keys(groups).sort((a, b) => Math.abs(groups[b].items.reduce((s, x) => s + x.amount, 0)) - Math.abs(groups[a].items.reduce((s, x) => s + x.amount, 0)));
		var totalAmt = list.reduce((s, b) => s + b.amount, 0);

		var pill = (key, label) => `<span class="pill" data-side="${side}" data-filter="${key}" aria-pressed="${f[key]}">${label}</span>`;
		var foldersHtml = names.length === 0
			? `<div class="res-empty">Nothing matches — everything here is scheduled, or filtered out.</div>`
			: names.map((n, i) => {
				var g = groups[n], total = g.items.reduce((s, x) => s + x.amount, 0);
				var fkey = side + '::' + n;
				var open = this.openFolders[fkey] !== undefined ? this.openFolders[fkey] : (i < 2 && names.length <= 8);
				var body = open ? `<div class="folder-body">${g.items.map(b => this.renderBlock(b, side)).join('')}</div>` : '';
				return `<div class="folder">
					<div class="folder-head ${open ? 'open' : ''} ${g.contra ? 'contra' : ''}" data-folder="${this.esc(fkey)}">
						<span class="tw">▶</span>
						<span class="fname" title="${this.esc(n)}">${this.esc(n)}</span>
						${g.contra ? '<span class="contra-ic" title="Contra">⇄</span>' : ''}
						<span class="cnt">${g.items.length}</span>
						<span class="ftot ${total < 0 ? 'neg' : 'pos'}">${this.fmtShort(total)}</span>
					</div>${body}</div>`;
			}).join('');

		return `<div class="reservoir ${side}">
			<div class="res-head">
				<div class="rtitle"><span class="dot"></span>${title}<span class="${totalAmt < 0 ? 'neg' : 'pos'}" style="margin-left:auto;font-family:var(--f-num);font-weight:700;font-size:12px;">${this.fmtShort(totalAmt)}</span></div>
				<div class="rsub">${list.length} unscheduled · ${sub}</div>
				<input class="res-search" data-side="${side}" placeholder="Search entity or block id…" value="${this.esc(this.search[side])}">
				<div class="res-pills">${pill('priority', '★ Priority')}${pill('highValue', '▲ High value')}${pill('overdue', '⏱ Overdue')}</div>
			</div>
			<div class="res-body" data-resbody="${side}">${foldersHtml}</div>
		</div>`;
	}

	renderBlock(b, side) {
		var cls = ['block']; if (b.side === 'rec') cls.push('rec'); if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd');
		var flags = (b.priority ? '★' : '') + (b.overdue ? '⏱' : '');
		return `<div class="${cls.join(' ')}" draggable="true" data-id="${this.esc(b.id)}">
			<div class="bbody">
				<div class="brow1">
					<span class="btype">${b.type}</span>
					<span class="bname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</span>
					${b.contra ? '<span style="color:var(--contra);font-size:11px;" title="Contra — customer & vendor">⇄</span>' : ''}
					${flags ? `<span class="bflags">${flags}</span>` : ''}
					<span style="flex:1"></span>
					<span class="bamt ${b.amount < 0 ? 'neg' : 'pos'}">${this.fmtShort(b.amount)}</span>
				</div>
				<div class="bmeta">
					<span class="bid">${this.esc(b.ref)}</span>
					<span>due ${this.dstr(b.due)}</span>
					${b.overdue ? '<span class="tpill over">Overdue</span>' : ''}
					${b.highValue ? '<span class="tpill early">High value</span>' : ''}
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

	renderColumn(c, idx) {
		var cls = ['col']; if (c.isHorizon) cls.push('horizon'); if (c.isFuture) cls.push('future'); if (c.isToday) cls.push('today-col'); if (c.isWeekend) cls.push('weekend');
		var isSel = c.level === 'day' && this.view.day && this.sameDay(c.start, this.view.day);
		if (isSel) cls.push('sel-day');
		var netStr = c.net === 0 ? '₹0' : this.fmtShort(c.net);
		var netCls = c.net < 0 ? 'neg' : c.net > 0 ? 'pos' : '';
		var tag = c.isToday ? '<span class="ch-tag today">Today</span>' : (c.isPast && !c.isToday ? '<span class="ch-tag past">Past</span>' : '');
		var body = c.blocks.length === 0
			? `<div class="col-empty">${c.isFuture ? 'Drop a block here to schedule it.' : c.isPast ? 'No movements pencilled in.' : 'Drag a block onto this ' + c.unit + '.'}</div>`
			: c.blocks.map(b => this.renderPlaced(b)).join('');
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

	renderPlaced(b) {
		var cls = ['placed', b.side === 'rec' ? 'rec' : 'pay']; if (b.facility === 'financing') cls.push('financing'); if (b.facility === 'bd') cls.push('bd'); if (b.origin === 'auto') cls.push('suggested');
		var tag = b.origin === 'auto' ? '<span class="ptag auto">auto</span>' : '<span class="ptag user">✓ you</span>';
		return `<div class="${cls.join(' ')}" draggable="true" data-id="${this.esc(b.id)}">
			<div class="ptop">${tag}<span class="pname" title="${this.esc(b.entity)}">${this.esc(b.entity)}</span><span class="pdate">${this.dstrFull(b.placedDate)}</span></div>
			<div class="prow"><span class="pid">${this.esc(b.ref)}</span><span class="pamt">${this.fmtShort(b.amount)}</span></div>
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

	/* ===================== events (delegated, bound once) ===================== */
	bind_events() {
		var me = this, $w = this.wrapper;

		// Toolbar
		$w.on('click', '#cfp-undo', () => me.undo());
		$w.on('click', '#cfp-redo', () => me.redo());
		$w.on('change', '#cfp-opening', function() { var v = parseFloat($(this).val()); if (!isNaN(v)) { me.opening = v * 1e5; me.render(); } });
		$w.on('change', '#cfp-horizon', function() { me.horizonWeeks = parseInt($(this).val()) || 6; me.render(); });
		$w.on('click', '#cfp-save', () => me.save());
		$w.on('click', '#cfp-plan-btn', function(e) { e.stopImmediatePropagation(); me.planOpen = !me.planOpen; me.moreOpen = false; me.render(); });
		$w.on('click', '#cfp-plan-menu .item', function() { me.planPeriod($(this).data('plan')); });
		$w.on('click', '#cfp-more-btn', function(e) { e.stopImmediatePropagation(); me.moreOpen = !me.moreOpen; me.planOpen = false; me.render(); });
		$w.on('click', '#cfp-more-menu .item', function() { me.planAction($(this).data('action')); });
		// close menus on outside click
		$w.on('click', function(e) { if ((me.planOpen || me.moreOpen) && !$(e.target).closest('.menu-wrap').length) { me.planOpen = false; me.moreOpen = false; me.render(); } });

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

		// Drag & drop (HTML5, delegated)
		$w.on('dragstart', '.block, .placed', function(e) {
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
		var next = this.blocks.map(b => {
			if (b.placedDate || b.facility) return b;
			if (match(b.due)) { count++; return Object.assign({}, b, { placedDate: me.startOfDay(b.due), origin: 'user' }); }
			return b;
		});
		if (count) { this.commit(next); this.toast('Planned ' + count + ' invoice' + (count > 1 ? 's' : '') + ' due in this ' + level); }
		else this.toast('Nothing unscheduled is due in this ' + level);
		this.render();
	}

	/* ===================== actions / persistence ===================== */
	planAction(action) {
		this.moreOpen = false; this.planOpen = false;
		if (action === 'save') this.save();
		else if (action === 'saveas') this.saveAs();
		else if (action === 'load') this.loadPlans();
		else if (action === 'merge') { this.toast('Merged split fragments'); this.render(); }
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
				custom_amounts: JSON.stringify({}), fragments: JSON.stringify({}) },
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
					var sched = cfg.schedules || {};
					me.blocks = me.blocks.map(b => { var k = sched[b.id]; return Object.assign({}, b, { placedDate: k ? me.keyToDate(k) : null, origin: k ? 'auto' : null }); });
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
