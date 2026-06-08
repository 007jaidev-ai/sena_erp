frappe.provide('frappe.pages');

frappe.pages['cash-flow-planner'] = frappe.pages['cash-flow-planner'] || {};
frappe.pages['cash-flow-planner'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Cash Flow Planner',
		single_column: true
	});
	wrapper.cash_flow_planner = new CashFlowPlanner(wrapper, page);
}

frappe.pages['cash_flow_planner'] = frappe.pages['cash-flow-planner'];

class CashFlowPlanner {
	constructor(wrapper, page) {
		this.wrapper = $(wrapper);
		this.page = page;
		
		this.base_date = '2026-06-03'; // Center demo date
		this.active_view = 'ledger'; // 'ledger' or 'planner'
		this.active_tab = 'payables'; // 'payables', 'receivables', 'side-by-side'
		
		// Sort keys arrays for multi-sorting: [{column: '...', direction: 'asc'|'desc'}]
		this.payables_sort_keys = [{column: 'final_date', direction: 'asc'}];
		this.receivables_sort_keys = [{column: 'final_date', direction: 'asc'}];
		
		// Planner timeline level: 'month', 'week', 'day'
		this.planner_level = 'month';
		this.current_year = 2026;
		this.current_month = 5; // June (0-indexed)
		this.current_week = 0; // Week 1 (0-indexed)
		
		// Slider limits
		this.cc_limit = 60000000; // ₹6.00Cr
		this.bd_limit = 40000000; // ₹4.00Cr
		
		this.opening_balance = 80.00; // In Lakhs
		this.horizon = '6 wks';
		this.scenario = 'Realistic';
		this.schedules = {}; // { invoice_id: 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY-Wxx' }
		this.notes = {}; // { invoice_id: 'note text' }
		this.cc_utilization = 0;
		this.bd_utilization = 0;
		
		// Flags for sidebar filters
		this.payables_sidebar_filter = { search: '', priority: false, high_value: false, overdue: false };
		this.receivables_sidebar_filter = { search: '', priority: false, high_value: false, overdue: false };
		
		this.init();
	}

	init() {
		// Render the template 'cash_flow_planner' (matching registered HTML template name)
		this.page.main.html(frappe.render_template('cash_flow_planner', {}));
		this.bind_elements();
		this.bind_events();
		this.load_data();
	}

	bind_elements() {
		// Containers
		this.$ledger_container = this.wrapper.find('#cf-ledger-container');
		this.$planner_container = this.wrapper.find('#cf-planner-container');
		this.$single_view = this.wrapper.find('#cf-ledger-single-view');
		this.$split_view = this.wrapper.find('#cf-ledger-split-view');
		
		// Buttons / Inputs
		this.$btn_view_toggle = this.wrapper.find('#cf-btn-view-toggle');
		this.$input_opening = this.wrapper.find('#cf-opening-cash');
		this.$select_horizon = this.wrapper.find('#cf-horizon');
		
		this.$btn_save = this.wrapper.find('#cf-btn-save');
		this.$btn_merge = this.wrapper.find('#cf-btn-merge');
		this.$btn_plans = this.wrapper.find('#cf-btn-plans');
		this.$btn_export = this.wrapper.find('#cf-btn-export');
		this.$btn_reset = this.wrapper.find('#cf-btn-reset');
		
		// Gauges & Headers
		this.$cc_gauge_text = this.wrapper.find('#cc-gauge-text');
		this.$cc_gauge_fill = this.wrapper.find('#cc-gauge-fill');
		this.$cc_gauge_subtext = this.wrapper.find('#cc-gauge-subtext');
		this.$bd_gauge_text = this.wrapper.find('#bd-gauge-text');
		this.$bd_gauge_fill = this.wrapper.find('#bd-gauge-fill');
		this.$bd_gauge_subtext = this.wrapper.find('#bd-gauge-subtext');
		
		this.$hdr_horizon_net = this.wrapper.find('#hdr-horizon-net');
		this.$hdr_lowest_cash = this.wrapper.find('#hdr-lowest-cash');
		this.$hdr_unscheduled_count = this.wrapper.find('#hdr-unscheduled-count');
		
		// Modals
		this.$review_modal = this.wrapper.find('#cf-review-modal');
	}

	bind_events() {
		var me = this;
		
		// Main View Toggle (Ledger vs Planner)
		this.$btn_view_toggle.on('click', function() {
			if (me.active_view === 'ledger') {
				me.set_view('planner');
			} else {
				me.set_view('ledger');
			}
		});

		// Opening cash & Horizon changes
		this.$input_opening.on('change', function() {
			me.opening_balance = parseFloat($(this).val()) || 0;
			me.recalculate_cash_flow();
			if (me.active_view === 'planner') {
				me.render_planner();
			}
		});
		this.$select_horizon.on('change', function() {
			me.horizon = $(this).val();
			me.recalculate_cash_flow();
			if (me.active_view === 'planner') {
				me.render_planner();
			}
		});

		// Save State Action
		this.$btn_save.on('click', function() {
			me.save_state();
		});
		
		// Reset State Action
		this.$btn_reset.on('click', function() {
			frappe.confirm('Are you sure you want to reset the Cash Flow Planner state?', function() {
				frappe.call({
					method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.reset_planner_data',
					callback: function(r) {
						frappe.show_alert({message: __('Planner reset successfully'), indicator: 'green'});
						me.load_data();
					}
				});
			});
		});

		// Tab Switching inside Ledger View
		this.wrapper.find('.cf-view-tab').on('click', function() {
			me.wrapper.find('.cf-view-tab').removeClass('active');
			$(this).addClass('active');
			me.active_tab = $(this).data('tab');
			me.render_ledger();
		});

		// Shift-Click Table Sorting (Standard Table)
		this.wrapper.find('#ledger-table th').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			me.handle_sort_click('single', col, e.shiftKey);
		});

		// Sort badge direction toggle in ledger
		this.wrapper.find('#ledger-btn-sort-dir').on('click', function() {
			var keys = me.active_tab === 'payables' ? me.payables_sort_keys : me.receivables_sort_keys;
			if (keys.length > 0) {
				keys[0].direction = keys[0].direction === 'asc' ? 'desc' : 'asc';
				me.render_ledger();
			}
		});

		// Overdue Only checkbox
		this.wrapper.find('#ledger-chk-overdue').on('change', function() {
			me.render_ledger();
		});

		// Ledger search, group, sort inputs
		this.wrapper.find('#ledger-search-input').on('input', function() {
			me.render_ledger();
		});
		this.wrapper.find('#ledger-group-select').on('change', function() {
			me.render_ledger();
		});
		this.wrapper.find('#ledger-sort-select').on('change', function() {
			var col = $(this).val();
			me.handle_sort_click('single', col, false);
		});

		// Scenario buttons
		this.wrapper.find('#cf-scenario-buttons button').on('click', function() {
			me.wrapper.find('#cf-scenario-buttons button').removeClass('cf-btn-active');
			$(this).addClass('cf-btn-active');
			me.scenario = $(this).data('scenario');
			
			var desc = 'Realistic mode: Calculations reflect standard probability on invoice credit periods.';
			if (me.scenario === 'Optimistic') {
				desc = 'Optimistic mode: Higher receivables collection rate and relaxed payables targets.';
			} else if (me.scenario === 'Stress') {
				desc = 'Stress mode: Reduced receivables collections (70%) and full vendor commitments.';
			}
			me.wrapper.find('#cf-scenario-description').text(desc);
			
			me.recalculate_cash_flow();
			if (me.active_view === 'planner') {
				me.render_planner();
			} else {
				me.render_ledger();
			}
		});

		// Planner Navigation Controls
		this.wrapper.find('#planner-calendar-btn').on('click', function() {
			me.planner_level = 'month';
			me.render_planner();
		});
		this.wrapper.find('#planner-btn-prev').on('click', function() {
			me.navigate_timeline(-1);
		});
		this.wrapper.find('#planner-btn-next').on('click', function() {
			me.navigate_timeline(1);
		});
		this.wrapper.find('#planner-year-select').on('change', function() {
			me.current_year = parseInt($(this).val());
			me.render_planner();
		});

		// Planner Sidebar filters (Payables)
		this.wrapper.find('#drawer-pay-search').on('input', function() {
			me.payables_sidebar_filter.search = $(this).val();
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-pay-btn-priority').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.payables_sidebar_filter.priority = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-pay-btn-high').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.payables_sidebar_filter.high_value = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-pay-btn-overdue').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.payables_sidebar_filter.overdue = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});

		// Planner Sidebar filters (Receivables)
		this.wrapper.find('#drawer-rec-search').on('input', function() {
			me.receivables_sidebar_filter.search = $(this).val();
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-rec-btn-priority').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.receivables_sidebar_filter.priority = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-rec-btn-high').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.receivables_sidebar_filter.high_value = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});
		this.wrapper.find('#drawer-rec-btn-overdue').on('click', function() {
			$(this).toggleClass('cf-btn-active');
			me.receivables_sidebar_filter.overdue = $(this).hasClass('cf-btn-active');
			me.render_planner_sidebars();
		});

		// Modal Note Save
		this.wrapper.find('#modal-btn-save-note').on('click', function() {
			var note = me.wrapper.find('#modal-input-notes').val();
			var inv_id = me.active_note_invoice_id;
			me.notes[inv_id] = note;
			me.$review_modal.removeClass('show');
			
			// Update the invoices in memory
			var inv = me.all_payables.concat(me.all_receivables).find(i => i.name === inv_id);
			if (inv) inv.review_notes = note;
			
			// Refresh views
			if (me.active_view === 'ledger') {
				me.render_ledger();
			} else {
				me.render_planner();
			}
		});
		this.wrapper.find('#modal-btn-close').on('click', function() {
			me.$review_modal.removeClass('show');
		});

		// Drag and drop event delegates for Planner
		this.wrapper.on('dragstart', '.cf-block-item', function(e) {
			e.originalEvent.dataTransfer.setData('text/plain', $(this).data('invoice-id'));
		});

		this.wrapper.on('dragover', '.cf-column-body, #drawer-pay-body, #drawer-rec-body', function(e) {
			e.preventDefault();
		});

		this.wrapper.on('drop', '.cf-column-body', function(e) {
			e.preventDefault();
			var inv_id = e.originalEvent.dataTransfer.getData('text/plain');
			var col_key = $(this).parent().data('col-key');
			if (inv_id && col_key) {
				me.schedules[inv_id] = col_key;
				me.recalculate_cash_flow();
				me.render_planner();
			}
		});

		this.wrapper.on('drop', '#drawer-pay-body, #drawer-rec-body', function(e) {
			e.preventDefault();
			var inv_id = e.originalEvent.dataTransfer.getData('text/plain');
			if (inv_id) {
				delete me.schedules[inv_id];
				me.recalculate_cash_flow();
				me.render_planner();
			}
		});
		
		// Click scheduling (as helper/mobile compatibility)
		this.wrapper.on('click', '.cf-block-item', function(e) {
			// If clicking on star or clock icon, handle differently
			if ($(e.target).closest('.cf-block-icon').length) {
				var icon_type = $(e.target).closest('.cf-block-icon').data('type');
				var inv_id = $(this).data('invoice-id');
				var inv = me.all_payables.concat(me.all_receivables).find(i => i.name === inv_id);
				if (inv) {
					if (icon_type === 'priority') {
						inv.priority = !inv.priority;
					} else if (icon_type === 'late') {
						inv.is_late = !inv.is_late;
					}
					me.recalculate_cash_flow();
					me.render_planner();
				}
				return;
			}
			
			// If clicking review menu
			if ($(e.target).closest('.cf-block-menu').length) {
				var inv_id = $(this).data('invoice-id');
				me.open_review_modal(inv_id);
				return;
			}
			
			// Otherwise trigger click-to-move selector
			var inv_id = $(this).data('invoice-id');
			me.prompt_click_schedule(inv_id);
		});
	}

	set_view(view) {
		this.active_view = view;
		if (view === 'planner') {
			this.$btn_view_toggle.text('Ledger').removeClass('cf-btn-warning').addClass('cf-btn-primary');
			this.$ledger_container.addClass('cf-hidden');
			this.$planner_container.removeClass('cf-hidden');
			this.render_planner();
		} else {
			this.$btn_view_toggle.text('Plan').removeClass('cf-btn-primary').addClass('cf-btn-warning');
			this.$planner_container.addClass('cf-hidden');
			this.$ledger_container.removeClass('cf-hidden');
			this.render_ledger();
		}
	}

	load_data() {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.get_planner_data',
			args: {
				base_date: me.base_date
			},
			callback: function(r) {
				if (r.message) {
					me.all_payables = r.message.payables || [];
					me.all_receivables = r.message.receivables || [];
					
					// Populate filters groups options
					me.supplier_groups = r.message.supplier_groups || [];
					me.customer_groups = r.message.customer_groups || [];
					
					// Load saved configurations
					var config = r.message.config || {};
					me.opening_balance = config.opening_balance || 80.00;
					me.$input_opening.val(me.opening_balance);
					me.horizon = config.horizon || '6 wks';
					me.$select_horizon.val(me.horizon);
					me.scenario = config.scenario || 'Realistic';
					
					me.schedules = config.schedules || {};
					me.notes = config.notes || {};
					
					// Bind values to active buttons
					me.wrapper.find('#cf-scenario-buttons button').removeClass('cf-btn-active');
					me.wrapper.find(`#cf-scenario-buttons button[data-scenario="${me.scenario}"]`).addClass('cf-btn-active');
					
					me.recalculate_cash_flow();
					
					if (me.active_view === 'ledger') {
						me.render_ledger();
					} else {
						me.render_planner();
					}
				}
			}
		});
	}

	save_state() {
		var me = this;
		frappe.call({
			method: 'cashdash.cashdash.page.cash_flow_planner.cash_flow_planner.save_planner_data',
			args: {
				opening_balance: me.opening_balance,
				horizon: me.horizon,
				scenario: me.scenario,
				schedules: JSON.stringify(me.schedules),
				notes: JSON.stringify(me.notes),
				cc_utilization: me.cc_utilization,
				bd_utilization: me.bd_utilization
			},
			callback: function(r) {
				if (r.message && r.message.status === 'success') {
					frappe.show_alert({message: __('Cash Flow plan saved'), indicator: 'green'});
				}
			}
		});
	}

	recalculate_cash_flow() {
		// Calculate the probability scales based on the scenario
		var pay_scale = 1.0;
		var rec_scale = 1.0;
		
		if (this.scenario === 'Optimistic') {
			pay_scale = 0.8; // pay vendors less or later
			rec_scale = 1.0; // receive full customer cash
		} else if (this.scenario === 'Stress') {
			pay_scale = 1.0; // pay vendors in full
			rec_scale = 0.7; // receive only 70% customer cash
		} else {
			// Realistic
			pay_scale = 1.0;
			rec_scale = 0.9; // 90% collection rate
		}
		
		// Apply probability scale to values
		this.payables = this.all_payables.map(inv => {
			var scaled_val = inv.outstanding * pay_scale;
			return Object.assign({}, inv, { scaled_outstanding: scaled_val });
		});

		this.receivables = this.all_receivables.map(inv => {
			var scaled_val = inv.outstanding * rec_scale;
			return Object.assign({}, inv, { scaled_outstanding: scaled_val });
		});

		// Compute metrics (CC/BD utilization, Lowest cash, Horizon Net)
		// Cash Credit: CC utilization tracks cumulative cash deficits.
		// BD: Bill Discounting tracks discounted receivables. Let's say any customer invoice with priority (starred) is discounted.
		var bd_total = 0;
		this.receivables.forEach(inv => {
			if (inv.priority) {
				bd_total += inv.outstanding;
			}
		});
		this.bd_utilization = bd_total;
		
		// Calculate cash progression across weeks
		var horizon_weeks = parseInt(this.horizon) || 6;
		var base_cash = this.opening_balance * 100000; // in Rupees
		var running_cash = base_cash;
		var lowest_cash = base_cash;
		
		// Map schedules to find weekly flows
		var week_net_flows = Array(horizon_weeks).fill(0);
		
		// Process payables
		this.payables.forEach(inv => {
			var sched = this.schedules[inv.name];
			if (sched) {
				// check which week it falls in
				var wk_idx = this.get_week_index_from_schedule(sched);
				if (wk_idx >= 0 && wk_idx < horizon_weeks) {
					week_net_flows[wk_idx] -= inv.scaled_outstanding;
				}
			}
		});

		// Process receivables
		this.receivables.forEach(inv => {
			var sched = this.schedules[inv.name];
			if (sched) {
				var wk_idx = this.get_week_index_from_schedule(sched);
				if (wk_idx >= 0 && wk_idx < horizon_weeks) {
					// if discounted, cash is received in Week 1, utilizing BD limit
					if (inv.priority) {
						week_net_flows[0] += inv.scaled_outstanding;
					} else {
						week_net_flows[wk_idx] += inv.scaled_outstanding;
					}
				}
			}
		});

		// Track running cash and find lowest point
		var cumulative_lowest = base_cash;
		for (var i = 0; i < horizon_weeks; i++) {
			running_cash += week_net_flows[i];
			if (running_cash < cumulative_lowest) {
				cumulative_lowest = running_cash;
			}
		}

		// Cash Credit (CC) covers the deficit (if running cash goes negative)
		var cc_draw = cumulative_lowest < 0 ? Math.abs(cumulative_lowest) : 0;
		this.cc_utilization = cc_draw;

		// Update UI elements in Header
		this.update_metrics_ui(running_cash, cumulative_lowest);
	}

	get_week_index_from_schedule(sched) {
		// sched can be: '2026-06-01' (day), '2026-W23' (week), '2026-06' (month)
		if (sched.includes('-W')) {
			// week format
			var parts = sched.split('-W');
			var w_num = parseInt(parts[1]) - 23; // base week starting June 1 is W23
			return w_num;
		} else if (sched.match(/^\d{4}-\d{2}-\d{2}$/)) {
			// day format
			var dt = new Date(sched);
			var base_dt = new Date('2026-06-01');
			var diff_days = Math.floor((dt - base_dt) / (1000 * 60 * 60 * 24));
			return Math.floor(diff_days / 7);
		} else if (sched.match(/^\d{4}-\d{2}$/)) {
			// month format
			var parts = sched.split('-');
			if (parts[1] === '06') return 2; // middle of the month
			return 5;
		}
		return -1;
	}

	update_metrics_ui(final_cash, lowest_cash) {
		// Update Net summary banner dynamically
		var total_pay = this.payables ? this.payables.reduce((a, b) => a + b.outstanding, 0) : 0;
		var total_rec = this.receivables ? this.receivables.reduce((a, b) => a + b.outstanding, 0) : 0;
		var net_diff = total_rec - total_pay;
		
		this.wrapper.find('#lbl-payables-total').text('₹' + total_pay.toLocaleString('en-IN'));
		this.wrapper.find('#lbl-receivables-total').text('₹' + total_rec.toLocaleString('en-IN'));
		
		var net_badge = this.wrapper.find('#lbl-net-difference');
		var net_sign = net_diff >= 0 ? '+' : '';
		net_badge.text(`${net_sign}₹${net_diff.toLocaleString('en-IN')}`);
		
		if (net_diff >= 0) {
			net_badge.css({ 'background': '#d1fae5', 'color': '#065f46' });
			this.wrapper.find('#lbl-net-verdict').text('Receivables cover payables with a surplus.');
		} else {
			net_badge.css({ 'background': '#fee2e2', 'color': '#b91c1c' });
			this.wrapper.find('#lbl-net-verdict').text('Payables exceed receivables; deficit detected.');
		}

		// Update CC slider
		var cc_pct = Math.min(100, (this.cc_utilization / this.cc_limit) * 100);
		this.$cc_gauge_text.text(`₹${(this.cc_utilization/10000000).toFixed(2)}Cr / ₹${(this.cc_limit/10000000).toFixed(2)}Cr`);
		this.$cc_gauge_fill.css('width', `${cc_pct}%`);
		if (cc_pct > 90) {
			this.$cc_gauge_fill.removeClass('warning').addClass('danger');
			this.$cc_gauge_subtext.text('Limit Exceeded / High Draw').css('color', '#dc2626');
		} else {
			this.$cc_gauge_fill.removeClass('danger warning');
			this.$cc_gauge_subtext.text('Within facility').css('color', '#6b7280');
		}

		// Update BD slider
		var bd_pct = Math.min(100, (this.bd_utilization / this.bd_limit) * 100);
		this.$bd_gauge_text.text(`₹${(this.bd_utilization/10000000).toFixed(2)}Cr / ₹${(this.bd_limit/10000000).toFixed(2)}Cr`);
		this.$bd_gauge_fill.css('width', `${bd_pct}%`);
		if (bd_pct > 90) {
			this.$bd_gauge_fill.removeClass('warning').addClass('danger');
			this.$bd_gauge_subtext.text('Limit Exceeded').css('color', '#dc2626');
		} else {
			this.$bd_gauge_fill.removeClass('danger warning');
			this.$bd_gauge_subtext.text('Within facility').css('color', '#6b7280');
		}

		// Top Right Header widgets
		var horizon_net_val = (final_cash / 10000000).toFixed(2);
		this.$hdr_horizon_net.text(`₹${horizon_net_val}Cr`);
		if (final_cash < 0) {
			this.$hdr_horizon_net.css('color', '#dc2626');
		} else {
			this.$hdr_horizon_net.css('color', '#16a34a');
		}
		
		var lowest_cash_lakhs = (lowest_cash / 100000).toFixed(2);
		this.$hdr_lowest_cash.text(`₹${lowest_cash_lakhs}L`);
		if (lowest_cash < 0) {
			this.$hdr_lowest_cash.css('color', '#dc2626');
		} else {
			this.$hdr_lowest_cash.css('color', '#16a34a');
		}

		// Count of unscheduled invoices
		var unsched_cnt = 0;
		this.payables.forEach(i => { if (!this.schedules[i.name]) unsched_cnt++; });
		this.receivables.forEach(i => { if (!this.schedules[i.name]) unsched_cnt++; });
		this.$hdr_unscheduled_count.text(unsched_cnt);
	}

	// ==================== LEDGER RENDER METHODS ====================
	render_ledger() {
		var me = this;
		
		// Toggle split vs single layout
		if (this.active_tab === 'side-by-side') {
			this.$single_view.addClass('cf-hidden');
			this.$split_view.removeClass('cf-hidden');
			this.render_ledger_split();
			return;
		}

		this.$split_view.addClass('cf-hidden');
		this.$single_view.removeClass('cf-hidden');
		
		// Update table column header labels
		var $tbl = this.wrapper.find('#ledger-table');
		var is_pay = this.active_tab === 'payables';
		$tbl.find('th[data-col="party"]').text(is_pay ? 'SUPPLIER' : 'CUSTOMER');
		$tbl.find('th[data-col="value"]').text(is_pay ? 'ORDER VALUE' : 'INVOICE VALUE');

		// Populate Group select filters dynamically
		var groups = is_pay ? (this.supplier_groups || []) : (this.customer_groups || []);
		var $group_sel = this.wrapper.find('#ledger-group-select');
		var current_val = $group_sel.val();
		$group_sel.empty().append('<option value="">All groups</option>');
		groups.forEach(g => {
			$group_sel.append(`<option value="${g}">${g}</option>`);
		});
		if (groups.includes(current_val)) {
			$group_sel.val(current_val);
		}

		// Update explainer text
		var explainer = is_pay 
			? 'Assumed credit terms (Net 0-90) applied. Red color marks overdue invoices.' 
			: 'Standard credit terms applied. Green color marks pending receivables.';
		this.wrapper.find('#cf-tab-explainer').text(explainer);
		
		// Filter and sort data
		var data = is_pay ? this.payables : this.receivables;
		var filtered = this.filter_ledger_data(data);
		var sorted = this.sort_ledger_data(filtered, is_pay);
		
		// Update UI counts
		this.wrapper.find('#lbl-records-count').text(`${sorted.length} of ${data.length}`);
		
		// Set Sort Tags
		this.render_sort_badges(is_pay);
		
		// Render table body
		var $tbody = this.wrapper.find('#ledger-table-body');
		$tbody.empty();
		
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
					<td>₹${row.value.toLocaleString('en-IN')}</td>
					<td style="font-weight: 700;">₹${row.outstanding.toLocaleString('en-IN')}</td>
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

		// Bind actions on notes
		$tbody.find('.btn-review-note, .btn-edit-note-icon').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});
		
		// Update standard KPI deck values
		this.render_kpi_deck(is_pay);
	}

	render_kpi_deck(is_pay) {
		var data = is_pay ? this.payables : this.receivables;
		var title1 = is_pay ? 'Invoices' : 'Invoices';
		var sub1 = is_pay ? `${this.get_unique_parties_count(data)} suppliers` : `${this.get_unique_parties_count(data)} customers`;
		
		var title2 = is_pay ? 'Order Value' : 'Invoice Value';
		var sub2 = is_pay ? 'submitted PIs' : 'submitted SIs';
		
		var total_val = data.reduce((a, b) => a + b.value, 0);
		var outstanding_val = data.reduce((a, b) => a + b.outstanding, 0);
		var overdue_cnt = data.filter(d => d.age_days > 0).length;
		
		this.wrapper.find('#kpi-1-label').text(title1);
		this.wrapper.find('#kpi-1-val').text(data.length);
		this.wrapper.find('#kpi-1-sub').text(sub1);
		
		this.wrapper.find('#kpi-2-label').text(title2);
		this.wrapper.find('#kpi-2-val').text(`₹${total_val.toLocaleString('en-IN')}`);
		this.wrapper.find('#kpi-2-sub').text(sub2);
		
		this.wrapper.find('#kpi-3-label').text('Outstanding');
		this.wrapper.find('#kpi-3-val').text(`₹${outstanding_val.toLocaleString('en-IN')}`);
		this.wrapper.find('#kpi-3-sub').text(is_pay ? 'still payable' : 'still receivable');
		
		this.wrapper.find('#kpi-4-label').text('Overdue');
		this.wrapper.find('#kpi-4-val').text(overdue_cnt);
	}

	get_unique_parties_count(data) {
		var s = new Set();
		data.forEach(d => s.add(d.party));
		return s.size;
	}

	filter_ledger_data(data) {
		var search = this.wrapper.find('#ledger-search-input').val().toLowerCase();
		var group = this.wrapper.find('#ledger-group-select').val();
		var overdue_only = this.wrapper.find('#ledger-chk-overdue').is(':checked');
		
		return data.filter(item => {
			if (search) {
				var matches = item.party.toLowerCase().includes(search) || 
				              item.name.toLowerCase().includes(search) || 
				              item.ref_no.toLowerCase().includes(search);
				if (!matches) return false;
			}
			if (group && item.party_group !== group) return false;
			if (overdue_only && item.age_days <= 0) return false;
			return true;
		});
	}

	sort_ledger_data(data, is_pay) {
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		if (keys.length === 0) return data;
		
		var sorted = [...data];
		sorted.sort((a, b) => {
			for (var sortObj of keys) {
				var col = sortObj.column;
				var dir = sortObj.direction === 'asc' ? 1 : -1;
				
				var valA = a[col];
				var valB = b[col];
				
				// Handle date comparisons
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

	handle_sort_click(view_type, col, is_shift) {
		var is_pay = this.active_tab === 'payables';
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		
		var existing_idx = keys.findIndex(k => k.column === col);
		
		if (!is_shift) {
			// Clear all others
			if (existing_idx >= 0) {
				// Cycle: asc -> desc -> clear
				var current = keys[existing_idx];
				if (current.direction === 'asc') {
					current.direction = 'desc';
					keys.splice(0, keys.length, current);
				} else {
					keys.splice(0, keys.length); // clear all
				}
			} else {
				keys.splice(0, keys.length, { column: col, direction: 'asc' });
			}
		} else {
			// Shift key active (multi-sort)
			if (existing_idx >= 0) {
				var current = keys[existing_idx];
				if (current.direction === 'asc') {
					current.direction = 'desc';
				} else {
					keys.splice(existing_idx, 1); // remove
				}
			} else {
				keys.push({ column: col, direction: 'asc' });
			}
		}
		
		this.render_ledger();
	}

	render_sort_badges(is_pay) {
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		var $hdr = this.wrapper.find('#ledger-table th');
		
		// Clear styles
		$hdr.removeClass('active-sort').find('.sort-priority').remove();
		
		// Add active classes and priority badges
		keys.forEach((k, idx) => {
			var $th = $hdr.filter(`[data-col="${k.column}"]`);
			if ($th.length) {
				$th.addClass('active-sort');
				var label = k.direction === 'asc' ? '↑' : '↓';
				$th.append(`<span class="sort-priority">${idx + 1} ${label}</span>`);
			}
		});

		// Render sorted tags list
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
					me.render_ledger();
				}
			});
			$tag_container.append(tag);
		});
	}

	render_ledger_split() {
		var me = this;
		
		// Populate Group select filters for panes
		var pay_groups = Array.from(new Set(this.payables.map(i => i.party_group)));
		var rec_groups = Array.from(new Set(this.receivables.map(i => i.party_group)));
		
		var $pg = this.wrapper.find('#split-pay-group');
		$pg.empty().append('<option value="">All groups</option>');
		pay_groups.forEach(g => $pg.append(`<option value="${g}">${g}</option>`));
		
		var $rg = this.wrapper.find('#split-rec-group');
		$rg.empty().append('<option value="">All groups</option>');
		rec_groups.forEach(g => $rg.append(`<option value="${g}">${g}</option>`));

		// Recalculate side totals
		var pay_total = this.payables.reduce((a, b) => a + b.outstanding, 0);
		var pay_cnt = this.payables.length;
		var pay_overdue = this.payables.filter(i => i.age_days > 0).length;

		var rec_total = this.receivables.reduce((a, b) => a + b.outstanding, 0);
		var rec_cnt = this.receivables.length;
		var rec_overdue = this.receivables.filter(i => i.age_days > 0).length;

		this.wrapper.find('#split-pay-kpi-invoices').text(pay_cnt);
		this.wrapper.find('#split-pay-kpi-value').text(`₹${(pay_total/10000000).toFixed(2)}Cr`);
		this.wrapper.find('#split-pay-kpi-outstanding').text(`₹${(pay_total/10000000).toFixed(2)}Cr`);
		this.wrapper.find('#split-pay-kpi-overdue').text(pay_overdue);

		this.wrapper.find('#split-rec-kpi-invoices').text(rec_cnt);
		this.wrapper.find('#split-rec-kpi-value').text(`₹${(rec_total/10000000).toFixed(2)}Cr`);
		this.wrapper.find('#split-rec-kpi-outstanding').text(`₹${(rec_total/10000000).toFixed(2)}Cr`);
		this.wrapper.find('#split-rec-kpi-overdue').text(rec_overdue);

		// Render left table (Payables)
		var pay_search = this.wrapper.find('#split-pay-search').val() || '';
		var pay_grp = this.wrapper.find('#split-pay-group').val() || '';
		
		var f_pay = this.payables.filter(item => {
			if (pay_search && !item.party.toLowerCase().includes(pay_search.toLowerCase()) && !item.name.toLowerCase().includes(pay_search.toLowerCase())) return false;
			if (pay_grp && item.party_group !== pay_grp) return false;
			return true;
		});
		
		// Sort payables
		var s_pay = this.sort_ledger_data(f_pay, true);
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
					<td>₹${row.outstanding.toLocaleString('en-IN')}</td>
					<td>${age_badge}</td>
					<td><button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button></td>
				</tr>
			`);
			$pay_body.append(tr);
		});

		// Render right table (Receivables)
		var rec_search = this.wrapper.find('#split-rec-search').val() || '';
		var rec_grp = this.wrapper.find('#split-rec-group').val() || '';
		
		var f_rec = this.receivables.filter(item => {
			if (rec_search && !item.party.toLowerCase().includes(rec_search.toLowerCase()) && !item.name.toLowerCase().includes(rec_search.toLowerCase())) return false;
			if (rec_grp && item.party_group !== rec_grp) return false;
			return true;
		});
		
		var s_rec = this.sort_ledger_data(f_rec, false);
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
					<td>₹${row.outstanding.toLocaleString('en-IN')}</td>
					<td>${age_badge}</td>
					<td><button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button></td>
				</tr>
			`);
			$rec_body.append(tr);
		});

		// Bind actions
		this.wrapper.find('.btn-split-review').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});

		// Bind filter updates
		this.wrapper.find('#split-pay-search, #split-rec-search').off('input').on('input', function() { me.render_ledger_split(); });
		this.wrapper.find('#split-pay-group, #split-rec-group').off('change').on('change', function() { me.render_ledger_split(); });
		
		// Split screen table sorting delegates
		this.wrapper.find('#split-pay-table th, #split-rec-table th').off('click').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			var pane_is_pay = $(this).closest('table').attr('id') === 'split-pay-table';
			
			// Temporarily lock active tab to sort correct stack
			me.active_tab = pane_is_pay ? 'payables' : 'receivables';
			me.handle_sort_click('split', col, e.shiftKey);
			me.active_tab = 'side-by-side'; // revert
		});
	}

	open_review_modal(inv_id) {
		this.active_note_invoice_id = inv_id;
		var inv = this.all_payables.concat(this.all_receivables).find(i => i.name === inv_id);
		if (inv) {
			this.wrapper.find('#modal-lbl-invoice-id').text(inv.name);
			this.wrapper.find('#modal-lbl-party-name').text(inv.party);
			this.wrapper.find('#modal-lbl-outstanding').text(`₹${inv.outstanding.toLocaleString('en-IN')}`);
			this.wrapper.find('#modal-input-notes').val(this.notes[inv_id] || '');
			this.$review_modal.addClass('show');
		}
	}

	// ==================== PLANNER RENDER METHODS ====================
	render_planner() {
		this.render_planner_header();
		this.render_planner_sidebars();
		this.render_planner_timeline();
	}

	render_planner_header() {
		// Breadcrumbs text depending on planner_level
		var base_lbl = `Calendar · 115 months · 501 wks · horizon ${this.horizon} → 12-07`;
		var net_horizon = this.wrapper.find('#hdr-horizon-net').text();
		
		if (this.planner_level === 'month') {
			this.wrapper.find('#planner-calendar-level-text').text('Calendar');
			this.wrapper.find('#planner-breadcrumb-path').text(base_lbl);
			this.wrapper.find('#planner-net-horizon-val').text(`2026 net ${net_horizon}`);
		} else if (this.planner_level === 'week') {
			var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			var active_m_lbl = `${m_names[this.current_month]} ${this.current_year} · 5 weeks`;
			this.wrapper.find('#planner-calendar-level-text').text('Weeks');
			this.wrapper.find('#planner-breadcrumb-path').text(`Calendar > ${active_m_lbl}`);
			this.wrapper.find('#planner-net-horizon-val').text(`${m_names[this.current_month]} net ${net_horizon}`);
		} else {
			// day level
			this.wrapper.find('#planner-calendar-level-text').text('Days');
			this.wrapper.find('#planner-breadcrumb-path').text(`Calendar > Jun 2026 > Week ${this.current_week + 1} drill-down`);
			this.wrapper.find('#planner-net-horizon-val').text(`Week ${this.current_week + 1} net ${net_horizon}`);
		}
	}

	render_planner_sidebars() {
		var me = this;
		
		// RENDER PAYABLES SIDEBAR
		var pay_sidebar_data = this.payables.filter(item => {
			if (me.schedules[item.name]) return false; // scheduled elsewhere
			
			// Sidebar filter controls
			if (me.payables_sidebar_filter.search) {
				var s = me.payables_sidebar_filter.search.toLowerCase();
				if (!item.party.toLowerCase().includes(s) && !item.name.toLowerCase().includes(s)) return false;
			}
			if (me.payables_sidebar_filter.priority && !item.priority) return false;
			if (me.payables_sidebar_filter.high_value && item.scaled_outstanding < 100000) return false; // > ₹1.00L
			if (me.payables_sidebar_filter.overdue && item.age_days <= 0) return false;
			
			return true;
		});

		// Group payables by party for summary list card rendering
		var grouped_pay = this.group_invoices_by_party(pay_sidebar_data);
		var $pay_body = this.wrapper.find('#drawer-pay-body').empty();
		this.wrapper.find('#drawer-pay-count').text(pay_sidebar_data.length);
		
		if (grouped_pay.length === 0) {
			$pay_body.append(`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">No payables unscheduled.</div>`);
		} else {
			grouped_pay.forEach(g => {
				var block_html = this.create_block_item_element(g, 'pay');
				$pay_body.append(block_html);
			});
		}

		// RENDER RECEIVABLES SIDEBAR
		var rec_sidebar_data = this.receivables.filter(item => {
			if (me.schedules[item.name]) return false; // scheduled
			
			if (me.receivables_sidebar_filter.search) {
				var s = me.receivables_sidebar_filter.search.toLowerCase();
				if (!item.party.toLowerCase().includes(s) && !item.name.toLowerCase().includes(s)) return false;
			}
			if (me.receivables_sidebar_filter.priority && !item.priority) return false;
			if (me.receivables_sidebar_filter.high_value && item.scaled_outstanding < 100000) return false;
			if (me.receivables_sidebar_filter.overdue && item.age_days <= 0) return false;
			
			return true;
		});

		var grouped_rec = this.group_invoices_by_party(rec_sidebar_data);
		var $rec_body = this.wrapper.find('#drawer-rec-body').empty();
		this.wrapper.find('#drawer-rec-count').text(rec_sidebar_data.length);
		
		if (grouped_rec.length === 0) {
			$rec_body.append(`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">No receivables unscheduled.</div>`);
		} else {
			grouped_rec.forEach(g => {
				var block_html = this.create_block_item_element(g, 'rec');
				$rec_body.append(block_html);
			});
		}
		
		// Render scheduled for later counters
		var later_pay = this.payables.filter(item => me.schedules[item.name] && me.schedules[item.name].includes('later'));
		var later_pay_val = later_pay.reduce((a, b) => a + b.scaled_outstanding, 0);
		this.wrapper.find('#sidebar-later-pay-val').text(`${later_pay.length} · ₹${(later_pay_val/100000).toFixed(2)}L`);
		
		var later_rec = this.receivables.filter(item => me.schedules[item.name] && me.schedules[item.name].includes('later'));
		var later_rec_val = later_rec.reduce((a, b) => a + b.scaled_outstanding, 0);
		this.wrapper.find('#sidebar-later-rec-val').text(`${later_rec.length} · ₹${(later_rec_val/100000).toFixed(2)}L`);
	}

	group_invoices_by_party(list) {
		var map = {};
		list.forEach(inv => {
			if (!map[inv.party]) {
				map[inv.party] = {
					party: inv.party,
					party_id: inv.party_id,
					name: inv.name,
					outstanding: 0,
					count: 0,
					invoices: [],
					priority: false,
					is_late: false
				};
			}
			map[inv.party].outstanding += inv.scaled_outstanding;
			map[inv.party].count += 1;
			map[inv.party].invoices.push(inv);
			if (inv.priority) map[inv.party].priority = true;
			if (inv.age_days > 0) map[inv.party].is_late = true;
		});
		return Object.values(map);
	}

	create_block_item_element(g, type) {
		var amount_l = (g.outstanding / 100000).toFixed(2);
		var badge_class = type === 'pay' ? 'pay' : 'rec';
		var badge_lbl = type === 'pay' ? 'PAY' : 'REC';
		
		var star_color = g.priority ? '#eab308' : '#cbd5e1';
		var star_class = g.priority ? 'starred' : '';
		
		var clock_color = g.is_late ? '#f97316' : '#cbd5e1';
		
		var count_badge = g.count > 1 ? `<span class="cf-block-count">${g.count}</span>` : '';
		
		// If more than 1 invoice, make it collapsible
		var children_html = '';
		if (g.count > 1) {
			children_html = `<div class="cf-block-expanded-list cf-hidden" id="child-list-${g.party_id}">`;
			g.invoices.forEach(inv => {
				children_html += `
					<div class="cf-child-invoice-item">
						<span style="font-family: monospace;">${inv.name}</span>
						<strong>₹${(inv.scaled_outstanding/100000).toFixed(2)}L</strong>
					</div>
				`;
			});
			children_html += `</div>`;
		}
		
		var arrow_toggle = g.count > 1 ? `<span class="cf-block-arrow-toggle" style="cursor: pointer; margin-right: 5px;">▶</span>` : '';
		
		var item = $(`
			<div class="cf-block-item" draggable="true" data-invoice-id="${g.name}" id="blk-card-${g.party_id}">
				<div class="cf-block-header">
					<div class="cf-flex cf-flex-align">
						${arrow_toggle}
						<span class="cf-block-badge ${badge_class}">${badge_lbl}</span>
						<span class="cf-block-party" style="margin-left: 6px;" title="${g.party}">${g.party}</span>
					</div>
					<div class="cf-flex cf-gap-10 cf-flex-align">
						<span class="cf-block-icon" data-type="priority" style="cursor: pointer; color: ${star_color}; font-size: 14px;">★</span>
						<span class="cf-block-icon" data-type="late" style="cursor: pointer; color: ${clock_color}; font-size: 13px;">⏱</span>
						<span class="cf-block-menu" style="cursor: pointer; color: #94a3b8; font-size: 12px;">⋮</span>
					</div>
				</div>
				<div class="cf-block-details">
					<span style="font-family: monospace;">${g.name}</span>
				</div>
				<div class="cf-block-amount-row">
					${g.is_late ? '<span class="cf-block-late-pill">LATE</span>' : '<span></span>'}
					<div class="cf-flex cf-flex-align cf-gap-10">
						${count_badge}
						<span class="cf-block-amount">₹${amount_l}L</span>
					</div>
				</div>
				${children_html}
			</div>
		`);
		
		// Collapsible trigger event
		item.find('.cf-block-arrow-toggle').on('click', function(e) {
			e.stopPropagation();
			var list = item.find(`#child-list-${g.party_id}`);
			if (list.hasClass('cf-hidden')) {
				list.removeClass('cf-hidden');
				$(this).text('▼');
			} else {
				list.addClass('cf-hidden');
				$(this).text('▶');
			}
		});
		
		return item;
	}

	render_planner_timeline() {
		var me = this;
		var $container = this.wrapper.find('#planner-timeline-cols').empty();
		
		if (this.planner_level === 'month') {
			this.render_timeline_months($container);
		} else if (this.planner_level === 'week') {
			this.render_timeline_weeks($container);
		} else {
			this.render_timeline_days($container);
		}
	}

	render_timeline_months($container) {
		var me = this;
		var months = [
			{ key: '2026-06', label: 'Jun', wks: '5 wks' },
			{ key: '2026-07', label: 'Jul', wks: '4 wks' },
			{ key: '2026-08', label: 'Aug', wks: '4 wks' },
			{ key: '2026-09', label: 'Sep', wks: '4 wks' },
		];

		var base_cash = this.opening_balance * 100000;
		var running_cash = base_cash;

		months.forEach(m => {
			// Get flows for this month column
			var pay_flow = 0;
			var rec_flow = 0;
			
			var col_payables = this.payables.filter(i => me.schedules[i.name] === m.key);
			col_payables.forEach(i => pay_flow += i.scaled_outstanding);
			
			var col_receivables = this.receivables.filter(i => me.schedules[i.name] === m.key);
			col_receivables.forEach(i => {
				if (i.priority) {
					// discounted receipts hit first week, not here
				} else {
					rec_flow += i.scaled_outstanding;
				}
			});
			
			var net_flow = rec_flow - pay_flow;
			running_cash += net_flow;
			
			var net_class = net_flow < 0 ? 'negative' : 'positive';
			var net_sign = net_flow >= 0 ? '+' : '';
			
			var col = $(`
				<div class="cf-timeline-column" data-col-key="${m.key}">
					<div class="cf-column-header">
						<div class="cf-flex-between">
							<span class="cf-column-title">${m.label}</span>
							<span style="font-size: 10px; color: #64748b; font-weight: 600;">${m.wks}</span>
						</div>
						<div class="cf-column-net ${net_class}">${net_sign}₹${(net_flow/100000).toFixed(2)}L</div>
						<div class="cf-column-flows">
							<span>▲ ₹${(rec_flow/100000).toFixed(2)}L</span>
							<span>▼ ₹${(pay_flow/100000).toFixed(2)}L</span>
						</div>
						<div class="cf-column-balance">Σ ₹${(running_cash/100000).toFixed(2)}L</div>
					</div>
					<div class="cf-column-body">
						<!-- Items placed here -->
					</div>
					<div class="cf-drill-btn" id="drill-month-${m.label}">WEEKS →</div>
				</div>
			`);
			
			// Populate items inside month column
			var col_all = col_payables.concat(col_receivables);
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				var blk = this.create_block_item_element(g, type);
				$body.append(blk);
			});

			col.find(`#drill-month-${m.label}`).on('click', function(e) {
				e.stopPropagation();
				me.planner_level = 'week';
				me.current_month = m.label === 'Jun' ? 5 : m.label === 'Jul' ? 6 : m.label === 'Aug' ? 7 : 8;
				me.render_planner();
			});
			
			$container.append(col);
		});
	}

	render_timeline_weeks($container) {
		var me = this;
		var weeks = [
			{ key: '2026-W23', label: 'Week 1', date_range: 'Jun 1 - Jun 7' },
			{ key: '2026-W24', label: 'Week 2', date_range: 'Jun 8 - Jun 14' },
			{ key: '2026-W25', label: 'Week 3', date_range: 'Jun 15 - Jun 21' },
			{ key: '2026-W26', label: 'Week 4', date_range: 'Jun 22 - Jun 28' },
			{ key: '2026-W27', label: 'Week 5', date_range: 'Jun 29 - Jul 5' },
		];

		var base_cash = this.opening_balance * 100000;
		var running_cash = base_cash;

		weeks.forEach((w, idx) => {
			var pay_flow = 0;
			var rec_flow = 0;
			
			var col_payables = this.payables.filter(i => me.schedules[i.name] === w.key);
			col_payables.forEach(i => pay_flow += i.scaled_outstanding);
			
			var col_receivables = this.receivables.filter(i => me.schedules[i.name] === w.key);
			col_receivables.forEach(i => {
				if (i.priority) {
					// Discounted collection: goes straight to week 1
				} else {
					rec_flow += i.scaled_outstanding;
				}
			});
			
			// Inject discounted receipts specifically into week 1 (CC/BD logic)
			if (idx === 0) {
				this.receivables.forEach(i => {
					if (i.priority && me.schedules[i.name]) {
						rec_flow += i.scaled_outstanding;
					}
				});
			}
			
			var net_flow = rec_flow - pay_flow;
			running_cash += net_flow;
			
			var net_class = net_flow < 0 ? 'negative' : 'positive';
			var net_sign = net_flow >= 0 ? '+' : '';
			
			var col = $(`
				<div class="cf-timeline-column" data-col-key="${w.key}">
					<div class="cf-column-header">
						<div class="cf-flex-between">
							<span class="cf-column-title">${w.label}</span>
							<span style="font-size: 9px; color: #64748b;">${w.date_range}</span>
						</div>
						<div class="cf-column-net ${net_class}">${net_sign}₹${(net_flow/100000).toFixed(2)}L</div>
						<div class="cf-column-flows">
							<span>▲ ₹${(rec_flow/100000).toFixed(2)}L</span>
							<span>▼ ₹${(pay_flow/100000).toFixed(2)}L</span>
						</div>
						<div class="cf-column-balance">Σ ₹${(running_cash/100000).toFixed(2)}L</div>
					</div>
					<div class="cf-column-body"></div>
					<div class="cf-drill-btn" id="drill-week-${idx}">DRILL</div>
				</div>
			`);
			
			// Populate items
			var col_all = col_payables.concat(col_receivables);
			if (idx === 0) {
				// add discounted items to Week 1 column list visually
				var discounted = this.receivables.filter(i => i.priority && me.schedules[i.name]);
				col_all = col_all.concat(discounted);
			}
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				var blk = this.create_block_item_element(g, type);
				$body.append(blk);
			});

			col.find(`#drill-week-${idx}`).on('click', function(e) {
				e.stopPropagation();
				me.planner_level = 'day';
				me.current_week = idx;
				me.render_planner();
			});
			
			$container.append(col);
		});
	}

	render_timeline_days($container) {
		var me = this;
		
		// Weekdays mapping for Week 1 (Jun 1 to Jun 5)
		var days = [
			{ key: '2026-06-01', label: 'Mon, Jun 1', status: 'PAST' },
			{ key: '2026-06-02', label: 'Tue, Jun 2', status: 'PAST' },
			{ key: '2026-06-03', label: 'Wed, Jun 3', status: 'TODAY' },
			{ key: '2026-06-04', label: 'Thu, Jun 4', status: '' },
			{ key: '2026-06-05', label: 'Fri, Jun 5', status: '' }
		];

		// If current_week is different, adjust dates accordingly
		var start_day_offset = this.current_week * 7;
		if (start_day_offset > 0) {
			days = days.map((d, idx) => {
				var base_d = new Date('2026-06-01');
				base_d.setDate(base_d.getDate() + start_day_offset + idx);
				var date_str = base_d.toISOString().split('T')[0];
				
				var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
				var label = `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][idx]}, ${m_names[base_d.getMonth()]} ${base_d.getDate()}`;
				
				return {
					key: date_str,
					label: label,
					status: ''
				};
			});
		}

		var base_cash = this.opening_balance * 100000;
		var running_cash = base_cash;

		days.forEach(d => {
			var pay_flow = 0;
			var rec_flow = 0;
			
			var col_payables = this.payables.filter(i => me.schedules[i.name] === d.key);
			col_payables.forEach(i => pay_flow += i.scaled_outstanding);
			
			var col_receivables = this.receivables.filter(i => me.schedules[i.name] === d.key);
			col_receivables.forEach(i => {
				if (i.priority) {
					// discounted
				} else {
					rec_flow += i.scaled_outstanding;
				}
			});
			
			// Star/Discounted receipts hit the very first day of Week 1 if they are scheduled anywhere
			if (d.status === 'TODAY' || d.key === '2026-06-03') {
				this.receivables.forEach(i => {
					if (i.priority && me.schedules[i.name]) {
						rec_flow += i.scaled_outstanding;
					}
				});
			}

			var net_flow = rec_flow - pay_flow;
			running_cash += net_flow;
			
			var net_class = net_flow < 0 ? 'negative' : 'positive';
			var net_sign = net_flow >= 0 ? '+' : '';
			
			var today_class = d.status === 'TODAY' ? 'today-col' : '';
			var status_badge = d.status ? `<span class="cf-pill ${d.status === 'TODAY' ? 'due-future' : 'overdue'}" style="font-size: 8px; padding: 1px 4px; margin-left: 6px;">${d.status}</span>` : '';
			
			var col = $(`
				<div class="cf-timeline-column ${today_class}" data-col-key="${d.key}">
					<div class="cf-column-header">
						<div class="cf-flex cf-flex-align">
							<span class="cf-column-title" style="font-size: 11px;">${d.label}</span>
							${status_badge}
						</div>
						<div class="cf-column-net ${net_class}">${net_sign}₹${(net_flow/100000).toFixed(2)}L</div>
						<div class="cf-column-flows">
							<span>▲ ₹${(rec_flow/100000).toFixed(2)}L</span>
							<span>▼ ₹${(pay_flow/100000).toFixed(2)}L</span>
						</div>
						<div class="cf-column-balance">Σ ₹${(running_cash/100000).toFixed(2)}L</div>
					</div>
					<div class="cf-column-body"></div>
				</div>
			`);
			
			// Populate items
			var col_all = col_payables.concat(col_receivables);
			if (d.status === 'TODAY' || d.key === '2026-06-03') {
				var discounted = this.receivables.filter(i => i.priority && me.schedules[i.name]);
				col_all = col_all.concat(discounted);
			}
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				var blk = this.create_block_item_element(g, type);
				$body.append(blk);
			});
			
			$container.append(col);
		});
	}

	navigate_timeline(direction) {
		if (this.planner_level === 'month') {
			this.current_year += direction;
			this.wrapper.find('#planner-year-select').val(this.current_year);
		} else if (this.planner_level === 'week') {
			this.current_month += direction;
			if (this.current_month < 0) {
				this.current_month = 11;
				this.current_year--;
			} else if (this.current_month > 11) {
				this.current_month = 0;
				this.current_year++;
			}
			this.wrapper.find('#planner-year-select').val(this.current_year);
		} else {
			// Day level
			this.current_week += direction;
			if (this.current_week < 0) {
				this.current_week = 4;
				this.current_month--;
				if (this.current_month < 0) {
					this.current_month = 11;
					this.current_year--;
				}
			} else if (this.current_week > 4) {
				this.current_week = 0;
				this.current_month++;
				if (this.current_month > 11) {
					this.current_month = 0;
					this.current_year++;
				}
			}
			this.wrapper.find('#planner-year-select').val(this.current_year);
		}
		this.render_planner();
	}

	prompt_click_schedule(inv_id) {
		var me = this;
		var options = [];
		
		if (this.planner_level === 'month') {
			options = [
				{ value: '2026-06', label: 'Schedule to Jun' },
				{ value: '2026-07', label: 'Schedule to Jul' },
				{ value: '2026-08', label: 'Schedule to Aug' },
				{ value: '2026-09', label: 'Schedule to Sep' }
			];
		} else if (this.planner_level === 'week') {
			options = [
				{ value: '2026-W23', label: 'Schedule to Week 1' },
				{ value: '2026-W24', label: 'Schedule to Week 2' },
				{ value: '2026-W25', label: 'Schedule to Week 3' },
				{ value: '2026-W26', label: 'Schedule to Week 4' },
				{ value: '2026-W27', label: 'Schedule to Week 5' }
			];
		} else {
			options = [
				{ value: '2026-06-01', label: 'Mon, Jun 1' },
				{ value: '2026-06-02', label: 'Tue, Jun 2' },
				{ value: '2026-06-03', label: 'Wed, Jun 3' },
				{ value: '2026-06-04', label: 'Thu, Jun 4' },
				{ value: '2026-06-05', label: 'Fri, Jun 5' }
			];
			
			if (this.current_week > 0) {
				var start_day_offset = this.current_week * 7;
				options = options.map((opt, idx) => {
					var base_d = new Date('2026-06-01');
					base_d.setDate(base_d.getDate() + start_day_offset + idx);
					var date_str = base_d.toISOString().split('T')[0];
					var label = `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][idx]}, Jun ${base_d.getDate()}`;
					return { value: date_str, label: label };
				});
			}
		}
		
		options.push({ value: 'unscheduled', label: 'Unschedule / Move back to sidebar' });
		options.push({ value: 'later', label: 'Schedule to Later Weeks' });

		var dialog = new frappe.ui.Dialog({
			title: 'Plan Cash Execution',
			fields: [
				{
					label: 'Select execution target',
					fieldname: 'target_period',
					fieldtype: 'Select',
					options: options.map(o => ({ value: o.value, label: o.label })),
					default: me.schedules[inv_id] || 'unscheduled'
				}
			],
			primary_action_label: 'Apply schedule',
			primary_action(values) {
				var val = values.target_period;
				if (val === 'unscheduled') {
					delete me.schedules[inv_id];
				} else {
					me.schedules[inv_id] = val;
				}
				me.recalculate_cash_flow();
				me.render_planner();
				dialog.hide();
			}
		});
		
		dialog.show();
	}
}
