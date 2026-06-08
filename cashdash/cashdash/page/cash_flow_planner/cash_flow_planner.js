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
		
		this.base_date = '2026-06-03';
		this.active_tab = 'payables'; // 'payables', 'receivables', 'side-by-side'
		
		this.payables_sort_keys = [{column: 'final_date', direction: 'asc'}];
		this.receivables_sort_keys = [{column: 'final_date', direction: 'asc'}];
		
		// Planner timeline levels
		this.planner_level = 'month'; // 'month', 'week', 'day'
		this.current_year = 2026;
		this.current_month = 5; // June (0-indexed)
		this.current_week = 0; // Week 1 (0-indexed)
		
		this.cc_limit = 60000000; // ₹6.00Cr
		this.bd_limit = 40000000; // ₹4.00Cr
		
		this.opening_balance = 80.00; // Lakhs
		this.horizon = '6 wks';
		this.schedules = {};
		this.notes = {};
		this.custom_amounts = {}; // Overridden outstanding values
		
		this.cc_utilization = 0;
		this.bd_utilization = 0;
		
		this.payables_sidebar_filter = { search: '', priority: false, high_value: false, overdue: false };
		this.receivables_sidebar_filter = { search: '', priority: false, high_value: false, overdue: false };
		
		this.init();
	}

	init() {
		this.page.main.html(frappe.render_template('cash_flow_planner', {}));
		this.bind_elements();
		this.bind_events();
		this.load_data();
	}

	bind_elements() {
		this.$ledger_container = this.wrapper.find('#cf-ledger-container');
		this.$planner_container = this.wrapper.find('#cf-planner-container');
		this.$single_view = this.wrapper.find('#cf-ledger-single-view');
		this.$split_view = this.wrapper.find('#cf-ledger-split-view');
		
		this.$input_opening = this.wrapper.find('#cf-opening-cash');
		this.$select_horizon = this.wrapper.find('#cf-horizon');
		
		this.$btn_save = this.wrapper.find('#cf-btn-save');
		this.$btn_merge = this.wrapper.find('#cf-btn-merge');
		this.$btn_plans = this.wrapper.find('#cf-btn-plans');
		this.$btn_export = this.wrapper.find('#cf-btn-export');
		this.$btn_reset = this.wrapper.find('#cf-btn-reset');
		
		this.$cc_gauge_text = this.wrapper.find('#cc-gauge-text');
		this.$cc_gauge_fill = this.wrapper.find('#cc-gauge-fill');
		this.$cc_gauge_subtext = this.wrapper.find('#cc-gauge-subtext');
		this.$bd_gauge_text = this.wrapper.find('#bd-gauge-text');
		this.$bd_gauge_fill = this.wrapper.find('#bd-gauge-fill');
		this.$bd_gauge_subtext = this.wrapper.find('#bd-gauge-subtext');
		
		this.$hdr_horizon_net = this.wrapper.find('#hdr-horizon-net');
		this.$hdr_lowest_cash = this.wrapper.find('#hdr-lowest-cash');
		this.$hdr_unscheduled_count = this.wrapper.find('#hdr-unscheduled-count');
		
		this.$review_modal = this.wrapper.find('#cf-review-modal');
	}

	bind_events() {
		var me = this;
		
		// Opening Cash & Horizon change listeners
		this.$input_opening.on('change', function() {
			me.opening_balance = parseFloat($(this).val()) || 0;
			me.recalculate_cash_flow();
			me.render_planner();
			me.render_ledger();
		});
		this.$select_horizon.on('change', function() {
			me.horizon = $(this).val();
			me.recalculate_cash_flow();
			me.render_planner();
			me.render_ledger();
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

		// Tab Switching inside Snapshot Ledger View
		this.wrapper.find('.cf-view-tab').on('click', function() {
			me.wrapper.find('.cf-view-tab').removeClass('active');
			$(this).addClass('active');
			me.active_tab = $(this).data('tab');
			me.render_ledger();
		});

		// Shift-Click Table Sorting (Snapshot Table)
		this.wrapper.find('#ledger-table th').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			me.handle_sort_click('single', col, e.shiftKey);
		});

		// Sort direction toggle badge in ledger
		this.wrapper.find('#ledger-btn-sort-dir').on('click', function() {
			var keys = me.active_tab === 'payables' ? me.payables_sort_keys : me.receivables_sort_keys;
			if (keys.length > 0) {
				keys[0].direction = keys[0].direction === 'asc' ? 'desc' : 'asc';
				me.render_ledger();
			}
		});

		// Overdue filter checkbox
		this.wrapper.find('#ledger-chk-overdue').on('change', function() { me.render_ledger(); });
		this.wrapper.find('#ledger-search-input').on('input', function() { me.render_ledger(); });
		this.wrapper.find('#ledger-group-select').on('change', function() { me.render_ledger(); });
		this.wrapper.find('#ledger-sort-select').on('change', function() {
			var col = $(this).val();
			me.handle_sort_click('single', col, false);
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

		// Sidebar Curtain collapse/expand handles
		this.wrapper.find('#cf-left-curtain-toggle').on('click', function(e) {
			e.stopPropagation();
			var sidebar = me.wrapper.find('#planner-drawer-payables');
			sidebar.toggleClass('collapsed');
			if (sidebar.hasClass('collapsed')) {
				$(this).text('›');
			} else {
				$(this).text('‹');
			}
		});

		this.wrapper.find('#cf-right-curtain-toggle').on('click', function(e) {
			e.stopPropagation();
			var sidebar = me.wrapper.find('#planner-drawer-receivables');
			sidebar.toggleClass('collapsed');
			if (sidebar.hasClass('collapsed')) {
				$(this).text('‹');
			} else {
				$(this).text('›');
			}
		});

		// Dynamic Plan Action Dropdown menu toggler
		this.wrapper.find('#cf-btn-plan-dropdown').on('click', function(e) {
			e.stopPropagation();
			me.wrapper.find('#cf-plan-menu').toggleClass('cf-hidden');
		});
		$(document).on('click', function() {
			me.wrapper.find('#cf-plan-menu').addClass('cf-hidden');
		});

		// Accordion header click delegates inside sidebars
		this.wrapper.find('#sidebar-parent-sched-pay-header').on('click', function() {
			me.wrapper.find('#sidebar-parent-sched-pay-body').toggleClass('cf-hidden');
		});
		this.wrapper.find('#sidebar-parent-sched-rec-header').on('click', function() {
			me.wrapper.find('#sidebar-parent-sched-rec-body').toggleClass('cf-hidden');
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

		// Card Amount Editing Listener (change)
		this.wrapper.on('change', '.cf-card-amount-input', function(e) {
			e.stopPropagation();
			var inv_id = $(this).data('invoice-id');
			var new_val_l = parseFloat($(this).val()) || 0;
			var new_outstanding = new_val_l * 100000;
			
			me.custom_amounts[inv_id] = new_outstanding;
			
			// Update in memory arrays
			var inv = me.all_payables.concat(me.all_receivables).find(i => i.name === inv_id);
			if (inv) {
				inv.outstanding = new_outstanding;
			}
			
			me.recalculate_cash_flow();
			me.render_planner();
			me.render_ledger();
		});

		// Modal Review Note Save
		this.wrapper.find('#modal-btn-save-note').on('click', function() {
			var note = me.wrapper.find('#modal-input-notes').val();
			var inv_id = me.active_note_invoice_id;
			me.notes[inv_id] = note;
			me.$review_modal.removeClass('show');
			
			var inv = me.all_payables.concat(me.all_receivables).find(i => i.name === inv_id);
			if (inv) inv.review_notes = note;
			
			me.render_planner();
			me.render_ledger();
		});
		this.wrapper.find('#modal-btn-close').on('click', function() {
			me.$review_modal.removeClass('show');
		});

		// Drag and drop event delegates for Planner timeline
		this.wrapper.on('dragstart', '.cf-block-item', function(e) {
			e.originalEvent.dataTransfer.setData('text/plain', $(this).data('invoice-id'));
		});

		this.wrapper.on('dragover', '.cf-column-body, #drawer-pay-body, #drawer-rec-body, #sidebar-parent-sched-pay-body, #sidebar-parent-sched-rec-body', function(e) {
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

		// Drag and drop back to parent accordions
		this.wrapper.on('drop', '#sidebar-parent-sched-pay-body, #sidebar-parent-sched-rec-body', function(e) {
			e.preventDefault();
			var inv_id = e.originalEvent.dataTransfer.getData('text/plain');
			if (inv_id) {
				// Move it back to the general parent schedule key
				var parent_key = '';
				if (me.planner_level === 'week') {
					parent_key = `${me.current_year}-${String(me.current_month + 1).padStart(2, '0')}`;
				} else if (me.planner_level === 'day') {
					parent_key = `${me.current_year}-W${23 + me.current_week}`;
				}
				if (parent_key) {
					me.schedules[inv_id] = parent_key;
					me.recalculate_cash_flow();
					me.render_planner();
				}
			}
		});
		
		// Clicking cards in timeline
		this.wrapper.on('click', '.cf-block-item', function(e) {
			// Stop if clicking input amount field
			if ($(e.target).hasClass('cf-card-amount-input')) {
				return;
			}
			
			// If clicking on star or clock icon
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
			
			// Otherwise trigger click-to-move schedule select field dialog
			var inv_id = $(this).data('invoice-id');
			me.prompt_click_schedule(inv_id);
		});

		// Bind breadcrumb click hyperlinks
		this.wrapper.on('click', '.cf-breadcrumb-link', function(e) {
			var lvl = $(this).data('level');
			me.planner_level = lvl;
			me.render_planner();
		});
	}

	load_data() {
		var me = this;
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
					me.opening_balance = config.opening_balance || 80.00;
					me.$input_opening.val(me.opening_balance);
					me.horizon = config.horizon || '6 wks';
					me.$select_horizon.val(me.horizon);
					
					me.schedules = config.schedules || {};
					me.notes = config.notes || {};
					me.custom_amounts = config.custom_amounts || {};
					
					me.recalculate_cash_flow();
					
					me.render_planner();
					me.render_ledger();
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
				scenario: 'Realistic',
				schedules: JSON.stringify(me.schedules),
				notes: JSON.stringify(me.notes),
				cc_utilization: me.cc_utilization,
				bd_utilization: me.bd_utilization,
				custom_amounts: JSON.stringify(me.custom_amounts)
			},
			callback: function(r) {
				if (r.message && r.message.status === 'success') {
					frappe.show_alert({message: __('Cash Flow plan saved'), indicator: 'green'});
				}
			}
		});
	}

	recalculate_cash_flow() {
		var me = this;
		
		// Apply custom amounts and map outputs
		this.payables = this.all_payables.map(inv => {
			var custom_val = me.custom_amounts[inv.name];
			var outstanding = (custom_val !== undefined) ? custom_val : inv.outstanding;
			return Object.assign({}, inv, { outstanding: outstanding, scaled_outstanding: outstanding });
		});

		this.receivables = this.all_receivables.map(inv => {
			var custom_val = me.custom_amounts[inv.name];
			var outstanding = (custom_val !== undefined) ? custom_val : inv.outstanding;
			return Object.assign({}, inv, { outstanding: outstanding, scaled_outstanding: outstanding });
		});

		// Compute metrics (CC/BD utilization, Lowest cash, Horizon Net)
		var bd_total = 0;
		this.receivables.forEach(inv => {
			if (inv.priority) {
				bd_total += inv.outstanding;
			}
		});
		this.bd_utilization = bd_total;
		
		var horizon_weeks = parseInt(this.horizon) || 6;
		var base_cash = this.opening_balance * 100000;
		var running_cash = base_cash;
		var lowest_cash = base_cash;
		
		var week_net_flows = Array(horizon_weeks).fill(0);
		
		// Process payables
		this.payables.forEach(inv => {
			var sched = me.schedules[inv.name];
			if (sched) {
				var wk_idx = me.get_week_index_from_schedule(sched);
				if (wk_idx >= 0 && wk_idx < horizon_weeks) {
					week_net_flows[wk_idx] -= inv.scaled_outstanding;
				}
			}
		});

		// Process receivables
		this.receivables.forEach(inv => {
			var sched = me.schedules[inv.name];
			if (sched) {
				var wk_idx = me.get_week_index_from_schedule(sched);
				if (wk_idx >= 0 && wk_idx < horizon_weeks) {
					if (inv.priority) {
						week_net_flows[0] += inv.scaled_outstanding;
					} else {
						week_net_flows[wk_idx] += inv.scaled_outstanding;
					}
				}
			}
		});

		var cumulative_lowest = base_cash;
		for (var i = 0; i < horizon_weeks; i++) {
			running_cash += week_net_flows[i];
			if (running_cash < cumulative_lowest) {
				cumulative_lowest = running_cash;
			}
		}

		var cc_draw = cumulative_lowest < 0 ? Math.abs(cumulative_lowest) : 0;
		this.cc_utilization = cc_draw;

		this.update_metrics_ui(running_cash, cumulative_lowest);
	}

	get_week_index_from_schedule(sched) {
		if (!sched || sched === 'later') return -1;
		if (sched.includes('-W')) {
			var parts = sched.split('-W');
			var w_num = parseInt(parts[1]) - 23;
			return w_num;
		} else if (sched.match(/^\d{4}-\d{2}-\d{2}$/)) {
			var dt = new Date(sched);
			var base_dt = new Date('2026-06-01');
			var diff_days = Math.floor((dt - base_dt) / (1000 * 60 * 60 * 24));
			return Math.floor(diff_days / 7);
		} else if (sched.match(/^\d{4}-\d{2}$/)) {
			var parts = sched.split('-');
			if (parts[1] === '06') return 2;
			return 5;
		}
		return -1;
	}

	update_metrics_ui(final_cash, lowest_cash) {
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
			this.wrapper.find('#lbl-net-verdict').text('Receivables cover payables.');
		} else {
			net_badge.css({ 'background': '#fee2e2', 'color': '#b91c1c' });
			this.wrapper.find('#lbl-net-verdict').text('Payables exceed receivables.');
		}

		// Update CC progress bar
		var cc_pct = Math.min(100, (this.cc_utilization / this.cc_limit) * 100);
		this.$cc_gauge_text.text(`₹${(this.cc_utilization/10000000).toFixed(2)}Cr / ₹${(this.cc_limit/10000000).toFixed(2)}Cr`);
		this.$cc_gauge_fill.css('width', `${cc_pct}%`);
		if (cc_pct > 90) {
			this.$cc_gauge_fill.removeClass('warning').addClass('danger');
			this.$cc_gauge_subtext.text('Limit Exceeded').css('color', '#dc2626');
		} else {
			this.$cc_gauge_fill.removeClass('danger warning');
			this.$cc_gauge_subtext.text('Within facility').css('color', '#6b7280');
		}

		// Update BD progress bar
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

		// Top stats updates
		var horizon_net_val = (final_cash / 10000000).toFixed(2);
		this.$hdr_horizon_net.text(`₹${horizon_net_val}Cr`);
		this.$hdr_horizon_net.css('color', final_cash < 0 ? '#dc2626' : '#16a34a');
		
		var lowest_cash_lakhs = (lowest_cash / 100000).toFixed(2);
		this.$hdr_lowest_cash.text(`₹${lowest_cash_lakhs}L`);
		this.$hdr_lowest_cash.css('color', lowest_cash < 0 ? '#dc2626' : '#16a34a');

		var unsched_cnt = 0;
		this.payables.forEach(i => { if (!this.schedules[i.name]) unsched_cnt++; });
		this.receivables.forEach(i => { if (!this.schedules[i.name]) unsched_cnt++; });
		this.$hdr_unscheduled_count.text(unsched_cnt);
	}

	auto_schedule_period(period_type, target_val) {
		var me = this;
		var count = 0;
		var all_items = this.payables.concat(this.receivables);
		
		all_items.forEach(inv => {
			if (!me.schedules[inv.name]) {
				var match = false;
				var final_dt_parts = inv.final_date.split('-'); // DD-MM-YYYY
				var d_day = final_dt_parts[0];
				var d_mo = final_dt_parts[1]; // e.g. "06"
				var d_yr = final_dt_parts[2]; // "2026"
				
				if (period_type === 'month') {
					if (d_mo === target_val && d_yr === String(me.current_year)) {
						match = true;
					}
				} else if (period_type === 'week') {
					var target_wk_idx = parseInt(target_val);
					var dt_str = `${d_yr}-${d_mo}-${d_day}`;
					var wk_idx = me.get_week_index_from_date_string(dt_str);
					if (wk_idx === target_wk_idx) {
						match = true;
					}
				} else if (period_type === 'year') {
					if (d_yr === target_val) {
						match = true;
					}
				}
				
				if (match) {
					// Plan onto exact contractual due date (YYYY-MM-DD)
					var formatted_date = `${d_yr}-${d_mo}-${d_day}`;
					me.schedules[inv.name] = formatted_date;
					count++;
				}
			}
		});
		
		frappe.show_alert({message: `Planned ${count} invoices onto contractual due dates.`, indicator: 'green'});
		this.recalculate_cash_flow();
		this.render_planner();
		this.render_ledger();
	}

	get_week_index_from_date_string(dt_str) {
		var dt = new Date(dt_str);
		var base_dt = new Date(`${this.current_year}-${String(this.current_month + 1).padStart(2, '0')}-01`);
		var diff_time = dt.getTime() - base_dt.getTime();
		var diff_days = Math.floor(diff_time / (1000 * 60 * 60 * 24));
		if (diff_days >= 0 && diff_days < 35) {
			return Math.floor(diff_days / 7);
		}
		return -1;
	}

	// ==================== PLANNER VIEW RENDER ====================
	render_planner() {
		this.render_planner_header();
		this.render_planner_sidebars();
		this.render_planner_timeline();
	}

	render_planner_header() {
		var me = this;
		var menu = this.wrapper.find('#cf-plan-menu').empty();
		
		// Add auto plan options
		menu.append(`<a class="cf-dropdown-item btn-auto-plan" data-type="year" data-val="${this.current_year}">Plan Year ${this.current_year}</a>`);
		
		if (this.planner_level === 'month') {
			var months = [
				{ key: '06', label: 'June' },
				{ key: '07', label: 'July' },
				{ key: '08', label: 'August' },
				{ key: '09', label: 'September' }
			];
			months.forEach(m => {
				menu.append(`<a class="cf-dropdown-item btn-auto-plan" data-type="month" data-val="${m.key}" style="border-top: 1px solid #f1f5f9;">Plan ${m.label}</a>`);
			});
			
			var path_html = `<span class="cf-breadcrumb-link" data-level="month">Calendar</span> · 4 columns`;
			this.wrapper.find('#planner-breadcrumb-path').html(path_html);
			this.wrapper.find('#planner-calendar-level-text').text('Calendar');
			this.wrapper.find('#cf-title-btn-back').addClass('cf-hidden');
		} else if (this.planner_level === 'week') {
			var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			var active_month_lbl = m_names[this.current_month];
			
			var m_key = String(this.current_month + 1).padStart(2, '0');
			menu.append(`<a class="cf-dropdown-item btn-auto-plan" data-type="month" data-val="${m_key}" style="border-top: 1px solid #f1f5f9;">Plan Month of ${active_month_lbl}</a>`);
			
			for (var i = 0; i < 5; i++) {
				menu.append(`<a class="cf-dropdown-item btn-auto-plan" data-type="week" data-val="${i}" style="border-top: 1px solid #f1f5f9;">Plan Week ${i+1}</a>`);
			}
			
			var path_html = `<span class="cf-breadcrumb-link" data-level="month">Calendar</span> > <span class="cf-breadcrumb-link" data-level="week">${active_month_lbl} ${this.current_year}</span>`;
			this.wrapper.find('#planner-breadcrumb-path').html(path_html);
			this.wrapper.find('#planner-calendar-level-text').text('Weeks');
			
			this.wrapper.find('#cf-title-btn-back').removeClass('cf-hidden').text('← Calendar').off('click').on('click', function() {
				me.planner_level = 'month';
				me.render_planner();
			});
		} else {
			var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			var active_month_lbl = m_names[this.current_month];
			
			menu.append(`<a class="cf-dropdown-item btn-auto-plan" data-type="week" data-val="${this.current_week}" style="border-top: 1px solid #f1f5f9;">Plan Week ${this.current_week+1}</a>`);
			
			var path_html = `<span class="cf-breadcrumb-link" data-level="month">Calendar</span> > <span class="cf-breadcrumb-link" data-level="week">${active_month_lbl} ${this.current_year}</span> > Week ${this.current_week + 1} drill-down`;
			this.wrapper.find('#planner-breadcrumb-path').html(path_html);
			this.wrapper.find('#planner-calendar-level-text').text('Days');
			
			this.wrapper.find('#cf-title-btn-back').removeClass('cf-hidden').text(`← ${active_month_lbl} ${this.current_year}`).off('click').on('click', function() {
				me.planner_level = 'week';
				me.render_planner();
			});
		}
		
		menu.find('.btn-auto-plan').on('click', function() {
			var type = $(this).data('type');
			var val = $(this).data('val');
			me.auto_schedule_period(type, String(val));
		});
	}

	render_planner_sidebars() {
		var me = this;
		
		// Filter unscheduled payables
		var pay_sidebar_data = this.payables.filter(item => {
			if (me.schedules[item.name]) return false;
			if (me.payables_sidebar_filter.search) {
				var s = me.payables_sidebar_filter.search.toLowerCase();
				if (!item.party.toLowerCase().includes(s) && !item.name.toLowerCase().includes(s)) return false;
			}
			if (me.payables_sidebar_filter.priority && !item.priority) return false;
			if (me.payables_sidebar_filter.high_value && item.scaled_outstanding < 100000) return false;
			if (me.payables_sidebar_filter.overdue && item.age_days <= 0) return false;
			return true;
		});

		var grouped_pay = this.group_invoices_by_party(pay_sidebar_data);
		var $pay_body = this.wrapper.find('#drawer-pay-body').empty();
		this.wrapper.find('#drawer-pay-count').text(pay_sidebar_data.length);
		
		if (grouped_pay.length === 0) {
			$pay_body.append(`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">No payables unscheduled.</div>`);
		} else {
			grouped_pay.forEach(g => {
				$pay_body.append(this.create_block_item_element(g, 'pay'));
			});
		}

		// Filter unscheduled receivables
		var rec_sidebar_data = this.receivables.filter(item => {
			if (me.schedules[item.name]) return false;
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
				$rec_body.append(this.create_block_item_element(g, 'rec'));
			});
		}

		// Populate scheduled for later totals
		var later_pay = this.payables.filter(item => me.schedules[item.name] === 'later');
		var later_pay_val = later_pay.reduce((a, b) => a + b.scaled_outstanding, 0);
		this.wrapper.find('#sidebar-later-pay-val').text(`${later_pay.length} · ₹${(later_pay_val/100000).toFixed(2)}L`);
		
		var later_rec = this.receivables.filter(item => me.schedules[item.name] === 'later');
		var later_rec_val = later_rec.reduce((a, b) => a + b.scaled_outstanding, 0);
		this.wrapper.find('#sidebar-later-rec-val').text(`${later_rec.length} · ₹${(later_rec_val/100000).toFixed(2)}L`);

		// Render Accordion sections if drilled down
		var parent_key = '';
		var parent_label = '';
		if (this.planner_level === 'week') {
			parent_key = `${this.current_year}-${String(this.current_month + 1).padStart(2, '0')}`;
			var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			parent_label = m_names[this.current_month];
		} else if (this.planner_level === 'day') {
			parent_key = `${this.current_year}-W${23 + this.current_week}`;
			parent_label = `Week ${this.current_week + 1}`;
		}

		if (parent_key) {
			this.wrapper.find('#sidebar-parent-sched-pay').removeClass('cf-hidden');
			this.wrapper.find('#sidebar-parent-sched-rec').removeClass('cf-hidden');
			this.wrapper.find('#sidebar-parent-sched-pay-title').text(`Scheduled generally to ${parent_label}`);
			this.wrapper.find('#sidebar-parent-sched-rec-title').text(`Scheduled generally to ${parent_label}`);
			
			var pay_parent = this.payables.filter(item => me.schedules[item.name] === parent_key);
			var pay_parent_total = pay_parent.reduce((a, b) => a + b.scaled_outstanding, 0);
			this.wrapper.find('#sidebar-parent-sched-pay-val').text(`${pay_parent.length} · ₹${(pay_parent_total/100000).toFixed(2)}L`);
			var grouped_parent_pay = this.group_invoices_by_party(pay_parent);
			var $parent_pay_body = this.wrapper.find('#sidebar-parent-sched-pay-body').empty();
			if (grouped_parent_pay.length === 0) {
				$parent_pay_body.append(`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 10px;">None scheduled.</div>`);
			} else {
				grouped_parent_pay.forEach(g => {
					$parent_pay_body.append(me.create_block_item_element(g, 'pay'));
				});
			}

			var rec_parent = this.receivables.filter(item => me.schedules[item.name] === parent_key);
			var rec_parent_total = rec_parent.reduce((a, b) => a + b.scaled_outstanding, 0);
			this.wrapper.find('#sidebar-parent-sched-rec-val').text(`${rec_parent.length} · ₹${(rec_parent_total/100000).toFixed(2)}L`);
			var grouped_parent_rec = this.group_invoices_by_party(rec_parent);
			var $parent_rec_body = this.wrapper.find('#sidebar-parent-sched-rec-body').empty();
			if (grouped_parent_rec.length === 0) {
				$parent_rec_body.append(`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 10px;">None scheduled.</div>`);
			} else {
				grouped_parent_rec.forEach(g => {
					$parent_rec_body.append(me.create_block_item_element(g, 'rec'));
				});
			}
		} else {
			this.wrapper.find('#sidebar-parent-sched-pay').addClass('cf-hidden');
			this.wrapper.find('#sidebar-parent-sched-rec').addClass('cf-hidden');
		}
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
		var me = this;
		var amount_l = (g.outstanding / 100000).toFixed(2);
		var badge_class = type === 'pay' ? 'pay' : 'rec';
		var badge_lbl = type === 'pay' ? 'PAY' : 'REC';
		
		var star_color = g.priority ? '#eab308' : '#cbd5e1';
		var clock_color = g.is_late ? '#f97316' : '#cbd5e1';
		
		var count_badge = g.count > 1 ? `<span class="cf-block-count">${g.count}</span>` : '';
		
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
		
		// If multiple invoices, return a simplified summary row card without input box, clock, or stars
		if (g.count > 1) {
			var item = $(`
				<div class="cf-block-item grouped-summary cf-type-${type}" draggable="true" data-invoice-id="${g.name}" id="blk-card-${g.party_id}">
					<div class="cf-block-header cf-flex-between">
						<div class="cf-flex cf-flex-align">
							${arrow_toggle}
							<span class="cf-block-badge ${badge_class}">${badge_lbl}</span>
							<span class="cf-block-party" style="margin-left: 6px; font-weight: bold;" title="${g.party}">${g.party}</span>
						</div>
						<div class="cf-flex cf-flex-align cf-gap-10">
							${count_badge}
							<span class="cf-block-amount" style="font-weight: 700; color: #1e3a8a;">₹${amount_l}L</span>
						</div>
					</div>
					${children_html}
				</div>
			`);
			
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

		// Single card with amount editable input box
		var amount_field = `<input type="number" step="0.01" class="cf-card-amount-input" data-invoice-id="${g.name}" value="${amount_l}">`;

		var item = $(`
			<div class="cf-block-item cf-type-${type}" draggable="true" data-invoice-id="${g.name}" id="blk-card-${g.party_id}">
				<div class="cf-block-header">
					<div class="cf-flex cf-flex-align">
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
						<span class="cf-block-amount">₹ ${amount_field} L</span>
					</div>
				</div>
			</div>
		`);
		
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
			var pay_flow = 0;
			var rec_flow = 0;
			
			var col_payables = this.payables.filter(i => me.schedules[i.name] === m.key || (me.schedules[i.name] && me.schedules[i.name].startsWith(m.key)));
			col_payables.forEach(i => pay_flow += i.scaled_outstanding);
			
			var col_receivables = this.receivables.filter(i => me.schedules[i.name] === m.key || (me.schedules[i.name] && me.schedules[i.name].startsWith(m.key)));
			col_receivables.forEach(i => {
				if (!i.priority) {
					rec_flow += i.scaled_outstanding;
				}
			});
			
			var net_flow = rec_flow - pay_flow;
			running_cash += net_flow;
			
			var net_class = net_flow < 0 ? 'negative' : 'positive';
			var net_sign = net_flow >= 0 ? '+' : '';
			
			var col = $(`
				<div class="cf-timeline-column cfp-level-macro" data-col-key="${m.key}">
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
					<div class="cf-column-body"></div>
					<div class="cf-drill-btn" id="drill-month-${m.label}">WEEKS →</div>
				</div>
			`);
			
			var col_all = col_payables.concat(col_receivables);
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				$body.append(me.create_block_item_element(g, type));
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
		var horizon_weeks = parseInt(this.horizon) || 6;

		weeks.forEach((w, idx) => {
			var pay_flow = 0;
			var rec_flow = 0;
			
			var col_payables = this.payables.filter(i => me.schedules[i.name] === w.key || (me.schedules[i.name] && me.schedules[i.name].startsWith(w.key)));
			col_payables.forEach(i => pay_flow += i.scaled_outstanding);
			
			var col_receivables = this.receivables.filter(i => me.schedules[i.name] === w.key || (me.schedules[i.name] && me.schedules[i.name].startsWith(w.key)));
			col_receivables.forEach(i => {
				if (!i.priority) {
					rec_flow += i.scaled_outstanding;
				}
			});
			
			if (idx === 0) {
				// Inject discounted receivables into Week 1
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

			// Horizon focus band vs dimmed future (first N weeks = horizon).
			// Only shade when a future portion actually exists to contrast against.
			var span_class = '';
			if (horizon_weeks < weeks.length) {
				span_class = idx < horizon_weeks ? 'cfp-col-horizon' : 'cfp-col-future';
				if (idx === horizon_weeks - 1) { span_class += ' cfp-col-horizon-end'; }
			}

			var col = $(`
				<div class="cf-timeline-column cfp-level-month ${span_class}" data-col-key="${w.key}">
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
			
			var col_all = col_payables.concat(col_receivables);
			if (idx === 0) {
				var discounted = this.receivables.filter(i => i.priority && me.schedules[i.name]);
				col_all = col_all.concat(discounted);
			}
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				$body.append(me.create_block_item_element(g, type));
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
		
		var days = [
			{ key: '2026-06-01', label: 'Mon, Jun 1', status: 'PAST' },
			{ key: '2026-06-02', label: 'Tue, Jun 2', status: 'PAST' },
			{ key: '2026-06-03', label: 'Wed, Jun 3', status: 'TODAY' },
			{ key: '2026-06-04', label: 'Thu, Jun 4', status: '' },
			{ key: '2026-06-05', label: 'Fri, Jun 5', status: '' }
		];

		var start_day_offset = this.current_week * 7;
		if (start_day_offset > 0) {
			days = days.map((d, idx) => {
				var base_d = new Date('2026-06-01');
				base_d.setDate(base_d.getDate() + start_day_offset + idx);
				var date_str = base_d.toISOString().split('T')[0];
				var m_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
				var label = `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][idx]}, ${m_names[base_d.getMonth()]} ${base_d.getDate()}`;
				return { key: date_str, label: label, status: '' };
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
				if (!i.priority) {
					rec_flow += i.scaled_outstanding;
				}
			});
			
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
			
			var today_class = d.status === 'TODAY' ? 'today-col' : (d.status === 'PAST' ? 'cfp-col-past' : '');
			var status_badge = d.status ? `<span class="cf-pill ${d.status === 'TODAY' ? 'due-future' : 'overdue'}" style="font-size: 8px; padding: 1px 4px; margin-left: 6px;">${d.status}</span>` : '';

			var col = $(`
				<div class="cf-timeline-column cfp-level-micro ${today_class}" data-col-key="${d.key}">
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
			
			var col_all = col_payables.concat(col_receivables);
			if (d.status === 'TODAY' || d.key === '2026-06-03') {
				var discounted = this.receivables.filter(i => i.priority && me.schedules[i.name]);
				col_all = col_all.concat(discounted);
			}
			var grouped = this.group_invoices_by_party(col_all);
			var $body = col.find('.cf-column-body');
			
			grouped.forEach(g => {
				var type = col_payables.some(x => x.party === g.party) ? 'pay' : 'rec';
				$body.append(me.create_block_item_element(g, type));
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
				me.render_ledger(); // update bottom list too
				dialog.hide();
			}
		});
		
		dialog.show();
	}

	// ==================== SNAPSHOT LEDGER VIEW RENDER ====================
	render_ledger() {
		var me = this;
		
		if (this.active_tab === 'side-by-side') {
			this.$single_view.addClass('cf-hidden');
			this.$split_view.removeClass('cf-hidden');
			this.render_ledger_split();
			return;
		}

		this.$split_view.addClass('cf-hidden');
		this.$single_view.removeClass('cf-hidden');
		
		var is_pay = this.active_tab === 'payables';
		var data = is_pay ? this.payables : this.receivables;

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
		
		var filtered = this.filter_ledger_data(data);
		var sorted = this.sort_ledger_data(filtered, is_pay);
		
		this.wrapper.find('#lbl-records-count').text(`${sorted.length} of ${data.length}`);
		this.render_sort_badges(is_pay);
		
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
				
			// Merged party + invoice reference reveal on hover
			var party_html = `
				<div class="cf-party-ref-container">
					<span class="cf-party-name"><strong>${row.party}</strong></span>
					<span class="cf-invoice-ref-sub">${row.name} (Ref: ${row.ref_no})</span>
				</div>
			`;
			
			// Merged dates cell: Final date bolded/larger, bill date below
			var date_html = `
				<div class="cf-date-cell">
					<span class="cf-date-final">${row.final_date}</span>
					<span class="cf-date-bill">${row.bill_date}</span>
				</div>
			`;
				
			var tr = $(`
				<tr>
					<td>${party_html}</td>
					<td>${date_html}</td>
					<td><span class="cf-pill term-pill">${row.credit_term}</span></td>
					<td>₹${row.value.toLocaleString('en-IN')}</td>
					<td style="font-weight: 700;">₹${row.outstanding.toLocaleString('en-IN')}</td>
					<td>${age_badge}</td>
					<td>
						<div class="cf-flex cf-gap-10 cf-flex-align">
							<button class="cf-btn btn-plan-invoice cf-btn-warning" data-inv="${row.name}" style="padding: 3px 8px; font-size: 11px;">Plan</button>
							<button class="cf-btn btn-review-note" data-inv="${row.name}" style="padding: 3px 8px; font-size: 11px;">Review</button>
						</div>
						${note_str}
					</td>
				</tr>
			`);
			$tbody.append(tr);
		});

		// Event bindings inside lists
		$tbody.find('.btn-review-note').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});
		$tbody.find('.btn-plan-invoice').on('click', function() {
			var inv_id = $(this).data('inv');
			me.prompt_click_schedule(inv_id);
		});
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
		if (view_type === 'split') {
			is_pay = this.active_tab === 'payables';
		}
		var keys = is_pay ? this.payables_sort_keys : this.receivables_sort_keys;
		var existing_idx = keys.findIndex(k => k.column === col);
		
		if (!is_shift) {
			if (existing_idx >= 0) {
				var current = keys[existing_idx];
				if (current.direction === 'asc') {
					current.direction = 'desc';
					keys.splice(0, keys.length, current);
				} else {
					keys.splice(0, keys.length);
				}
			} else {
				keys.splice(0, keys.length, { column: col, direction: 'asc' });
			}
		} else {
			if (existing_idx >= 0) {
				var current = keys[existing_idx];
				if (current.direction === 'asc') {
					current.direction = 'desc';
				} else {
					keys.splice(existing_idx, 1);
				}
			} else {
				keys.push({ column: col, direction: 'asc' });
			}
		}
		
		if (view_type === 'split') {
			this.render_ledger_split();
		} else {
			this.render_ledger();
		}
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
					me.render_ledger();
				}
			});
			$tag_container.append(tag);
		});
	}

	render_ledger_split() {
		var me = this;
		
		var pay_groups = Array.from(new Set(this.payables.map(i => i.party_group)));
		var rec_groups = Array.from(new Set(this.receivables.map(i => i.party_group)));
		
		var $pg = this.wrapper.find('#split-pay-group');
		$pg.empty().append('<option value="">All groups</option>');
		pay_groups.forEach(g => $pg.append(`<option value="${g}">${g}</option>`));
		
		var $rg = this.wrapper.find('#split-rec-group');
		$rg.empty().append('<option value="">All groups</option>');
		rec_groups.forEach(g => $rg.append(`<option value="${g}">${g}</option>`));

		// Render left table (Payables)
		var pay_search = this.wrapper.find('#split-pay-search').val() || '';
		var pay_grp = this.wrapper.find('#split-pay-group').val() || '';
		var f_pay = this.payables.filter(item => {
			if (pay_search && !item.party.toLowerCase().includes(pay_search.toLowerCase()) && !item.name.toLowerCase().includes(pay_search.toLowerCase())) return false;
			if (pay_grp && item.party_group !== pay_grp) return false;
			return true;
		});
		var s_pay = this.sort_ledger_data(f_pay, true);
		var $pay_body = this.wrapper.find('#split-pay-table-body').empty();
		
		s_pay.forEach(row => {
			var age_badge = row.age_days > 0 
				? `<span class="cf-pill overdue">Overdue ${row.age_days}d</span>`
				: `<span class="cf-pill due-future">Due in ${Math.abs(row.age_days)}d</span>`;
			var tr = $(`
				<tr>
					<td>
						<div class="cf-party-ref-container">
							<span class="cf-party-name"><strong>${row.party}</strong></span>
							<span class="cf-invoice-ref-sub">${row.name}</span>
						</div>
					</td>
					<td>
						<div class="cf-date-cell">
							<span class="cf-date-final">${row.final_date}</span>
							<span class="cf-date-bill">${row.bill_date}</span>
						</div>
					</td>
					<td>₹${row.outstanding.toLocaleString('en-IN')}</td>
					<td>${age_badge}</td>
					<td>
						<div class="cf-flex cf-gap-10 cf-flex-align">
							<button class="cf-btn btn-plan-invoice cf-btn-warning" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Plan</button>
							<button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button>
						</div>
					</td>
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
					<td>
						<div class="cf-party-ref-container">
							<span class="cf-party-name"><strong>${row.party}</strong></span>
							<span class="cf-invoice-ref-sub">${row.name}</span>
						</div>
					</td>
					<td>
						<div class="cf-date-cell">
							<span class="cf-date-final">${row.final_date}</span>
							<span class="cf-date-bill">${row.bill_date}</span>
						</div>
					</td>
					<td>₹${row.outstanding.toLocaleString('en-IN')}</td>
					<td>${age_badge}</td>
					<td>
						<div class="cf-flex cf-gap-10 cf-flex-align">
							<button class="cf-btn btn-plan-invoice cf-btn-warning" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Plan</button>
							<button class="cf-btn btn-split-review" data-inv="${row.name}" style="padding: 2px 6px; font-size: 10px;">Review</button>
						</div>
					</td>
				</tr>
			`);
			$rec_body.append(tr);
		});

		// Bind actions
		this.wrapper.find('.btn-split-review').off('click').on('click', function() {
			var inv_id = $(this).data('inv');
			me.open_review_modal(inv_id);
		});
		this.wrapper.find('.btn-plan-invoice').off('click').on('click', function() {
			var inv_id = $(this).data('inv');
			me.prompt_click_schedule(inv_id);
		});

		// Bind filters
		this.wrapper.find('#split-pay-search, #split-rec-search').off('input').on('input', function() { me.render_ledger_split(); });
		this.wrapper.find('#split-pay-group, #split-rec-group').off('change').on('change', function() { me.render_ledger_split(); });
		
		// Split pane table sorting delegates
		this.wrapper.find('#split-pay-table th, #split-rec-table th').off('click').on('click', function(e) {
			var col = $(this).data('col');
			if (!col) return;
			var pane_is_pay = $(this).closest('table').attr('id') === 'split-pay-table';
			
			me.active_tab = pane_is_pay ? 'payables' : 'receivables';
			me.handle_sort_click('split', col, e.shiftKey);
			me.active_tab = 'side-by-side';
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
}
