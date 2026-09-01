'use strict';

/* ==========================================================================
   The deal workspace: financials, subject property, mortgage requests, AML.

   Every screen here reads and writes real records. After any edit the server
   returns freshly computed metrics in the same response, and the metric bar
   at the top of the page repaints — so a broker changing a liability sees
   TDS move immediately rather than wondering whether it saved.
   ========================================================================== */

/** Shared per-file deal state, so a tab switch does not refetch needlessly. */
const DEAL = { fileId: null, data: null, borrower: 'all', requestId: null, amlData: null };

// ------------------------------------------------------------------ formatting

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

function fmtMoneyExact(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value);
}

const FREQUENCY_LABEL = {
  monthly: 'Monthly',
  semi_monthly: 'Semi-monthly',
  biweekly: 'Bi-weekly',
  accelerated_biweekly: 'Accelerated bi-weekly',
  weekly: 'Weekly',
  accelerated_weekly: 'Accelerated weekly',
};

const KIND_LABEL = (value) => String(value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// ------------------------------------------------------------------ metric bar

/**
 * The six numbers that answer "where is this file, and does it qualify?".
 *
 * GDS and TDS are shown STRESS-TESTED, because that is the test a lender
 * applies; the contract-rate equivalents are in the tooltip. Showing the
 * friendlier contract number as the headline would be flattering and wrong.
 */
function metricBar(file, m, options = {}) {
  if (!m) return null;
  const collapsed = localStorage.getItem('deal_head_collapsed') === '1';

  const tile = (key, value, extra, status, title) => el('div', { class: `metric ${status || ''}`, title: title || '' },
    el('div', { class: 'k' }, key),
    el('div', { class: 'v' }, value),
    extra ? el('div', { class: 'x' }, extra) : null);

  const bar = el('div', { class: 'metric-bar' },
    tile('GDS', fmtPct(m.ratios.gds, 1), `limit ${m.ratios.gds_limit}%`, m.ratios.gds_status,
      `Gross debt service at the qualifying rate of ${fmtPct(m.mortgage.qualifying_rate)}. At the contract rate it is ${fmtPct(m.ratios.contract_gds, 1)}.`),
    tile('TDS', fmtPct(m.ratios.tds, 1), `limit ${m.ratios.tds_limit}%`, m.ratios.tds_status,
      `Total debt service at the qualifying rate. At the contract rate it is ${fmtPct(m.ratios.contract_tds, 1)}.`),
    tile('LTV', fmtPct(m.ratios.ltv, 1), m.insurance.required ? 'insurance needed' : 'conventional', m.ratios.ltv_status,
      'Loan to value against the appraised value, or the estimate/purchase price when no appraisal is on file.'),
    tile('Net worth', fmtMoney(m.net_worth), `${m.assets.count} asset${m.assets.count === 1 ? '' : 's'}`, m.net_worth >= 0 ? '' : 'over'),
    tile('Payment', m.mortgage.payment ? fmtMoney(m.mortgage.payment) : '—',
      m.mortgage.payment ? FREQUENCY_LABEL[m.mortgage.payment_frequency] : 'no mortgage request', ''),
    tile('Income', fmtMoney(m.income.gross_monthly), 'gross monthly', ''));

  const head = el('div', { class: `deal-head ${collapsed ? 'collapsed' : ''}` },
    el('div', { class: 'deal-head-top' },
      el('h1', null, file.client_name),
      options.stage || null,
      el('span', { class: 'pill outline mono' }, file.file_number),
      file.status && file.status !== 'active' ? el('span', { class: 'pill bad' }, file.status) : null,
      file.closing_date ? el('span', { class: 'pill' }, `Closing ${fmtDate(file.closing_date)}`) : null,
      el('div', { class: 'spacer' }),
      options.actions || null,
      el('button', {
        class: 'deal-head-toggle',
        'aria-expanded': collapsed ? 'false' : 'true',
        onclick: (e) => {
          const wrap = e.target.closest('.deal-head');
          const nowCollapsed = !wrap.classList.contains('collapsed');
          wrap.classList.toggle('collapsed', nowCollapsed);
          localStorage.setItem('deal_head_collapsed', nowCollapsed ? '1' : '0');
          e.target.textContent = nowCollapsed ? 'Show figures' : 'Hide figures';
          e.target.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        },
      }, collapsed ? 'Show figures' : 'Hide figures')),
    bar);

  return head;
}

/** Repaint the metric bar in place after an edit, without a full re-render. */
function refreshMetricBar(m) {
  if (DEAL.data) DEAL.data.metrics = m;
  const existing = document.querySelector('.deal-head');
  if (!existing || !window.CURRENT_FILE) return;
  const replacement = metricBar(window.CURRENT_FILE, m, window.CURRENT_HEAD_OPTIONS || {});
  if (replacement) existing.replaceWith(replacement);
}

/** A ratio against its guideline, drawn so the guideline is visible. */
function ratioMeter(label, value, limit, status, note) {
  const pct = value === null ? 0 : Math.min(100, (value / Math.max(limit * 1.6, 1)) * 100);
  const limitPct = Math.min(100, (limit / Math.max(limit * 1.6, 1)) * 100);
  return el('div', { class: 'meter' },
    el('div', { class: 'meter-head' },
      el('span', { class: 'k' }, label),
      note ? el('span', { class: 'faint' }, note) : null,
      el('span', { class: `v ${status === 'over' ? 'bad' : ''}`, style: status === 'over' ? 'color:var(--bad)' : status === 'near' ? 'color:var(--warn)' : '' }, fmtPct(value, 1))),
    el('div', { class: 'meter-track' },
      el('div', { class: `meter-fill ${status}`, style: `width:${pct}%` }),
      el('div', { class: 'meter-limit', style: `left:${limitPct}%`, title: `Guideline ${limit}%` })));
}

// ------------------------------------------------------------------ loading

async function loadDeal(fileId, { force = false } = {}) {
  if (!force && DEAL.fileId === fileId && DEAL.data) return DEAL.data;
  DEAL.fileId = fileId;
  DEAL.data = await api.get(`/api/broker/files/${fileId}/deal`);
  if (!DEAL.requestId && DEAL.data.mortgage_requests.length) {
    const primary = DEAL.data.mortgage_requests.find((r) => r.is_primary === 1) || DEAL.data.mortgage_requests[0];
    DEAL.requestId = primary.id;
  }
  return DEAL.data;
}

function dealPermissionNotice(body, what) {
  clearNode(body);
  body.append(el('div', { class: 'card empty' },
    el('div', { class: 'big' }, '🔒'),
    el('h3', null, 'Not available to your role'),
    el('p', null, `Viewing ${what} needs a permission your role does not have. An administrator can grant it under Settings → Team.`)));
}

// ==================================================================
// Financials tab
// ==================================================================

async function renderFileFinancials(body, file) {
  clearNode(body);
  body.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:220px' })));
  let data;
  try {
    data = await loadDeal(file.id, { force: true });
  } catch (err) {
    if (err.status === 403) return dealPermissionNotice(body, 'a client’s financial position');
    clearNode(body);
    body.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }

  const section = localStorage.getItem('fin_section') || 'summary';
  const setSection = (key) => { localStorage.setItem('fin_section', key); renderFileFinancials(body, file); };

  const nav = el('div', { class: 'quick-nav' },
    [['summary', 'Qualification'], ['income', `Income (${data.incomes.length})`],
     ['assets', `Assets (${data.assets.length})`], ['liabilities', `Liabilities (${data.liabilities.length})`],
     ['credit', 'Credit']].map(([key, label]) =>
      el('button', { class: section === key ? 'active' : '', onclick: () => setSection(key) }, label)));

  const panel = el('div');
  const renderers = {
    summary: () => finSummary(panel, data),
    income: () => finIncome(panel, file, data),
    assets: () => finAssets(panel, file, data),
    liabilities: () => finLiabilities(panel, file, data),
    credit: () => finCredit(panel, file, data),
  };
  (renderers[section] || renderers.summary)();

  clearNode(body);
  body.append(el('div', { class: 'split' }, nav, panel));
}

function finSummary(panel, data) {
  const m = data.metrics;
  clearNode(panel);

  const warnings = m.warnings.length
    ? el('div', null, m.warnings.map((w) => el('div', { class: 'notice warn' }, el('span', { class: 'ic' }, '!'), el('div', null, w))))
    : el('div', { class: 'notice good' }, el('span', { class: 'ic' }, '✓'),
        el('div', null, 'Everything the ratios need is on file and both are inside the guidelines.'));

  const money = (k, v, note) => el('div', { class: 'fact' },
    el('div', { class: 'k' }, k), el('div', { class: 'v num' }, v), note ? el('div', { class: 'faint' }, note) : null);

  mount(panel,
    warnings,
    el('div', { class: 'card' },
      el('div', { class: 'card-title' },
        el('h3', null, 'Debt service'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'pill' }, `Qualifying rate ${fmtPct(m.mortgage.qualifying_rate)}`)),
      el('p', { class: 'faint' },
        `Judged at the qualifying rate, as a lender does. Your brokerage’s policy is the greater of the contract rate plus ${m.policy.buffer_pct}% and a ${m.policy.floor_rate}% floor.`),
      ratioMeter('Gross debt service (GDS)', m.ratios.gds, m.ratios.gds_limit, m.ratios.gds_status,
        `contract rate: ${fmtPct(m.ratios.contract_gds, 1)}`),
      ratioMeter('Total debt service (TDS)', m.ratios.tds, m.ratios.tds_limit, m.ratios.tds_status,
        `contract rate: ${fmtPct(m.ratios.contract_tds, 1)}`),
      m.ratios.ltv !== null
        ? ratioMeter('Loan to value (LTV)', m.ratios.ltv, 80, m.ratios.ltv_status, m.insurance.required ? 'above 80% — default insurance applies' : 'conventional')
        : null),

    el('div', { class: 'card' },
      el('h3', null, 'How the ratios are built'),
      el('div', { class: 'facts' },
        money('Gross monthly income', fmtMoney(m.income.gross_monthly),
          m.income.excluded_monthly ? `${fmtMoney(m.income.excluded_monthly)} excluded from qualification` : `${m.income.sources} source${m.income.sources === 1 ? '' : 's'}`),
        money('Mortgage payment (monthly equivalent)', fmtMoney(m.mortgage.payment_monthly_equivalent)),
        money('At the qualifying rate', fmtMoney(m.mortgage.qualifying_payment_monthly)),
        money('Property taxes', fmtMoney(m.property.taxes_monthly), 'monthly'),
        money('Heat', fmtMoney(m.property.heat_monthly), 'monthly'),
        money('Condo fees counted', fmtMoney(m.property.condo_fees_counted),
          m.property.condo_fees_monthly ? `half of ${fmtMoney(m.property.condo_fees_monthly)}` : 'none on file'),
        money('Other monthly debts', fmtMoney(m.debts.monthly_payments),
          m.debts.excluded ? `${m.debts.excluded} excluded` : `${m.debts.counted} counted`),
        m.property.rental_applied
          ? money('Rental income recognised', fmtMoney(m.property.rental_applied), m.property.rental_treatment === 'add' ? 'added to income' : 'offset against costs')
          : null)),

    el('div', { class: 'card' },
      el('h3', null, 'Balance sheet'),
      el('div', { class: 'facts' },
        money('Total assets', fmtMoney(m.assets.total)),
        money('Total liabilities', fmtMoney(m.debts.total_balance)),
        money('Net worth', fmtMoney(m.net_worth)),
        money('Down payment identified', fmtMoney(m.assets.down_payment_identified)))),

    m.insurance.required
      ? el('div', { class: 'card' },
          el('h3', null, 'Default insurance'),
          el('p', { class: 'muted' },
            `LTV is above 80%, so the mortgage needs default insurance. At ${fmtPct(m.ratios.ltv, 1)} the standard premium band is ${m.insurance.suggested_premium_rate}% — about ${fmtMoney(m.insurance.suggested_premium)}.`),
          el('p', { class: 'faint' },
            m.insurance.recorded_premium
              ? `The mortgage request records ${fmtMoney(m.insurance.recorded_premium)}. Programme rules vary by insurer, so the recorded figure is what counts.`
              : 'No premium has been recorded on the mortgage request yet. The figure above is a guide, not a quote.'))
      : null);
}

/** A small editable table with an add row — the shape every list below uses. */
function editableList({ title, help, rows, columns, onAdd, onEdit, onDelete, emptyIcon, emptyTitle, emptyText, canEdit, total }) {
  const table = rows.length
    ? el('div', { class: 'table-wrap' }, el('table', { class: 'data stackable' },
        el('thead', null, el('tr', null,
          columns.map((c) => el('th', { class: c.num ? 'num' : '' }, c.label)),
          canEdit ? el('th', null, '') : null)),
        el('tbody', null, rows.map((row) => el('tr', null,
          columns.map((c) => el('td', { class: c.num ? 'num' : '', 'data-label': c.label }, c.render(row))),
          canEdit ? el('td', { class: 'nowrap' },
            el('button', { class: 'btn sm ghost', onclick: () => onEdit(row) }, 'Edit'),
            el('button', { class: 'btn sm ghost', style: 'color:var(--bad)', onclick: () => onDelete(row) }, 'Remove')) : null)))))
    : el('div', { class: 'empty' },
        el('div', { class: 'big' }, emptyIcon),
        el('h3', null, emptyTitle),
        el('p', null, emptyText),
        canEdit ? el('button', { class: 'btn', onclick: onAdd }, '+ Add the first one') : null);

  return el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, title),
      el('div', { class: 'spacer' }),
      total !== undefined && rows.length ? el('span', { class: 'pill brand mono' }, total) : null,
      canEdit && rows.length ? el('button', { class: 'btn sm subtle', onclick: onAdd }, '+ Add') : null),
    help ? el('p', { class: 'faint' }, help) : null,
    table);
}

// ---- Income ----

function finIncome(panel, file, data) {
  clearNode(panel);
  const applicantName = (id) => {
    const a = data.applicants.find((x) => x.id === id);
    return a ? a.name : '—';
  };
  panel.append(editableList({
    title: 'Income',
    help: 'Only sources marked as qualifying feed GDS and TDS. Keep variable or unrecognised income on file but excluded, so the ratios match what a lender will compute.',
    rows: data.incomes,
    canEdit: data.can_edit,
    total: fmtMoney(data.metrics.income.gross_monthly) + ' / mo',
    columns: [
      { label: 'Applicant', render: (r) => applicantName(r.applicant_id) },
      { label: 'Type', render: (r) => KIND_LABEL(r.kind) },
      { label: 'Source', render: (r) => r.employer || r.description || '—' },
      { label: 'Amount', num: true, render: (r) => fmtMoneyExact(r.amount) },
      { label: 'Period', render: (r) => KIND_LABEL(r.period) },
      { label: 'Qualifies', render: (r) => (r.qualifies === 1 ? el('span', { class: 'pill good' }, 'Yes') : el('span', { class: 'pill' }, 'Excluded')) },
    ],
    emptyIcon: '💼', emptyTitle: 'No income recorded',
    emptyText: 'GDS and TDS cannot be calculated until at least one qualifying income source is on file.',
    onAdd: () => incomeModal(file, data, null),
    onEdit: (row) => incomeModal(file, data, row),
    onDelete: async (row) => {
      if (!(await confirmDialog('Remove this income source? The ratios will recalculate.', { danger: true, confirmLabel: 'Remove' }))) return;
      const res = await api.del(`/api/broker/incomes/${row.id}`);
      toast('Income removed.', 'good');
      refreshMetricBar(res.metrics);
      renderFileFinancials(document.getElementById('file-tab-body'), file);
    },
  }));
}

function incomeModal(file, data, row) {
  const f = {
    applicant_id: el('select', null, data.applicants.map((a) =>
      el('option', { value: a.id, selected: row && row.applicant_id === a.id ? '' : undefined }, `${a.name} (${KIND_LABEL(a.role)})`))),
    kind: el('select', null, data.reference.income_kinds.map((k) =>
      el('option', { value: k, selected: row && row.kind === k ? '' : undefined }, KIND_LABEL(k)))),
    employer: el('input', { type: 'text', value: row ? row.employer : '', placeholder: 'Employer or source' }),
    job_title: el('input', { type: 'text', value: row ? row.job_title : '' }),
    amount: el('input', { type: 'number', step: '0.01', class: 'money', value: row ? row.amount : '' }),
    period: el('select', null, data.reference.income_periods.map((p) =>
      el('option', { value: p, selected: row && row.period === p ? '' : undefined }, KIND_LABEL(p)))),
    years_at_source: el('input', { type: 'number', step: '0.1', value: row && row.years_at_source !== null ? row.years_at_source : '' }),
    description: el('input', { type: 'text', value: row ? row.description : '' }),
  };
  const qualifies = el('input', { type: 'checkbox', checked: !row || row.qualifies === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  openModal(row ? 'Edit income' : 'Add income',
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Applicant'), f.applicant_id),
        el('label', { class: 'field' }, el('span', null, 'Type'), f.kind)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Employer / source'), f.employer),
        el('label', { class: 'field' }, el('span', null, 'Job title'), f.job_title)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Amount'), f.amount),
        el('label', { class: 'field' }, el('span', null, 'Per'), f.period),
        el('label', { class: 'field' }, el('span', null, 'Years at source'), f.years_at_source)),
      el('label', { class: 'field' }, el('span', null, 'Note'), f.description),
      el('label', { class: 'checkbox' }, qualifies,
        el('span', null, el('strong', null, 'Counts toward qualification.'),
          ' Turn this off for bonus or variable income a lender will not fully recognise — it stays on file but is left out of GDS and TDS.')),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            applicant_id: f.applicant_id.value, kind: f.kind.value, employer: f.employer.value,
            job_title: f.job_title.value, amount: f.amount.value, period: f.period.value,
            years_at_source: f.years_at_source.value, description: f.description.value,
            qualifies: qualifies.checked,
          };
          try {
            const res = row
              ? await api.patch(`/api/broker/incomes/${row.id}`, payload)
              : await api.post(`/api/broker/files/${file.id}/incomes`, payload);
            close();
            toast(row ? 'Income updated.' : 'Income added.', 'good');
            refreshMetricBar(res.metrics);
            renderFileFinancials(document.getElementById('file-tab-body'), file);
          } catch (err) {
            error.textContent = err.message;
            e.target.disabled = false;
          }
        },
      }, row ? 'Save' : 'Add'),
    ]);
}

// ---- Assets ----

function finAssets(panel, file, data) {
  clearNode(panel);
  const applicantName = (id) => {
    if (!id) return 'Joint / file';
    const a = data.applicants.find((x) => x.id === id);
    return a ? a.name : '—';
  };
  panel.append(editableList({
    title: 'Assets',
    help: 'Mark the portion of an asset that is being used as the down payment — that figure is what the down-payment verification documents have to support.',
    rows: data.assets,
    canEdit: data.can_edit,
    total: fmtMoney(data.metrics.assets.total),
    columns: [
      { label: 'Owner', render: (r) => applicantName(r.applicant_id) },
      { label: 'Type', render: (r) => KIND_LABEL(r.kind) },
      { label: 'Description', render: (r) => r.description || r.institution || '—' },
      { label: 'Value', num: true, render: (r) => fmtMoneyExact(r.value) },
      { label: 'To down payment', num: true, render: (r) => (r.down_payment_amount ? fmtMoneyExact(r.down_payment_amount) : '—') },
      { label: 'Verified', render: (r) => (r.verified === 1 ? el('span', { class: 'pill good' }, 'Verified') : el('span', { class: 'pill warn' }, 'Unverified')) },
    ],
    emptyIcon: '🏦', emptyTitle: 'No assets recorded',
    emptyText: 'Net worth and the down-payment picture are built from this list.',
    onAdd: () => assetModal(file, data, null),
    onEdit: (row) => assetModal(file, data, row),
    onDelete: async (row) => {
      if (!(await confirmDialog('Remove this asset?', { danger: true, confirmLabel: 'Remove' }))) return;
      const res = await api.del(`/api/broker/assets/${row.id}`);
      toast('Asset removed.', 'good');
      refreshMetricBar(res.metrics);
      renderFileFinancials(document.getElementById('file-tab-body'), file);
    },
  }));
}

function assetModal(file, data, row) {
  const f = {
    applicant_id: el('select', null,
      el('option', { value: '' }, 'Joint / whole file'),
      data.applicants.map((a) => el('option', { value: a.id, selected: row && row.applicant_id === a.id ? '' : undefined }, a.name))),
    kind: el('select', null, data.reference.asset_kinds.map((k) =>
      el('option', { value: k, selected: row && row.kind === k ? '' : undefined }, KIND_LABEL(k)))),
    institution: el('input', { type: 'text', value: row ? row.institution : '', placeholder: 'Bank or institution' }),
    description: el('input', { type: 'text', value: row ? row.description : '' }),
    value: el('input', { type: 'number', step: '0.01', class: 'money', value: row ? row.value : '' }),
    down_payment_amount: el('input', { type: 'number', step: '0.01', class: 'money', value: row && row.down_payment_amount !== null ? row.down_payment_amount : '' }),
  };
  const verified = el('input', { type: 'checkbox', checked: row && row.verified === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  openModal(row ? 'Edit asset' : 'Add asset',
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Owner'), f.applicant_id),
        el('label', { class: 'field' }, el('span', null, 'Type'), f.kind)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Institution'), f.institution),
        el('label', { class: 'field' }, el('span', null, 'Description'), f.description)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Value'), f.value),
        el('label', { class: 'field' }, el('span', null, 'Amount going to the down payment'), f.down_payment_amount)),
      el('label', { class: 'checkbox' }, verified, 'Supporting documentation has been seen and accepted'),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            applicant_id: f.applicant_id.value || null, kind: f.kind.value,
            institution: f.institution.value, description: f.description.value,
            value: f.value.value, down_payment_amount: f.down_payment_amount.value, verified: verified.checked,
          };
          try {
            const res = row
              ? await api.patch(`/api/broker/assets/${row.id}`, payload)
              : await api.post(`/api/broker/files/${file.id}/assets`, payload);
            close();
            toast(row ? 'Asset updated.' : 'Asset added.', 'good');
            refreshMetricBar(res.metrics);
            renderFileFinancials(document.getElementById('file-tab-body'), file);
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, row ? 'Save' : 'Add'),
    ]);
}

// ---- Liabilities ----

function finLiabilities(panel, file, data) {
  clearNode(panel);
  const applicantName = (id) => {
    if (!id) return 'Joint / file';
    const a = data.applicants.find((x) => x.id === id);
    return a ? a.name : '—';
  };
  panel.append(editableList({
    title: 'Liabilities',
    help: 'A debt marked "paid off at closing" stops counting toward TDS — which is the whole point of a consolidation refinance, and worth getting right before you tell a client whether it works.',
    rows: data.liabilities,
    canEdit: data.can_edit,
    total: `${fmtMoney(data.metrics.debts.monthly_payments)} / mo`,
    columns: [
      { label: 'Owner', render: (r) => applicantName(r.applicant_id) },
      { label: 'Type', render: (r) => KIND_LABEL(r.kind) },
      { label: 'Lender', render: (r) => r.lender || r.description || '—' },
      { label: 'Balance', num: true, render: (r) => fmtMoneyExact(r.balance) },
      { label: 'Payment', num: true, render: (r) => (r.monthly_payment ? fmtMoneyExact(r.monthly_payment) : '—') },
      {
        label: 'In TDS',
        render: (r) => (r.payoff_at_close === 1
          ? el('span', { class: 'pill info' }, 'Paid at closing')
          : r.include_in_tds === 1 ? el('span', { class: 'pill' }, 'Counted') : el('span', { class: 'pill warn' }, 'Excluded')),
      },
    ],
    emptyIcon: '💳', emptyTitle: 'No liabilities recorded',
    emptyText: 'Pull the credit report and record what is there — TDS is only meaningful once the debts are on file.',
    onAdd: () => liabilityModal(file, data, null),
    onEdit: (row) => liabilityModal(file, data, row),
    onDelete: async (row) => {
      if (!(await confirmDialog('Remove this liability?', { danger: true, confirmLabel: 'Remove' }))) return;
      const res = await api.del(`/api/broker/liabilities/${row.id}`);
      toast('Liability removed.', 'good');
      refreshMetricBar(res.metrics);
      renderFileFinancials(document.getElementById('file-tab-body'), file);
    },
  }));
}

function liabilityModal(file, data, row) {
  const f = {
    applicant_id: el('select', null,
      el('option', { value: '' }, 'Joint / whole file'),
      data.applicants.map((a) => el('option', { value: a.id, selected: row && row.applicant_id === a.id ? '' : undefined }, a.name))),
    kind: el('select', null, data.reference.liability_kinds.map((k) =>
      el('option', { value: k, selected: row && row.kind === k ? '' : undefined }, KIND_LABEL(k)))),
    lender: el('input', { type: 'text', value: row ? row.lender : '' }),
    description: el('input', { type: 'text', value: row ? row.description : '' }),
    credit_limit: el('input', { type: 'number', step: '0.01', class: 'money', value: row && row.credit_limit !== null ? row.credit_limit : '' }),
    balance: el('input', { type: 'number', step: '0.01', class: 'money', value: row ? row.balance : '' }),
    monthly_payment: el('input', { type: 'number', step: '0.01', class: 'money', value: row && row.monthly_payment !== null ? row.monthly_payment : '' }),
  };
  const fromBureau = el('input', { type: 'checkbox', checked: row && row.from_bureau === 1 ? '' : undefined });
  const includeInTds = el('input', { type: 'checkbox', checked: !row || row.include_in_tds === 1 ? '' : undefined });
  const payoff = el('input', { type: 'checkbox', checked: row && row.payoff_at_close === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  // A revolving balance with no stated payment is the classic TDS trap, so
  // the form offers the 3%-of-balance convention rather than leaving a zero.
  const suggest = el('button', {
    class: 'btn-link small', type: 'button',
    onclick: () => {
      const balance = Number(f.balance.value) || 0;
      if (!balance) { toast('Enter a balance first.', 'bad'); return; }
      f.monthly_payment.value = Math.round(balance * 0.03 * 100) / 100;
    },
  }, 'Use 3% of the balance');

  openModal(row ? 'Edit liability' : 'Add liability',
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Owner'), f.applicant_id),
        el('label', { class: 'field' }, el('span', null, 'Type'), f.kind)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Lender'), f.lender),
        el('label', { class: 'field' }, el('span', null, 'Description'), f.description)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Limit'), f.credit_limit),
        el('label', { class: 'field' }, el('span', null, 'Balance'), f.balance),
        el('label', { class: 'field' }, el('span', null, 'Monthly payment'), f.monthly_payment)),
      el('div', { style: 'margin:-8px 0 12px' }, suggest,
        el('span', { class: 'faint' }, ' — the usual treatment for a revolving balance with no fixed payment.')),
      el('label', { class: 'checkbox' }, fromBureau, 'Taken from the credit bureau report'),
      el('label', { class: 'checkbox' }, includeInTds, 'Counts toward TDS'),
      el('label', { class: 'checkbox' }, payoff, 'Being paid off at closing (removes it from TDS)'),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = {
            applicant_id: f.applicant_id.value || null, kind: f.kind.value, lender: f.lender.value,
            description: f.description.value, credit_limit: f.credit_limit.value, balance: f.balance.value,
            monthly_payment: f.monthly_payment.value, from_bureau: fromBureau.checked,
            include_in_tds: includeInTds.checked, payoff_at_close: payoff.checked,
          };
          try {
            const res = row
              ? await api.patch(`/api/broker/liabilities/${row.id}`, payload)
              : await api.post(`/api/broker/files/${file.id}/liabilities`, payload);
            close();
            toast(row ? 'Liability updated.' : 'Liability added.', 'good');
            refreshMetricBar(res.metrics);
            renderFileFinancials(document.getElementById('file-tab-body'), file);
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, row ? 'Save' : 'Add'),
    ]);
}

// ---- Credit ----

function finCredit(panel, file, data) {
  clearNode(panel);
  panel.append(el('div', { class: 'card' },
    el('h3', null, 'Credit'),
    el('p', { class: 'faint' }, 'Recorded per applicant. The lowest score on the file is what the product matcher screens against.'),
    el('ul', { class: 'list' }, data.applicants.map((a) => el('li', { class: 'row wrap' },
      el('div', { class: 'grow' },
        el('div', { style: 'font-weight:600' }, a.name),
        el('div', { class: 'faint' },
          a.credit_pulled_at ? `${a.credit_bureau || 'Bureau'} · pulled ${fmtDate(a.credit_pulled_at)}` : 'No credit pull recorded')),
      a.credit_score
        ? el('span', {
            class: `pill ${a.credit_score >= 680 ? 'good' : a.credit_score >= 600 ? 'warn' : 'bad'} mono`,
          }, String(a.credit_score))
        : el('span', { class: 'pill' }, 'No score'),
      data.can_edit ? el('button', { class: 'btn sm secondary', onclick: () => creditModal(file, a) }, 'Record') : null)))));
}

function creditModal(file, applicant) {
  const score = el('input', { type: 'number', min: '300', max: '900', class: 'money', value: applicant.credit_score || '' });
  const bureau = el('select', null, ['', 'Equifax', 'TransUnion'].map((b) =>
    el('option', { value: b, selected: applicant.credit_bureau === b ? '' : undefined }, b || 'Not recorded')));
  const pulled = el('input', { type: 'date', value: applicant.credit_pulled_at || '' });
  const error = el('p', { class: 'form-error' });
  openModal(`Credit — ${applicant.name}`,
    el('div', null,
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Score'), score),
        el('label', { class: 'field' }, el('span', null, 'Bureau'), bureau),
        el('label', { class: 'field' }, el('span', null, 'Pulled on'), pulled)),
      el('p', { class: 'faint' }, 'This is a record of the pull, not the report itself. The report belongs in the document checklist, where it is encrypted at rest.'),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch(`/api/broker/applicants/${applicant.id}/credit`, {
              credit_score: score.value, credit_bureau: bureau.value, credit_pulled_at: pulled.value,
            });
            close();
            toast('Credit details saved.', 'good');
            renderFileFinancials(document.getElementById('file-tab-body'), file);
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, 'Save'),
    ]);
}

// ==================================================================
// Subject property tab
// ==================================================================

async function renderFileProperty(body, file) {
  clearNode(body);
  body.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:260px' })));
  let data;
  try {
    data = await loadDeal(file.id, { force: true });
  } catch (err) {
    if (err.status === 403) return dealPermissionNotice(body, 'the subject property');
    clearNode(body);
    body.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }
  const p = data.property || {};
  const readOnly = !data.can_edit;

  const input = (key, type = 'text', extra = {}) =>
    el('input', { type, value: p[key] === null || p[key] === undefined ? '' : p[key], disabled: readOnly || undefined, ...extra });
  const select = (key, options) => el('select', { disabled: readOnly || undefined },
    options.map(([v, l]) => el('option', { value: v, selected: (p[key] || '') === v ? '' : undefined }, l)));

  const f = {
    city: input('city'),
    province: select('province', [['', 'Not set'], ...data.reference.provinces.map((x) => [x, x])]),
    postal_code: input('postal_code'),
    dwelling_type: select('dwelling_type', [['', 'Not set'], ['detached', 'Detached'], ['semi_detached', 'Semi-detached'], ['townhouse', 'Townhouse'], ['condo_apartment', 'Condo apartment'], ['duplex', 'Duplex'], ['multi_unit', 'Multi-unit'], ['mobile', 'Mobile / modular'], ['other', 'Other']]),
    tenure: select('tenure', [['', 'Not set'], ['freehold', 'Freehold'], ['condominium', 'Condominium'], ['leasehold', 'Leasehold'], ['co_op', 'Co-operative']]),
    occupancy: select('occupancy', [['', 'Not set'], ['owner_occupied', 'Owner occupied'], ['second_home', 'Second home'], ['rental', 'Rental / investment'], ['owner_occupied_rental', 'Owner occupied with rental unit']]),
    year_built: input('year_built', 'number'),
    units: input('units', 'number'),
    living_space_sqft: input('living_space_sqft', 'number'),
    heating_type: select('heating_type', [['', 'Not set'], ['forced_air_gas', 'Forced air — gas'], ['electric', 'Electric'], ['oil', 'Oil'], ['heat_pump', 'Heat pump'], ['baseboard', 'Baseboard'], ['other', 'Other']]),
    mls_number: input('mls_number'),
    legal_description: input('legal_description'),
    zoning: input('zoning'),
    annual_taxes: input('annual_taxes', 'number', { step: '0.01', class: 'money' }),
    tax_year: input('tax_year', 'number'),
    condo_fees_monthly: input('condo_fees_monthly', 'number', { step: '0.01', class: 'money' }),
    heating_monthly: input('heating_monthly', 'number', { step: '0.01', class: 'money' }),
    hydro_monthly: input('hydro_monthly', 'number', { step: '0.01', class: 'money' }),
    water_monthly: input('water_monthly', 'number', { step: '0.01', class: 'money' }),
    other_expenses_monthly: input('other_expenses_monthly', 'number', { step: '0.01', class: 'money' }),
    rental_income_monthly: input('rental_income_monthly', 'number', { step: '0.01', class: 'money' }),
    rental_offset_pct: input('rental_offset_pct', 'number', { step: '1', class: 'rate' }),
    rental_treatment: select('rental_treatment', [['offset', 'Offset against the property’s costs'], ['add', 'Add to gross income']]),
    estimated_value: input('estimated_value', 'number', { step: '0.01', class: 'money' }),
    appraisal_value: input('appraisal_value', 'number', { step: '0.01', class: 'money' }),
    appraisal_date: input('appraisal_date', 'date'),
  };
  const condoIncludesHeat = el('input', { type: 'checkbox', checked: p.condo_fees_include_heat === 1 ? '' : undefined, disabled: readOnly || undefined });
  const error = el('p', { class: 'form-error' });

  const save = el('button', { class: 'btn', disabled: readOnly || undefined }, 'Save property');
  save.addEventListener('click', async () => {
    save.disabled = true;
    error.textContent = '';
    const payload = Object.fromEntries(Object.entries(f).map(([k, node]) => [k, node.value]));
    payload.condo_fees_include_heat = condoIncludesHeat.checked;
    try {
      const res = await api.put(`/api/broker/files/${file.id}/property`, payload);
      DEAL.data.property = res.property;
      refreshMetricBar(res.metrics);
      toast('Property saved — the ratios have been recalculated.', 'good');
    } catch (err) { error.textContent = err.message; }
    save.disabled = false;
  });

  const section = localStorage.getItem('prop_section') || 'costs';
  const setSection = (key) => { localStorage.setItem('prop_section', key); renderFileProperty(body, file); };
  const nav = el('div', { class: 'quick-nav' },
    [['costs', 'Carrying costs'], ['value', 'Value'], ['physical', 'The property'], ['legal', 'Legal']].map(([key, label]) =>
      el('button', { class: section === key ? 'active' : '', onclick: () => setSection(key) }, label)));

  const panels = {
    costs: el('div', { class: 'card' },
      el('h3', null, 'Carrying costs'),
      el('div', { class: 'help-text' },
        el('strong', null, 'These are GDS inputs.'),
        ' Property tax, heat and half of the condo fees are added to the mortgage payment to produce gross debt service. Hydro, water and “other” are shown to you but stay out of the ratio, because that is what a lender computes.'),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Annual property taxes'), f.annual_taxes),
        el('label', { class: 'field' }, el('span', null, 'Tax year'), f.tax_year)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Condo fees (monthly)'), f.condo_fees_monthly),
        el('label', { class: 'field' }, el('span', null, 'Heat (monthly)'), f.heating_monthly)),
      el('label', { class: 'checkbox' }, condoIncludesHeat, 'Condo fees include heat (the heat line is then not counted twice)'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Hydro (monthly)'), f.hydro_monthly),
        el('label', { class: 'field' }, el('span', null, 'Water (monthly)'), f.water_monthly),
        el('label', { class: 'field' }, el('span', null, 'Other (monthly)'), f.other_expenses_monthly)),
      el('div', { class: 'section-title' }, 'Rental income'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Rent received (monthly)'), f.rental_income_monthly),
        el('label', { class: 'field' }, el('span', null, 'Recognised %'), f.rental_offset_pct),
        el('label', { class: 'field' }, el('span', null, 'Treatment'), f.rental_treatment)),
      el('p', { class: 'faint' }, 'Offset lowers the property’s own costs; add puts the recognised portion into gross income. Which one applies is a lender policy, so record what your lender uses.')),

    value: el('div', { class: 'card' },
      el('h3', null, 'Value'),
      el('p', { class: 'faint' }, 'LTV uses the appraised value when there is one, and falls back to the estimate or the purchase price.'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Estimated value'), f.estimated_value),
        el('label', { class: 'field' }, el('span', null, 'Appraised value'), f.appraisal_value),
        el('label', { class: 'field' }, el('span', null, 'Appraisal date'), f.appraisal_date))),

    physical: el('div', { class: 'card' },
      el('h3', null, 'The property'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'City'), f.city),
        el('label', { class: 'field' }, el('span', null, 'Province'), f.province),
        el('label', { class: 'field' }, el('span', null, 'Postal code'), f.postal_code)),
      el('p', { class: 'hint' }, 'Province drives which provincial compliance forms apply, and which lender products can be offered.'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Dwelling type'), f.dwelling_type),
        el('label', { class: 'field' }, el('span', null, 'Tenure'), f.tenure),
        el('label', { class: 'field' }, el('span', null, 'Occupancy'), f.occupancy)),
      el('div', { class: 'form-row cols-4' },
        el('label', { class: 'field' }, el('span', null, 'Year built'), f.year_built),
        el('label', { class: 'field' }, el('span', null, 'Units'), f.units),
        el('label', { class: 'field' }, el('span', null, 'Living space (sq ft)'), f.living_space_sqft),
        el('label', { class: 'field' }, el('span', null, 'Heating'), f.heating_type))),

    legal: el('div', { class: 'card' },
      el('h3', null, 'Legal'),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'MLS number'), f.mls_number),
        el('label', { class: 'field' }, el('span', null, 'Zoning'), f.zoning)),
      el('label', { class: 'field' }, el('span', null, 'Legal description'), f.legal_description)),
  };

  const right = el('div', null,
    el('div', { class: 'card tight row wrap' },
      el('span', { class: 'faint' }, file.property_address || 'No address recorded on the application'),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill' }, `Shelter cost ${fmtMoney(data.metrics.property.gds_shelter_excluding_mortgage)}/mo before the mortgage`)),
    panels[section] || panels.costs,
    error,
    readOnly ? el('p', { class: 'faint' }, 'You have read-only access to this client’s financial data.') : el('div', { class: 'row' }, el('div', { class: 'spacer' }), save));

  clearNode(body);
  body.append(el('div', { class: 'split' }, nav, right));
}

// ==================================================================
// Mortgage requests tab
// ==================================================================

async function renderFileMortgage(body, file) {
  clearNode(body);
  body.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:240px' })));
  let data;
  try {
    data = await loadDeal(file.id, { force: true });
  } catch (err) {
    if (err.status === 403) return dealPermissionNotice(body, 'mortgage details');
    clearNode(body);
    body.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }

  const requests = data.mortgage_requests;
  clearNode(body);

  if (!requests.length) {
    body.append(el('div', { class: 'card empty' },
      el('div', { class: 'big' }, '🏷'),
      el('h3', null, 'No mortgage request yet'),
      el('p', null, 'A mortgage request holds the rate, term and amortization this file is being priced at. Until there is one, the payment and the debt-service ratios cannot be calculated.'),
      data.can_edit ? el('button', { class: 'btn', onclick: () => mortgageRequestModal(file, data, null) }, 'Create the first mortgage request') : null));
    return;
  }

  if (!DEAL.requestId || !requests.some((r) => r.id === DEAL.requestId)) DEAL.requestId = requests[0].id;
  const current = requests.find((r) => r.id === DEAL.requestId);

  const switcher = el('div', { class: 'entity-switch' },
    requests.map((r) => el('button', {
      class: `entity-chip ${r.id === DEAL.requestId ? 'active' : ''}`,
      onclick: () => { DEAL.requestId = r.id; renderFileMortgage(body, file); },
    },
      r.label || `${KIND_LABEL(r.position)} mortgage`,
      el('span', { class: 'role' }, r.is_primary === 1 ? 'primary' : r.status))),
    data.can_edit ? el('button', { class: 'btn sm subtle', onclick: () => mortgageRequestModal(file, data, null) }, '+ Add') : null);

  body.append(switcher, mortgageRequestPanel(file, data, current));
}

/**
 * One mortgage request.
 *
 * The two calculators are shown as visually distinct panels with plain-
 * language headings — "what the client pays" against "what the lender
 * qualifies them at" — because near-identical field labels on two adjacent
 * rate boxes is exactly how the wrong number ends up on an application.
 */
function mortgageRequestPanel(file, data, r) {
  const m = data.metrics;
  const isPrimary = r.is_primary === 1;
  const showsMetrics = isPrimary;

  const fact = (k, v, cls) => el('div', { class: 'fact' }, el('div', { class: 'k' }, k), el('div', { class: `v ${cls || ''}` }, v));

  const contractPanel = el('div', { class: 'card', style: 'border-left:3px solid var(--brand)' },
    el('div', { class: 'card-title' },
      el('h3', null, 'What the client pays'),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill brand' }, 'Contract terms')),
    el('div', { class: 'facts' },
      fact('Rate', fmtPct(r.contract_rate), 'num'),
      fact('Type', KIND_LABEL(r.rate_type)),
      fact('Term', `${r.term_months} months`),
      fact('Amortization', `${Math.round(r.amortization_months / 12)} years`),
      fact('Frequency', FREQUENCY_LABEL[r.payment_frequency] || r.payment_frequency),
      fact('Compounding', r.compounding === 'monthly' ? 'Monthly' : 'Semi-annual'),
      showsMetrics ? fact('Payment', fmtMoneyExact(m.mortgage.payment), 'num') : null,
      showsMetrics ? fact('Monthly equivalent', fmtMoneyExact(m.mortgage.payment_monthly_equivalent), 'num') : null));

  const qualifyingPanel = el('div', { class: 'card', style: 'border-left:3px solid var(--warn)' },
    el('div', { class: 'card-title' },
      el('h3', null, 'What the lender qualifies them at'),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill warn' }, 'Stress test')),
    el('p', { class: 'faint' },
      r.qualifying_rate
        ? 'This request pins its own qualifying rate, so the brokerage policy is not applied.'
        : `Derived from your brokerage policy: the greater of the contract rate plus ${m.policy.buffer_pct}% and a ${m.policy.floor_rate}% floor.`),
    el('div', { class: 'facts' },
      fact('Qualifying rate', fmtPct(showsMetrics ? m.mortgage.qualifying_rate : (r.qualifying_rate || null)), 'num'),
      fact('Amortization used', `${Math.round((r.qualifying_amortization_months || r.amortization_months) / 12)} years`),
      showsMetrics ? fact('Monthly payment used', fmtMoneyExact(m.mortgage.qualifying_payment_monthly), 'num') : null,
      showsMetrics ? fact('GDS at this rate', fmtPct(m.ratios.gds, 1), 'num') : null,
      showsMetrics ? fact('TDS at this rate', fmtPct(m.ratios.tds, 1), 'num') : null));

  const structure = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, 'Structure'),
      el('div', { class: 'spacer' }),
      el('span', { class: `pill ${r.status === 'funded' ? 'good' : r.status === 'declined' ? 'bad' : r.status === 'submitted' ? 'info' : ''}` }, KIND_LABEL(r.status))),
    el('div', { class: 'facts' },
      fact('Position', KIND_LABEL(r.position)),
      fact('Purchase price', fmtMoney(r.purchase_price), 'num'),
      fact('Down payment', fmtMoney(r.down_payment), 'num'),
      fact('Principal', fmtMoney(r.principal), 'num'),
      fact('Insurance premium', r.insurance_premium ? fmtMoney(r.insurance_premium) : '—', 'num'),
      fact('Lender', r.lender_name_snapshot || '—'),
      fact('Product', r.product_name_snapshot || '—'),
      fact('Down payment source', r.down_payment_source || '—')),
    r.notes ? el('p', { class: 'muted', style: 'margin-top:12px' }, r.notes) : null);

  const actions = el('div', { class: 'row wrap' },
    data.can_edit ? el('button', { class: 'btn secondary', onclick: () => mortgageRequestModal(file, data, r) }, 'Edit') : null,
    can('lenders.view') ? el('button', { class: 'btn secondary', onclick: () => productMatchModal(file, r) }, '▩ Find products for this file') : null,
    data.can_edit && !isPrimary ? el('button', {
      class: 'btn secondary',
      onclick: async () => {
        const res = await api.patch(`/api/broker/mortgage-requests/${r.id}`, { is_primary: true });
        toast('Marked as the primary request — the file’s ratios now use it.', 'good');
        refreshMetricBar(res.metrics);
        renderFileMortgage(document.getElementById('file-tab-body'), file);
      },
    }, 'Make primary') : null,
    el('div', { class: 'spacer' }),
    data.can_edit ? el('button', {
      class: 'btn secondary', style: 'color:var(--bad)',
      onclick: async () => {
        if (!(await confirmDialog('Delete this mortgage request?', { danger: true, confirmLabel: 'Delete' }))) return;
        try {
          const res = await api.del(`/api/broker/mortgage-requests/${r.id}`);
          DEAL.requestId = null;
          toast('Mortgage request deleted.', 'good');
          refreshMetricBar(res.metrics);
          renderFileMortgage(document.getElementById('file-tab-body'), file);
        } catch (err) { toast(err.message, 'bad'); }
      },
    }, 'Delete') : null);

  return el('div', null,
    !isPrimary
      ? el('div', { class: 'notice' }, el('span', { class: 'ic' }, 'ℹ'),
          el('div', null, 'This is not the primary request, so the file’s headline ratios are calculated from a different one.'))
      : null,
    structure,
    el('div', { class: 'form-row cols-2', style: 'gap:16px' }, contractPanel, qualifyingPanel),
    actions);
}

function mortgageRequestModal(file, data, r) {
  const val = (key, fallback = '') => (r && r[key] !== null && r[key] !== undefined ? r[key] : fallback);
  const f = {
    label: el('input', { type: 'text', value: val('label'), placeholder: 'e.g. First mortgage — Example Prime' }),
    position: el('select', null, data.reference.positions.map((p) =>
      el('option', { value: p, selected: val('position', 'first') === p ? '' : undefined }, `${KIND_LABEL(p)} position`))),
    status: el('select', null, data.reference.request_statuses.map((s) =>
      el('option', { value: s, selected: val('status', 'draft') === s ? '' : undefined }, KIND_LABEL(s)))),
    purchase_price: el('input', { type: 'number', step: '0.01', class: 'money', value: val('purchase_price', file.purchase_price || '') }),
    down_payment: el('input', { type: 'number', step: '0.01', class: 'money', value: val('down_payment', file.down_payment || '') }),
    principal: el('input', { type: 'number', step: '0.01', class: 'money', value: val('principal', file.mortgage_amount || '') }),
    down_payment_source: el('select', null, [['', 'Not recorded'], ['savings', 'Own savings'], ['gift', 'Gift'], ['sale_proceeds', 'Proceeds of sale'], ['rrsp', 'RRSP / HBP'], ['borrowed', 'Borrowed'], ['other', 'Other']].map(([v, l]) =>
      el('option', { value: v, selected: val('down_payment_source') === v ? '' : undefined }, l))),
    insurance_premium: el('input', { type: 'number', step: '0.01', class: 'money', value: val('insurance_premium') }),
    contract_rate: el('input', { type: 'number', step: '0.01', class: 'rate', value: val('contract_rate') }),
    rate_type: el('select', null, data.reference.rate_types.map((t) =>
      el('option', { value: t, selected: val('rate_type', 'fixed') === t ? '' : undefined }, KIND_LABEL(t)))),
    term_months: el('input', { type: 'number', value: val('term_months', 60) }),
    amortization_months: el('input', { type: 'number', value: val('amortization_months', 300) }),
    payment_frequency: el('select', null, data.reference.payment_frequencies.map((p) =>
      el('option', { value: p, selected: val('payment_frequency', 'monthly') === p ? '' : undefined }, FREQUENCY_LABEL[p] || p))),
    compounding: el('select', null, [['semi_annual', 'Semi-annual (Canadian standard)'], ['monthly', 'Monthly']].map(([v, l]) =>
      el('option', { value: v, selected: val('compounding', 'semi_annual') === v ? '' : undefined }, l))),
    qualifying_rate: el('input', { type: 'number', step: '0.01', class: 'rate', value: val('qualifying_rate'), placeholder: 'leave blank to use policy' }),
    notes: el('textarea', { placeholder: 'Anything worth recording about this structure' }, val('notes')),
  };
  const error = el('p', { class: 'form-error' });
  const preview = el('div', { class: 'card sunken tight' });

  // Live payment preview. Uses the same server-side arithmetic the ratios do,
  // so what the broker quotes on the phone is what the file will say.
  const updatePreview = debounce(async () => {
    const principal = Number(f.principal.value) || 0;
    if (!principal || !Number(f.contract_rate.value)) {
      clearNode(preview);
      preview.append(el('span', { class: 'faint' }, 'Enter a principal and a rate to see the payment.'));
      return;
    }
    try {
      const q = new URLSearchParams({
        principal, rate: f.contract_rate.value, amortization_months: f.amortization_months.value,
        frequency: f.payment_frequency.value, compounding: f.compounding.value,
      });
      if (f.qualifying_rate.value) q.set('qualifying_rate', f.qualifying_rate.value);
      const res = await api.get(`/api/broker/calculator?${q}`);
      clearNode(preview);
      preview.append(
        el('div', { class: 'facts' },
          el('div', { class: 'fact' }, el('div', { class: 'k' }, 'Payment'), el('div', { class: 'v num' }, fmtMoneyExact(res.contract.payment))),
          el('div', { class: 'fact' }, el('div', { class: 'k' }, 'Monthly equivalent'), el('div', { class: 'v num' }, fmtMoneyExact(res.contract.payment_monthly_equivalent))),
          el('div', { class: 'fact' }, el('div', { class: 'k' }, `Qualifying (${fmtPct(res.qualifying.rate)})`), el('div', { class: 'v num' }, fmtMoneyExact(res.qualifying.payment_monthly)))));
    } catch { /* preview only */ }
  }, 300);
  for (const key of ['principal', 'contract_rate', 'amortization_months', 'payment_frequency', 'compounding', 'qualifying_rate']) {
    f[key].addEventListener('input', updatePreview);
    f[key].addEventListener('change', updatePreview);
  }

  // Principal follows price minus down payment until the broker types over it.
  const syncPrincipal = () => {
    const price = Number(f.purchase_price.value);
    const down = Number(f.down_payment.value);
    if (price > 0 && down >= 0 && !f.principal.dataset.touched) {
      f.principal.value = Math.max(0, price - down);
      updatePreview();
    }
  };
  f.purchase_price.addEventListener('input', syncPrincipal);
  f.down_payment.addEventListener('input', syncPrincipal);
  f.principal.addEventListener('input', () => { f.principal.dataset.touched = '1'; });

  openModal(r ? 'Edit mortgage request' : 'New mortgage request',
    el('div', null,
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Label'), f.label),
        el('label', { class: 'field' }, el('span', null, 'Position'), f.position),
        el('label', { class: 'field' }, el('span', null, 'Status'), f.status)),
      el('div', { class: 'section-title' }, 'Amount'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Purchase price'), f.purchase_price),
        el('label', { class: 'field' }, el('span', null, 'Down payment'), f.down_payment),
        el('label', { class: 'field' }, el('span', null, 'Principal'), f.principal)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Down payment source'), f.down_payment_source),
        el('label', { class: 'field' }, el('span', null, 'Insurance premium'), f.insurance_premium)),
      el('div', { class: 'section-title' }, 'Contract terms — what the client pays'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Rate %'), f.contract_rate),
        el('label', { class: 'field' }, el('span', null, 'Rate type'), f.rate_type),
        el('label', { class: 'field' }, el('span', null, 'Term (months)'), f.term_months)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Amortization (months)'), f.amortization_months),
        el('label', { class: 'field' }, el('span', null, 'Payment frequency'), f.payment_frequency),
        el('label', { class: 'field' }, el('span', null, 'Compounding'), f.compounding)),
      el('div', { class: 'section-title' }, 'Stress test — what the lender qualifies at'),
      el('label', { class: 'field' }, el('span', null, 'Qualifying rate % (blank uses brokerage policy)'), f.qualifying_rate),
      preview,
      el('label', { class: 'field', style: 'margin-top:14px' }, el('span', null, 'Notes'), f.notes),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = Object.fromEntries(Object.entries(f).map(([k, node]) => [k, node.value]));
          try {
            const res = r
              ? await api.patch(`/api/broker/mortgage-requests/${r.id}`, payload)
              : await api.post(`/api/broker/files/${file.id}/mortgage-requests`, payload);
            close();
            if (!r && res.id) DEAL.requestId = res.id;
            toast(r ? 'Mortgage request saved.' : 'Mortgage request created.', 'good');
            refreshMetricBar(res.metrics);
            renderFileMortgage(document.getElementById('file-tab-body'), file);
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, r ? 'Save' : 'Create'),
    ]);
  updatePreview();
}

// ==================================================================
// AML / FINTRAC tab
// ==================================================================

async function renderFileAml(body, file) {
  clearNode(body);
  body.append(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:280px' })));
  let data;
  try {
    data = await api.get(`/api/broker/files/${file.id}/aml`);
  } catch (err) {
    if (err.status === 403) return dealPermissionNotice(body, 'the AML compliance record');
    clearNode(body);
    body.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }
  DEAL.amlData = data;
  const s = data.summary;

  const riskPill = el('span', {
    class: `pill ${s.risk_level === 'high' ? 'bad' : s.risk_level === 'medium' ? 'warn' : s.risk_level === 'low' ? 'good' : ''}`,
  }, `${KIND_LABEL(s.risk_level)} risk`);

  const header = el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, 'FINTRAC compliance'),
      el('div', { class: 'spacer' }),
      riskPill,
      el('span', { class: `pill ${s.complete ? 'good' : 'warn'}` }, s.complete ? 'Complete' : 'Incomplete')),
    el('p', { class: 'faint' },
      'The risk level is derived from the answers below every time this page loads. There is no editable risk field — a rating that can be typed over is not a rating.'),
    s.outstanding.length
      ? el('div', null,
          el('div', { class: 'section-title' }, `Outstanding (${s.outstanding.length})`),
          el('ul', { class: 'list' }, s.outstanding.map((gap) => el('li', { class: 'row top' },
            el('span', { style: 'color:var(--warn)' }, '•'), el('span', null, gap)))))
      : el('div', { class: 'notice good' }, el('span', { class: 'ic' }, '✓'),
          el('div', null, 'Every borrower is identified and screened, and every risk question is answered.')),
    s.drivers && s.drivers.length
      ? el('div', null,
          el('div', { class: 'section-title' }, 'What is driving the rating'),
          el('div', { class: 'row wrap' }, s.drivers.map((d) => el('span', { class: 'pill warn' }, d))))
      : null);

  const section = localStorage.getItem('aml_section') || 'deal';
  const setSection = (key) => { localStorage.setItem('aml_section', key); renderFileAml(body, file); };
  const nav = el('div', { class: 'quick-nav' },
    [['deal', 'Deal risk'], ...data.borrowers.map((b) => [`b${b.applicant_id}`, b.name])].map(([key, label]) =>
      el('button', { class: section === key ? 'active' : '', onclick: () => setSection(key) }, label)));

  const panel = section.startsWith('b')
    ? amlBorrowerPanel(file, data, data.borrowers.find((b) => `b${b.applicant_id}` === section) || data.borrowers[0])
    : amlDealPanel(file, data);

  clearNode(body);
  body.append(header, el('div', { class: 'split' }, nav, panel || el('div')));
}

/** A yes/no/unanswered control. Unanswered is a real, visible state. */
function triState(name, value, disabled) {
  const wrap = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
  const current = value === true || value === 'yes' ? 'yes' : value === false || value === 'no' ? 'no' : '';
  for (const [key, label] of [['no', 'No'], ['yes', 'Yes']]) {
    wrap.append(el('button', {
      type: 'button', class: current === key ? 'active' : '', disabled: disabled || undefined,
      onclick: (e) => {
        if (disabled) return;
        [...wrap.children].forEach((c) => c.classList.remove('active'));
        e.target.classList.add('active');
        wrap.dataset.value = key;
      },
    }, label));
  }
  wrap.dataset.value = current;
  return wrap;
}

function amlDealPanel(file, data) {
  const answers = data.summary.answers || {};
  const controls = new Map();
  const canManage = data.can_manage;

  const sections = data.questions.map((section) => el('div', { class: 'card' },
    el('h3', null, section.section),
    el('ul', { class: 'list' }, section.items.map((item) => {
      const control = triState(item.label, answers[item.key], !canManage);
      controls.set(item.key, control);
      return el('li', { class: 'row top wrap' },
        el('div', { class: 'grow' }, item.label),
        control);
    }))));

  const thirdParty = el('textarea', { placeholder: 'Who is providing the funds, their relationship to the borrower, and how their identity was confirmed', disabled: !canManage || undefined }, answers.third_party_details || '');
  const beneficial = el('textarea', { placeholder: 'The natural persons who own or control 25% or more of the entity', disabled: !canManage || undefined }, answers.beneficial_owner_details || '');
  const notes = el('textarea', { placeholder: 'Anything else relevant to the assessment', disabled: !canManage || undefined }, answers.notes || '');
  const error = el('p', { class: 'form-error' });

  const save = el('button', { class: 'btn', disabled: !canManage || undefined }, 'Save assessment');
  save.addEventListener('click', async () => {
    save.disabled = true;
    error.textContent = '';
    const payload = { answers: { third_party_details: thirdParty.value, beneficial_owner_details: beneficial.value, notes: notes.value } };
    for (const [key, control] of controls) {
      if (control.dataset.value) payload.answers[key] = control.dataset.value === 'yes';
    }
    try {
      await api.put(`/api/broker/files/${file.id}/aml`, payload);
      toast('Assessment saved.', 'good');
      renderFileAml(document.getElementById('file-tab-body'), file);
    } catch (err) { error.textContent = err.message; save.disabled = false; }
  });

  return el('div', null,
    sections,
    el('div', { class: 'card' },
      el('h3', null, 'Determinations'),
      el('label', { class: 'field' }, el('span', null, 'Third party providing or gifting funds'), thirdParty),
      el('label', { class: 'field' }, el('span', null, 'Beneficial ownership of any entity borrower'), beneficial),
      el('label', { class: 'field' }, el('span', null, 'Notes'), notes)),
    error,
    canManage ? el('div', { class: 'row' }, el('div', { class: 'spacer' }), save)
      : el('p', { class: 'faint' }, 'You can read this record but not change it.'));
}

function amlBorrowerPanel(file, data, borrower) {
  if (!borrower) return null;
  const check = borrower.check || {};
  const canManage = data.can_manage;
  const controls = new Map();

  const questions = el('div', { class: 'card' },
    el('h3', null, 'Risk questions'),
    el('ul', { class: 'list' }, data.borrower_questions.map((q) => {
      const control = triState(q.label, (check.answers || {})[q.key], !canManage);
      controls.set(q.key, control);
      return el('li', { class: 'row top wrap' }, el('div', { class: 'grow' }, q.label), control);
    })));

  const idMethod = el('select', { disabled: !canManage || undefined },
    el('option', { value: '' }, 'Not recorded'),
    data.id_methods.map(([v, l]) => el('option', { value: v, selected: check.id_method === v ? '' : undefined }, l)));
  const idPrimary = el('input', { type: 'text', value: check.id_document_primary || '', placeholder: 'e.g. Ontario driver’s licence, expiry 2029-04', disabled: !canManage || undefined });
  const idSecondary = el('input', { type: 'text', value: check.id_document_secondary || '', placeholder: 'Second source, for the dual process method', disabled: !canManage || undefined });
  const idVerified = el('input', { type: 'checkbox', checked: check.id_verified_at ? '' : undefined, disabled: !canManage || undefined });

  const pepForeign = el('input', { type: 'checkbox', checked: check.pep_foreign === 1 ? '' : undefined, disabled: !canManage || undefined });
  const pepDomestic = el('input', { type: 'checkbox', checked: check.pep_domestic === 1 ? '' : undefined, disabled: !canManage || undefined });
  const pepHio = el('input', { type: 'checkbox', checked: check.pep_hio === 1 ? '' : undefined, disabled: !canManage || undefined });
  const pepRelationship = el('select', { disabled: !canManage || undefined },
    [['', 'Not applicable'], ['self', 'The borrower themselves'], ['family', 'A family member'], ['close_associate', 'A close associate']].map(([v, l]) =>
      el('option', { value: v, selected: (check.pep_relationship || '') === v ? '' : undefined }, l)));
  const pepDetails = el('textarea', { placeholder: 'Position held, jurisdiction, and how the source of funds was established', disabled: !canManage || undefined }, check.pep_details || '');

  const sanctionStatus = el('select', { disabled: !canManage || undefined },
    data.sanction_statuses.map((s) => el('option', { value: s, selected: (check.sanction_status || 'not_screened') === s ? '' : undefined }, KIND_LABEL(s))));
  const sourceBoxes = data.sanction_sources.map(([key, label]) => {
    const box = el('input', {
      type: 'checkbox', disabled: !canManage || undefined,
      checked: String(check.sanction_sources || '').split(',').includes(key) ? '' : undefined,
    });
    box.dataset.key = key;
    return el('label', { class: 'checkbox' }, box, label);
  });
  const sanctionNote = el('textarea', { placeholder: 'What was searched, and what came back', disabled: !canManage || undefined }, check.sanction_note || '');
  const error = el('p', { class: 'form-error' });

  const save = el('button', { class: 'btn', disabled: !canManage || undefined }, 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    error.textContent = '';
    const answers = {};
    for (const [key, control] of controls) {
      if (control.dataset.value) answers[key] = control.dataset.value === 'yes';
    }
    const payload = {
      answers,
      id_method: idMethod.value, id_document_primary: idPrimary.value, id_document_secondary: idSecondary.value,
      id_verified: idVerified.checked,
      pep_foreign: pepForeign.checked, pep_domestic: pepDomestic.checked, pep_hio: pepHio.checked,
      pep_relationship: pepRelationship.value, pep_details: pepDetails.value,
      sanction_status: sanctionStatus.value,
      sanction_sources: sourceBoxes.filter((l) => l.querySelector('input').checked).map((l) => l.querySelector('input').dataset.key),
      sanction_note: sanctionNote.value,
    };
    try {
      await api.put(`/api/broker/files/${file.id}/aml/borrowers/${borrower.applicant_id}`, payload);
      toast('Borrower record saved.', 'good');
      renderFileAml(document.getElementById('file-tab-body'), file);
    } catch (err) { error.textContent = err.message; save.disabled = false; }
  });

  return el('div', null,
    el('div', { class: 'card' },
      el('h3', null, 'Identity verification'),
      el('div', { class: 'help-text' },
        el('strong', null, 'Record the method, not just the outcome.'),
        ' FINTRAC asks which method was used and what was seen — a tick with no method behind it does not satisfy the obligation.'),
      el('label', { class: 'field' }, el('span', null, 'Method'), idMethod),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Primary document / source'), idPrimary),
        el('label', { class: 'field' }, el('span', null, 'Secondary document / source'), idSecondary)),
      el('label', { class: 'checkbox' }, idVerified, 'Identity has been verified'),
      check.id_verified_at ? el('p', { class: 'faint' }, `Verified ${fmtDateTime(check.id_verified_at)}.`) : null),

    el('div', { class: 'card' },
      el('h3', null, 'Politically exposed person declaration'),
      el('div', { class: 'help-text' },
        el('strong', null, 'This extends beyond the borrower.'),
        ' FINTRAC’s definition covers family members and close associates of a politically exposed person, so a plain “is this person a PEP?” under-reports. Tick the category, then say whose position it is.'),
      el('label', { class: 'checkbox' }, pepForeign, 'Foreign politically exposed person'),
      el('label', { class: 'checkbox' }, pepDomestic, 'Domestic politically exposed person'),
      el('label', { class: 'checkbox' }, pepHio, 'Head of an international organization'),
      el('label', { class: 'field' }, el('span', null, 'Whose position is it?'), pepRelationship),
      el('label', { class: 'field' }, el('span', null, 'Details'), pepDetails)),

    el('div', { class: 'card' },
      el('div', { class: 'card-title' },
        el('h3', null, 'Sanction screening'),
        el('div', { class: 'spacer' }),
        el('span', {
          class: `pill ${check.sanction_status === 'cleared' ? 'good' : check.sanction_status === 'rejected' ? 'bad' : check.sanction_status === 'match_review' ? 'warn' : ''}`,
        }, KIND_LABEL(check.sanction_status || 'not_screened'))),
      data.summary.screening_mode === 'manual'
        ? el('div', { class: 'notice' }, el('span', { class: 'ic' }, 'ℹ'),
            el('div', null, 'No automated screening provider is connected, so this records what a person actually checked. A stubbed green tick would look like a check that never happened, which is worse than no check at all.'))
        : el('div', { class: 'notice good' }, el('span', { class: 'ic' }, '✓'),
            el('div', null, `Screening runs through ${data.summary.screening_mode}.`)),
      el('label', { class: 'field' }, el('span', null, 'Result'), sanctionStatus),
      el('div', { class: 'field-label' }, 'Lists searched'),
      sourceBoxes,
      el('label', { class: 'field' }, el('span', null, 'Note'), sanctionNote),
      check.sanction_screened_at ? el('p', { class: 'faint' }, `Last recorded ${fmtDateTime(check.sanction_screened_at)}.`) : null),

    questions,
    error,
    canManage ? el('div', { class: 'row' }, el('div', { class: 'spacer' }), save) : null);
}
