frappe.provide('frappe.pages');

frappe.pages['cash-flow-ledger'] = frappe.pages['cash-flow-ledger'] || {};
frappe.pages['cash-flow-ledger'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Cash Flow Ledger',
		single_column: true
	});
	wrapper.cash_flow_ledger = new CashFlowLedger(wrapper, page);
}

class CashFlowLedger {
	constructor(wrapper, page) {
		this.wrapper = $(wrapper);
		this.page = page;
		
		var _n = new Date();
		this.base_date = _n.getFullYear() + '-' + String(_n.getMonth() + 1).padStart(2, '0') + '-' + String(_n.getDate()).padStart(2, '0');
		this.active_tab = 'payables'; // 'payables', 'receivables', 'side-by-side'
		
		// Multi-sort: ordered list = priority. `step` drives the header-click cycle
		// (1=asc, 2=desc, 3=asc, 4→removed). Shift/Ctrl/Cmd-click adds a level.
		this.payables_sort_keys = [{column: 'final_date', direction: 'asc', step: 1}];
		this.receivables_sort_keys = [{column: 'final_date', direction: 'asc', step: 1}];
		
		this.notes = {};
		
		this.init();
	}

	init() {
		this.page.main.html(frappe.render_template('cash_flow_ledger', {}));
		this.bind_elements();
		this.bind_events();
		this.load_data();
	}

	bind_elements() {
		this.$single_view = this.wrapper.find('#cf-ledger-single-view');
		this.$split_view = this.wrapper.find('#cf-ledger-split-view');
		this.$review_modal = this.wrapper.find('#cf-review-modal');
	}

	bind_events() {
		var me = this;
		
		// Tab switches
		this.wrapper.find('.cf-view-tab').on('click', function() {
			me.wrapper.find('.cf-view-tab').removeClass('active');
			$(this).addClass('active');
			me.active_tab = $(this).data('tab');
			me.render();
		});

		// Shift-click Table Sorting (Single View)
		this.wrapper.find('#ledger-table th').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			me.handle_sort_click('single', col, e.shiftKey || e.ctrlKey || e.metaKey);
		});

		// Sort direction toggle button — flips the primary (highest priority) sort,
		// keeping its cycle step in sync with the new direction.
		this.wrapper.find('#ledger-btn-sort-dir').on('click', function() {
			var keys = me.active_tab === 'payables' ? me.payables_sort_keys : me.receivables_sort_keys;
			if (keys.length > 0) {
				keys[0].direction = keys[0].direction === 'asc' ? 'desc' : 'asc';
				keys[0].step = keys[0].direction === 'desc' ? 2 : 1;
				me.render();
			}
		});

		// Filters
		this.wrapper.find('#ledger-chk-overdue').on('change', function() { me.render(); });
		this.wrapper.find('#ledger-search-input').on('input', function() { me.render(); });
		this.wrapper.find('#ledger-group-select').on('change', function() { me.render(); });
		this.wrapper.find('#ledger-sort-select').on('change', function() {
			var col = $(this).val();
			me.handle_sort_click('single', col, false);
		});

		// Review notes modal saving
		this.wrapper.find('#modal-btn-save-note').on('click', function() {
			var note = me.wrapper.find('#modal-input-notes').val();
			var inv_id = me.active_note_invoice_id;
			me.notes[inv_id] = note;
			me.$review_modal.removeClass('show');
			
			// Notes-only save — must NOT touch the planner's schedules/splits/opening.
			frappe.call({
				method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_review_note',
				args: { invoice_name: inv_id, note: note },
				callback: function() {
					frappe.show_alert({message: __('Note saved successfully'), indicator: 'green'});
					me.load_data();
				}
			});
		});

		this.wrapper.find('#modal-btn-close').on('click', function() {
			me.$review_modal.removeClass('show');
		});
	}

	load_data() {
		var me = this;
		me.show_loading();
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.get_planner_data',
			args: { base_date: me.base_date },
			callback: function(r) {
				if (r.message) {
					me.all_payables = r.message.payables || [];
					me.all_receivables = r.message.receivables || [];
					me.supplier_groups = r.message.supplier_groups || [];
					me.customer_groups = r.message.customer_groups || [];

					var config = r.message.config || {};
					me.notes = config.notes || {};

					me.hide_status();
					me.render();
				} else {
					me.show_error('The ledger loaded but returned no data.');
				}
			},
			error: function() {
				me.show_error('Couldn’t load the ledger. The server may be busy or an invoice is missing a total.');
			}
		});
	}

	/* ---- currency formatting ---- */
	// Compact, signed — for summary surfaces (banner, KPI decks) where a wall of
	// digits hurts. ₹34.16L / ₹1.45Cr. Mirrors the planner's fmtShort.
	fmt_compact(n) {
		var v = Number(n) || 0, a = Math.abs(v), s;
		if (a >= 1e7) s = (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + 'Cr';
		else if (a >= 1e5) s = (a / 1e5).toFixed(2).replace(/\.?0+$/, '') + 'L';
		else s = Math.round(a).toLocaleString('en-IN');
		return (v < 0 ? '−' : '') + '₹' + s;
	}
	// Exact grouped rupees — for per-invoice table cells (a ledger is the detail
	// surface). Rounds to paise first so float dust like 341000.49999 can't leak.
	fmt_rupee(n) {
		var v = Math.round((Number(n) || 0) * 100) / 100;
		return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
	}

	/* ---- loading / error overlay ---- */
	get $status() {
		var $el = this.wrapper.find('.cf-status-overlay');
		if (!$el.length) {
			$el = $('<div class="cf-status-overlay"></div>');
			this.wrapper.find('.cash-flow-ledger-wrapper').append($el);
		}
		return $el;
	}
	show_loading() {
		this.$status.removeClass('error').addClass('show')
			.html('<div class="cf-spinner"></div><div class="cf-status-msg">Loading ledger…</div>');
	}
	show_error(msg) {
		var me = this;
		this.$status.addClass('show error').html(
			'<div class="cf-status-icon">⚠</div>' +
			'<div class="cf-status-msg">' + frappe.utils.escape_html(msg || 'Something went wrong.') + '</div>' +
			'<button class="cf-btn cf-btn-primary cf-status-retry">Retry</button>'
		);
		this.$status.find('.cf-status-retry').on('click', function() { me.load_data(); });
	}
	hide_status() { this.$status.removeClass('show error').empty(); }

	render() {
		this.render_net_banner();
		
		if (this.active_tab === 'side-by-side') {
			this.$single_view.addClass('cf-hidden');
			this.$split_view.removeClass('cf-hidden');
			this.render_split();
		} else {
			this.$split_view.addClass('cf-hidden');
			this.$single_view.removeClass('cf-hidden');
			this.render_single();
		}
	}

	render_net_banner() {
		var total_pay = this.all_payables.reduce((a, b) => a + b.outstanding, 0);
		var total_rec = this.all_receivables.reduce((a, b) => a + b.outstanding, 0);
		var net_diff = total_rec - total_pay;

		// Timing context — totals alone hide whether the cover actually lines up in
		// time. Surface what's ALREADY overdue on each side so a "surplus" that's
		// really 90-day receivables vs payables-due-now doesn't read as healthy.
		var od_pay = this.all_payables.filter(b => b.age_days > 0).reduce((a, b) => a + b.outstanding, 0);
		var od_rec = this.all_receivables.filter(b => b.age_days > 0).reduce((a, b) => a + b.outstanding, 0);

		this.wrapper.find('#lbl-payables-total').text(this.fmt_compact(total_pay));
		this.wrapper.find('#lbl-receivables-total').text(this.fmt_compact(total_rec));

		var net_badge = this.wrapper.find('#lbl-net-difference');
		var net_sign = net_diff >= 0 ? '+' : '−';
		net_badge.text(`${net_sign}${this.fmt_compact(Math.abs(net_diff))}`);

		// Neutral, hedged language — this is a totals view, not a dated forecast.
		var verdict;
		if (net_diff >= 0) {
			net_badge.css({ 'background': '#d1fae5', 'color': '#065f46' });
			verdict = `Receivables exceed payables by ${this.fmt_compact(Math.abs(net_diff))} overall`;
		} else {
			net_badge.css({ 'background': '#fee2e2', 'color': '#b91c1c' });
			verdict = `Payables exceed receivables by ${this.fmt_compact(Math.abs(net_diff))} overall`;
		}
		var timing = (od_pay > 0 || od_rec > 0)
			? ` · already overdue: ${this.fmt_compact(od_pay)} to pay vs ${this.fmt_compact(od_rec)} to collect`
			: ' · nothing overdue yet';
		this.wrapper.find('#lbl-net-verdict').text(verdict + timing + '. Totals only — timing of due dates not modelled.');
	}

	render_single() {
		var me = this;
		var is_pay = this.active_tab === 'payables';
		var data = is_pay ? this.all_payables : this.all_receivables;
		
		// Update table column header labels
		var $tbl = this.wrapper.find('#ledger-table');
		$tbl.find('th[data-col="party"]').text(is_pay ? 'SUPPLIER' : 'CUSTOMER');
		$tbl.find('th[data-col="value"]').text(is_pay ? 'ORDER VALUE' : 'INVOICE VALUE');

		// Populate Group select filters dynamically
		var groups = is_pay ? (this.supplier_groups || []) : (this.customer_groups || []);
		var $group_sel = this.wrapper.find('#ledger-group-select');
		var current_val = $group_sel.val();
		$group_sel.empty().append('<option value="">All groups</option>');
		groups.forEach(g => { $group_sel.append(`<option value="${g}">${g}</option>`); });
		if (groups.includes(current_val)) { $group_sel.val(current_val); }

		// Filter and sort
		var filtered = this.filter_data(data);
		var sorted = this.sort_data(filtered, is_pay);
		
		this.wrapper.find('#lbl-records-count').text(`${sorted.length} of ${data.length}`);
		this.render_sort_badges(is_pay);
		this.render_kpi_deck(sorted, is_pay);
		
		var $tbody = this.wrapper.find('#ledger-table-body').empty();
		if (sorted.length === 0) {
			$tbody.append(`<tr><td colspan="10" style="text-align: center; color: #94a3b8; padding: 30px;">No invoices match the filters.</td></tr>`);
			return;
		}

		sorted.forEach(row => {
			var age_badge = row.age_days > 0 
				? `<span class="cf-pill overdue">Overdue ${row.age_days}d</span>`
				: `<span class="cf-pill due-future">Due in ${Math.abs(row.age_days)}d</span>`;
				
			var note_str = row.review_notes 
				? `<div style="font-size: 11px; color: #475569; margin-top: 4px; font-weight: 500;">Note: ${row.review_notes}</div>`
				: '';
				
			var tr = $(`
				<tr>
					<td><strong>${row.party}</strong></td>
					<td><span style="font-family: monospace; font-size: 12px; color: #64748b;">${row.name}</span></td>
					<td>${row.ref_no}</td>
					<td>${row.bill_date}</td>
					<td><span class="cf-pill term-pill">${row.credit_term}</span></td>
					<td style="font-weight: 600; color: #1e3a8a;">${row.final_date}</td>
					<td>${me.fmt_rupee(row.value)}</td>
					<td style="font-weight: 700;">${me.fmt_rupee(row.outstanding)}</td>
					<td>${age_badge}</td>
					<td>
						<div class="cf-flex cf-gap-10 cf-flex-align">
							<button class="cf-btn btn-review-note" data-inv="${row.name}" style="padding: 3px 8px; font-size: 11px;">Review</button>
							<span style="font-size: 14px; cursor: pointer; color: #64748b;" class="btn-edit-note-icon" data-inv="${row.name}">✏️</span>
						</div>
						${note_str}
					</td>
				</tr>
			`);
			$tbody.append(tr);
		});

		$tbody.find('.btn-review-note, .btn-edit-note-icon').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});
	}

	render_kpi_deck(sorted, is_pay) {
		var original = is_pay ? this.all_payables : this.all_receivables;
		var title1 = is_pay ? 'Invoices' : 'Invoices';
		var sub1 = is_pay ? `${this.get_unique_parties(original)} suppliers` : `${this.get_unique_parties(original)} customers`;
		
		var total_val = sorted.reduce((a, b) => a + b.value, 0);
		var outstanding_val = sorted.reduce((a, b) => a + b.outstanding, 0);
		var overdue_cnt = sorted.filter(d => d.age_days > 0).length;
		
		this.wrapper.find('#kpi-1-label').text(title1);
		this.wrapper.find('#kpi-1-val').text(sorted.length);
		this.wrapper.find('#kpi-1-sub').text(sub1);
		
		this.wrapper.find('#kpi-2-label').text(is_pay ? 'Order Value' : 'Invoice Value');
		this.wrapper.find('#kpi-2-val').text(this.fmt_compact(total_val));
		this.wrapper.find('#kpi-2-sub').text(is_pay ? 'submitted PIs' : 'submitted SIs');

		this.wrapper.find('#kpi-3-label').text('Outstanding');
		this.wrapper.find('#kpi-3-val').text(this.fmt_compact(outstanding_val));
		this.wrapper.find('#kpi-3-sub').text(is_pay ? 'still payable' : 'still receivable');
		
		this.wrapper.find('#kpi-4-label').text('Overdue');
		this.wrapper.find('#kpi-4-val').text(overdue_cnt);
	}

	get_unique_parties(list) {
		var s = new Set();
		list.forEach(i => s.add(i.party));
		return s.size;
	}

	filter_data(data) {
		var search = this.wrapper.find('#ledger-search-input').val().toLowerCase();
		var group = this.wrapper.find('#ledger-group-select').val();
		var overdue_only = this.wrapper.find('#ledger-chk-overdue').is(':checked');
		
		return data.filter(item => {
			if (search) {
				var m = item.party.toLowerCase().includes(search) || 
				        item.name.toLowerCase().includes(search) || 
				        item.ref_no.toLowerCase().includes(search);
				if (!m) return false;
			}
			if (group && item.party_group !== group) return false;
			if (overdue_only && item.age_days <= 0) return false;
			return true;
		});
	}

	sort_data(data, is_pay) {
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		if (keys.length === 0) return data;
		
		var sorted = [...data];
		sorted.sort((a, b) => {
			for (var sortObj of keys) {
				var col = sortObj.column;
				var dir = sortObj.direction === 'asc' ? 1 : -1;
				
				var valA = a[col];
				var valB = b[col];
				
				if (col === 'final_date' || col === 'bill_date') {
					var dateA = new Date(valA.split('-').reverse().join('-'));
					var dateB = new Date(valB.split('-').reverse().join('-'));
					if (dateA < dateB) return -1 * dir;
					if (dateA > dateB) return 1 * dir;
				} else if (typeof valA === 'string') {
					var comp = valA.localeCompare(valB);
					if (comp !== 0) return comp * dir;
				} else {
					if (valA < valB) return -1 * dir;
					if (valA > valB) return 1 * dir;
				}
			}
			return 0;
		});
		return sorted;
	}

	// Header-click cycle: off → asc(1) → desc(2) → asc(3) → off(4).
	// `additive` (shift / ctrl / cmd click) keeps the other sorted columns and
	// appends/cycles this one — array order is the sort priority. A plain click
	// collapses to a single sort on this column (then cycles it).
	handle_sort_click(view_type, col, additive) {
		var is_pay = this.active_tab === 'payables';
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		var idx = keys.findIndex(k => k.column === col);

		if (idx >= 0) {
			// Already a sort level — cycle THIS column in place, keeping all other
			// levels (plain or modifier click). Toggling one column must never drop
			// the others. The 4th step removes just this column.
			this._advance_sort_step(keys, idx);
		} else if (additive) {
			keys.push({ column: col, direction: 'asc', step: 1 });   // add a new level
		} else {
			keys.splice(0, keys.length, { column: col, direction: 'asc', step: 1 }); // fresh single sort
		}

		if (view_type === 'split') {
			this.render_split();
		} else {
			this.render_single();
		}
	}

	_advance_sort_step(keys, idx) {
		var k = keys[idx];
		k.step = (k.step || 1) + 1;
		if (k.step >= 4) { keys.splice(idx, 1); return; }   // 4th click clears this column
		k.direction = (k.step === 2) ? 'desc' : 'asc';      // steps 1,3 → asc · step 2 → desc
	}

	render_sort_badges(is_pay) {
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		var $hdr = this.wrapper.find('#ledger-table th');
		
		$hdr.removeClass('active-sort').find('.sort-priority').remove();
		
		keys.forEach((k, idx) => {
			var $th = $hdr.filter(`[data-col="${k.column}"]`);
			if ($th.length) {
				$th.addClass('active-sort');
				var label = k.direction === 'asc' ? '↑' : '↓';
				$th.append(`<span class="sort-priority">${idx + 1} ${label}</span>`);
			}
		});

		var $tag_container = this.wrapper.find('#ledger-sorted-by-tags');
		$tag_container.empty().append('SORTED BY: ');
		if (keys.length === 0) {
			$tag_container.append('<span style="font-weight: 500; color: #94a3b8;">None</span>');
			return;
		}
		
		keys.forEach((k, idx) => {
			var friendly_col = k.column.replace('_', ' ');
			var tag = $(`
				<span class="cf-sort-badge">
					(${idx + 1}) ${friendly_col} [${k.direction}]
					<span class="close-sort" data-col="${k.column}">×</span>
				</span>
			`);
			var me = this;
			tag.find('.close-sort').on('click', function() {
				var col = $(this).data('col');
				var index = keys.findIndex(x => x.column === col);
				if (index >= 0) {
					keys.splice(index, 1);
					me.render_single();
				}
			});
			$tag_container.append(tag);
		});
	}

	render_split() {
		var me = this;
		
		var pay_groups = Array.from(new Set(this.all_payables.map(i => i.party_group)));
		var rec_groups = Array.from(new Set(this.all_receivables.map(i => i.party_group)));
		
		var $pg = this.wrapper.find('#split-pay-group');
		var pg_val = $pg.val();
		$pg.empty().append('<option value="">All groups</option>');
		pay_groups.forEach(g => $pg.append(`<option value="${g}">${g}</option>`));
		if (pay_groups.includes(pg_val)) $pg.val(pg_val);
		
		var $rg = this.wrapper.find('#split-rec-group');
		var rg_val = $rg.val();
		$rg.empty().append('<option value="">All groups</option>');
		rec_groups.forEach(g => $rg.append(`<option value="${g}">${g}</option>`));
		if (rec_groups.includes(rg_val)) $rg.val(rg_val);

		var pay_total = this.all_payables.reduce((a, b) => a + b.outstanding, 0);
		var rec_total = this.all_receivables.reduce((a, b) => a + b.outstanding, 0);

		this.wrapper.find('#split-pay-kpi-invoices').text(this.all_payables.length);
		this.wrapper.find('#split-pay-kpi-value').text(this.fmt_compact(pay_total));
		this.wrapper.find('#split-pay-kpi-outstanding').text(this.fmt_compact(pay_total));
		this.wrapper.find('#split-pay-kpi-overdue').text(this.all_payables.filter(i => i.age_days > 0).length);

		this.wrapper.find('#split-rec-kpi-invoices').text(this.all_receivables.length);
		this.wrapper.find('#split-rec-kpi-value').text(this.fmt_compact(rec_total));
		this.wrapper.find('#split-rec-kpi-outstanding').text(this.fmt_compact(rec_total));
		this.wrapper.find('#split-rec-kpi-overdue').text(this.all_receivables.filter(i => i.age_days > 0).length);

		// Payables
		var pay_search = this.wrapper.find('#split-pay-search').val() || '';
		var pay_grp = this.wrapper.find('#split-pay-group').val() || '';
		var f_pay = this.all_payables.filter(item => {
			if (pay_search && !item.party.toLowerCase().includes(pay_search.toLowerCase()) && !item.name.toLowerCase().includes(pay_search.toLowerCase())) return false;
			if (pay_grp && item.party_group !== pay_grp) return false;
			return true;
		});
		var s_pay = this.sort_data(f_pay, true);
		var $pay_body = this.wrapper.find('#split-pay-table-body').empty();
		s_pay.forEach(row => {
			var age_badge = row.age_days > 0 
				? `<span class="cf-pill overdue">Overdue ${row.age_days}d</span>`
				: `<span class="cf-pill due-future">Due in ${Math.abs(row.age_days)}d</span>`;
			var tr = $(`
				<tr>
					<td><strong>${row.party}</strong></td>
					<td><span style="font-family: monospace; font-size: 11px;">${row.name}</span></td>
					<td>${row.final_date}</td>
					<td>${me.fmt_rupee(row.outstanding)}</td>
					<td>${age_badge}</td>
					<td><button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button></td>
				</tr>
			`);
			$pay_body.append(tr);
		});

		// Receivables
		var rec_search = this.wrapper.find('#split-rec-search').val() || '';
		var rec_grp = this.wrapper.find('#split-rec-group').val() || '';
		var f_rec = this.all_receivables.filter(item => {
			if (rec_search && !item.party.toLowerCase().includes(rec_search.toLowerCase()) && !item.name.toLowerCase().includes(rec_search.toLowerCase())) return false;
			if (rec_grp && item.party_group !== rec_grp) return false;
			return true;
		});
		var s_rec = this.sort_data(f_rec, false);
		var $rec_body = this.wrapper.find('#split-rec-table-body').empty();
		s_rec.forEach(row => {
			var age_badge = row.age_days > 0 
				? `<span class="cf-pill overdue">Overdue ${row.age_days}d</span>`
				: `<span class="cf-pill due-future">Due in ${Math.abs(row.age_days)}d</span>`;
			var tr = $(`
				<tr>
					<td><strong>${row.party}</strong></td>
					<td><span style="font-family: monospace; font-size: 11px;">${row.name}</span></td>
					<td>${row.final_date}</td>
					<td>${me.fmt_rupee(row.outstanding)}</td>
					<td>${age_badge}</td>
					<td><button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button></td>
				</tr>
			`);
			$rec_body.append(tr);
		});

		// Bindings
		this.wrapper.find('.btn-split-review').off('click').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});

		this.wrapper.find('#split-pay-search, #split-rec-search').off('input').on('input', function() { me.render_split(); });
		this.wrapper.find('#split-pay-group, #split-rec-group').off('change').on('change', function() { me.render_split(); });
		
		this.wrapper.find('#split-pay-table th, #split-rec-table th').off('click').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			var pane_is_pay = $(this).closest('table').attr('id') === 'split-pay-table';
			me.active_tab = pane_is_pay ? 'payables' : 'receivables';
			me.handle_sort_click('split', col, e.shiftKey || e.ctrlKey || e.metaKey);
			me.active_tab = 'side-by-side'; // restore
		});

		// Sort-state arrows + priority numbers on the split-pane headers.
		this.render_split_sort_indicators('#split-pay-table', this.payables_sort_keys);
		this.render_split_sort_indicators('#split-rec-table', this.receivables_sort_keys);
	}

	render_split_sort_indicators(table_sel, keys) {
		var $ths = this.wrapper.find(table_sel + ' th');
		$ths.removeClass('active-sort').find('.sort-priority').remove();
		keys.forEach(function(k, idx) {
			var $th = $ths.filter(`[data-col="${k.column}"]`);
			if (!$th.length) return;
			$th.addClass('active-sort');
			var arrow = k.direction === 'asc' ? '↑' : '↓';
			var prefix = keys.length > 1 ? (idx + 1) + ' ' : '';
			$th.append(`<span class="sort-priority">${prefix}${arrow}</span>`);
		});
	}

	open_review_modal(inv_id) {
		this.active_note_invoice_id = inv_id;
		var inv = this.all_payables.concat(this.all_receivables).find(i => i.name === inv_id);
		if (inv) {
			this.wrapper.find('#modal-lbl-invoice-id').text(inv.name);
			this.wrapper.find('#modal-lbl-party-name').text(inv.party);
			this.wrapper.find('#modal-lbl-outstanding').text(this.fmt_rupee(inv.outstanding));
			this.wrapper.find('#modal-input-notes').val(this.notes[inv_id] || '');
			this.$review_modal.addClass('show');
		}
	}
}
