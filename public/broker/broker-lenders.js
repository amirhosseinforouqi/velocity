'use strict';

/* ==========================================================================
   Lender panel, product matching, relationship reports and automation.

   Rate shopping happens in context: the product matcher reads the file's own
   province, LTV, purpose and credit score rather than asking a broker to
   re-key what is already on the record, and it shows what was ruled OUT and
   why — a filtered list with no explanation just looks like a short list.
   ========================================================================== */

// ==================================================================
// Lender panel
// ==================================================================

async function renderLenders() {
  if (!can('lenders.view')) {
    setView(el('div', { class: 'card empty' },
      el('div', { class: 'big' }, '🔒'),
      el('h3', null, 'Not available to your role'),
      el('p', null, 'The lender panel needs the lenders.view permission.')));
    return;
  }
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:200px' })));
  const showAll = localStorage.getItem('lenders_all') === '1';
  const data = await api.get(`/api/broker/lenders${showAll ? '?all=1' : ''}`);

  const cards = data.lenders.map((lender) => el('div', { class: 'card' },
    el('div', { class: 'card-title' },
      el('h3', null, lender.name),
      el('span', { class: `pill ${lender.kind === 'prime' ? 'brand' : lender.kind === 'private' ? 'warn' : 'info'}` }, KIND_LABEL(lender.kind)),
      lender.active === 0 ? el('span', { class: 'pill' }, 'Inactive') : null,
      el('div', { class: 'spacer' }),
      data.can_manage ? el('button', { class: 'btn sm ghost', onclick: () => lenderModal(lender) }, 'Edit') : null,
      data.can_manage ? el('button', { class: 'btn sm subtle', onclick: () => productModal(lender, null) }, '+ Product') : null),
    lender.contact_name || lender.contact_email
      ? el('p', { class: 'faint' }, [lender.contact_name, lender.contact_email, lender.contact_phone].filter(Boolean).join(' · '))
      : null,
    lender.products.length === 0
      ? el('div', { class: 'empty', style: 'padding:18px' },
          el('p', { class: 'muted' }, 'No products on file for this lender yet.'),
          data.can_manage ? el('button', { class: 'btn sm', onclick: () => productModal(lender, null) }, 'Add a product') : null)
      : el('div', { class: 'table-wrap' }, el('table', { class: 'data stackable' },
          el('thead', null, el('tr', null,
            ['Product', 'Rate', 'Type', 'Term', 'Max amort', 'Max LTV', 'Min score', 'Provinces', ''].map((h, i) =>
              el('th', { class: i === 1 ? 'num' : '' }, h)))),
          el('tbody', null, lender.products.map((p) => el('tr', null,
            el('td', { 'data-label': 'Product' }, p.name, p.active === 0 ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'Retired') : null),
            el('td', { class: 'num', 'data-label': 'Rate' }, fmtPct(p.rate)),
            el('td', { 'data-label': 'Type' }, KIND_LABEL(p.rate_type)),
            el('td', { 'data-label': 'Term' }, `${p.term_months} mo`),
            el('td', { 'data-label': 'Max amort' }, `${Math.round(p.max_amortization_months / 12)} yr`),
            el('td', { 'data-label': 'Max LTV' }, p.max_ltv ? fmtPct(p.max_ltv, 0) : '—'),
            el('td', { 'data-label': 'Min score' }, p.min_credit_score || '—'),
            el('td', { 'data-label': 'Provinces' }, el('span', { class: 'faint' }, p.eligible_provinces || 'All')),
            el('td', { class: 'nowrap' },
              data.can_manage ? el('button', { class: 'btn sm ghost', onclick: () => productModal(lender, p) }, 'Edit') : null,
              data.can_manage && p.active === 1 ? el('button', {
                class: 'btn sm ghost', style: 'color:var(--bad)',
                onclick: async () => {
                  if (!(await confirmDialog('Retire this product? Files that already chose it keep their record — it just stops appearing for new ones.', { confirmLabel: 'Retire' }))) return;
                  await api.del(`/api/broker/products/${p.id}`);
                  toast('Product retired.', 'good');
                  renderLenders();
                },
              }, 'Retire') : null))))))));

  setView(
    el('div', { class: 'page-head' },
      el('div', { class: 'grow' },
        el('h1', null, 'Lender panel'),
        el('p', { class: 'sub' }, 'Your lenders and their products. Open a file’s mortgage tab to match products against that client’s actual numbers.')),
      el('label', { class: 'checkbox', style: 'margin:0' },
        el('input', {
          type: 'checkbox', checked: showAll ? '' : undefined,
          onchange: (e) => { localStorage.setItem('lenders_all', e.target.checked ? '1' : '0'); renderLenders(); },
        }), el('span', { class: 'small' }, 'Show retired')),
      data.can_manage ? el('button', { class: 'btn', onclick: () => lenderModal(null) }, '+ Add lender') : null),
    el('button', { class: 'btn secondary mb', onclick: () => calculatorModal() }, '🧮 Payment calculator'),
    data.lenders.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '▩'),
          el('h3', null, 'No lenders on your panel'),
          el('p', null, 'Add the lenders you actually place business with, and the products you quote. The file-level matcher then screens them against each client’s province, LTV and credit score.'),
          data.can_manage ? el('button', { class: 'btn', onclick: () => lenderModal(null) }, 'Add your first lender') : null)
      : el('div', null, cards));
}

function lenderModal(lender) {
  const f = {
    name: el('input', { type: 'text', value: lender ? lender.name : '' }),
    kind: el('select', null, [['prime', 'Prime'], ['alternative', 'Alternative / B'], ['private', 'Private']].map(([v, l]) =>
      el('option', { value: v, selected: lender && lender.kind === v ? '' : undefined }, l))),
    contact_name: el('input', { type: 'text', value: lender ? lender.contact_name : '' }),
    contact_email: el('input', { type: 'email', value: lender ? lender.contact_email : '' }),
    contact_phone: el('input', { type: 'tel', value: lender ? lender.contact_phone : '' }),
    portal_url: el('input', { type: 'text', value: lender ? lender.portal_url : '', placeholder: 'https://…' }),
    notes: el('textarea', null, lender ? lender.notes : ''),
  };
  const active = el('input', { type: 'checkbox', checked: !lender || lender.active === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  openModal(lender ? 'Edit lender' : 'Add lender',
    el('div', null,
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Name'), f.name),
        el('label', { class: 'field' }, el('span', null, 'Type'), f.kind)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Contact'), f.contact_name),
        el('label', { class: 'field' }, el('span', null, 'Email'), f.contact_email),
        el('label', { class: 'field' }, el('span', null, 'Phone'), f.contact_phone)),
      el('label', { class: 'field' }, el('span', null, 'Submission portal'), f.portal_url),
      el('label', { class: 'field' }, el('span', null, 'Notes'), f.notes),
      lender ? el('label', { class: 'checkbox' }, active, 'Active on the panel') : null,
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = Object.fromEntries(Object.entries(f).map(([k, node]) => [k, node.value]));
          if (lender) payload.active = active.checked;
          try {
            if (lender) await api.patch(`/api/broker/lenders/${lender.id}`, payload);
            else await api.post('/api/broker/lenders', payload);
            close();
            toast(lender ? 'Lender saved.' : 'Lender added.', 'good');
            renderLenders();
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, lender ? 'Save' : 'Add'),
    ]);
}

function productModal(lender, product) {
  const val = (k, d = '') => (product && product[k] !== null && product[k] !== undefined ? product[k] : d);
  const f = {
    name: el('input', { type: 'text', value: val('name'), placeholder: 'e.g. 5 Year Fixed — Standard' }),
    rate: el('input', { type: 'number', step: '0.01', class: 'rate', value: val('rate') }),
    rate_type: el('select', null, [['fixed', 'Fixed'], ['variable', 'Variable'], ['adjustable', 'Adjustable'], ['capped_variable', 'Capped variable']].map(([v, l]) =>
      el('option', { value: v, selected: val('rate_type', 'fixed') === v ? '' : undefined }, l))),
    term_months: el('input', { type: 'number', value: val('term_months', 60) }),
    max_amortization_months: el('input', { type: 'number', value: val('max_amortization_months', 300) }),
    compounding: el('select', null, [['semi_annual', 'Semi-annual'], ['monthly', 'Monthly']].map(([v, l]) =>
      el('option', { value: v, selected: val('compounding', 'semi_annual') === v ? '' : undefined }, l))),
    insurability: el('select', null, [['any', 'Any'], ['insured', 'Insured only'], ['insurable', 'Insurable'], ['uninsurable', 'Uninsurable']].map(([v, l]) =>
      el('option', { value: v, selected: val('insurability', 'any') === v ? '' : undefined }, l))),
    max_ltv: el('input', { type: 'number', step: '0.1', class: 'rate', value: val('max_ltv') }),
    min_credit_score: el('input', { type: 'number', value: val('min_credit_score') }),
    eligible_provinces: el('input', { type: 'text', value: val('eligible_provinces'), placeholder: 'ON,BC,AB — blank means everywhere' }),
    eligible_purposes: el('input', { type: 'text', value: val('eligible_purposes'), placeholder: 'purchase,refinance — blank means any' }),
    eligible_occupancy: el('input', { type: 'text', value: val('eligible_occupancy'), placeholder: 'owner_occupied,rental — blank means any' }),
    rate_hold_days: el('input', { type: 'number', value: val('rate_hold_days') }),
    finder_fee_bps: el('input', { type: 'number', value: val('finder_fee_bps'), placeholder: 'basis points' }),
    prepayment: el('input', { type: 'text', value: val('prepayment'), placeholder: 'e.g. 20/20' }),
    notes: el('textarea', null, val('notes')),
  };
  const active = el('input', { type: 'checkbox', checked: !product || product.active === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  openModal(product ? `Edit product — ${lender.name}` : `New product — ${lender.name}`,
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Product name'), f.name),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Rate %'), f.rate),
        el('label', { class: 'field' }, el('span', null, 'Rate type'), f.rate_type),
        el('label', { class: 'field' }, el('span', null, 'Term (months)'), f.term_months)),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Max amortization (months)'), f.max_amortization_months),
        el('label', { class: 'field' }, el('span', null, 'Compounding'), f.compounding),
        el('label', { class: 'field' }, el('span', null, 'Insurability'), f.insurability)),
      el('div', { class: 'section-title' }, 'Eligibility — what the matcher screens on'),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Maximum LTV %'), f.max_ltv),
        el('label', { class: 'field' }, el('span', null, 'Minimum credit score'), f.min_credit_score)),
      el('label', { class: 'field' }, el('span', null, 'Provinces'), f.eligible_provinces),
      el('label', { class: 'field' }, el('span', null, 'Application purposes'), f.eligible_purposes),
      el('label', { class: 'field' }, el('span', null, 'Occupancy'), f.eligible_occupancy),
      el('p', { class: 'hint' }, 'Comma-separated. An empty box means the product is not restricted on that dimension.'),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Rate hold (days)'), f.rate_hold_days),
        el('label', { class: 'field' }, el('span', null, 'Finder fee (bps)'), f.finder_fee_bps),
        el('label', { class: 'field' }, el('span', null, 'Prepayment'), f.prepayment)),
      el('label', { class: 'field' }, el('span', null, 'Notes'), f.notes),
      product ? el('label', { class: 'checkbox' }, active, 'Available for new files') : null,
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = Object.fromEntries(Object.entries(f).map(([k, node]) => [k, node.value]));
          if (product) payload.active = active.checked;
          try {
            if (product) await api.patch(`/api/broker/products/${product.id}`, payload);
            else await api.post(`/api/broker/lenders/${lender.id}/products`, payload);
            close();
            toast(product ? 'Product saved.' : 'Product added.', 'good');
            renderLenders();
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, product ? 'Save' : 'Add'),
    ]);
}

// ==================================================================
// Product matching, in the context of one file
// ==================================================================

async function productMatchModal(file, request) {
  const body = el('div', null, el('div', { class: 'skeleton', style: 'height:200px' }));
  const modal = openModal('Products for this file', body, (close) => [
    el('button', { class: 'btn secondary', onclick: close }, 'Close'),
  ]);
  document.querySelector('.modal-backdrop:last-of-type .modal')?.classList.add('wide');

  let data;
  try {
    data = await api.get(`/api/broker/files/${file.id}/products`);
  } catch (err) {
    clearNode(body);
    body.append(el('p', { class: 'form-error' }, err.message));
    return;
  }

  const c = data.criteria;
  const criteria = el('div', { class: 'card sunken tight' },
    el('div', { class: 'faint', style: 'margin-bottom:5px' }, 'Screened against this file — nothing was re-typed'),
    el('div', { class: 'row wrap' },
      el('span', { class: 'pill' }, `Province ${c.province || 'not set'}`),
      el('span', { class: 'pill' }, `LTV ${fmtPct(c.ltv, 1)}`),
      el('span', { class: 'pill' }, `Purpose ${c.purpose || 'any'}`),
      el('span', { class: 'pill' }, `Occupancy ${KIND_LABEL(c.occupancy) || 'not set'}`),
      el('span', { class: 'pill' }, `Lowest score ${c.lowest_credit_score || 'not recorded'}`),
      el('span', { class: 'pill mono' }, fmtMoney(c.principal))));

  const applyProduct = async (product) => {
    if (!request) { toast('Create a mortgage request first.', 'bad'); return; }
    if (!(await confirmDialog(
      `Set this mortgage request to ${product.lender_name} — ${product.name} at ${fmtPct(product.rate)}? The rate, term and compounding are copied onto the request, and the lender and product names are snapshotted so the file still says what was chosen today even if the catalog changes.`,
      { confirmLabel: 'Use this product' }
    ))) return;
    try {
      const res = await api.patch(`/api/broker/mortgage-requests/${request.id}`, { product_id: product.id });
      modal.close();
      toast('Product applied.', 'good');
      refreshMetricBar(res.metrics);
      renderFileMortgage(document.getElementById('file-tab-body'), file);
    } catch (err) { toast(err.message, 'bad'); }
  };

  const productRow = (p, excluded) => el('tr', null,
    el('td', { 'data-label': 'Lender' },
      el('div', { style: 'font-weight:600' }, p.lender_name),
      el('div', { class: 'faint' }, p.name)),
    el('td', { class: 'num', 'data-label': 'Rate' }, fmtPct(p.rate)),
    el('td', { 'data-label': 'Term' }, `${p.term_months} mo · ${KIND_LABEL(p.rate_type)}`),
    el('td', { class: 'num', 'data-label': 'Payment' }, p.estimated_payment ? fmtMoney(p.estimated_payment) : '—'),
    el('td', { 'data-label': excluded ? 'Ruled out because' : 'Hold' },
      excluded
        ? el('span', { class: 'faint' }, p.reasons.join('; '))
        : (p.rate_hold_days ? `${p.rate_hold_days} days` : '—')),
    el('td', null, excluded || !request ? null
      : el('button', { class: 'btn sm', onclick: () => applyProduct(p) }, 'Use')));

  clearNode(body);
  body.append(
    criteria,
    el('div', { class: 'section-title' }, `Eligible (${data.matched.length})`),
    data.matched.length === 0
      ? el('div', { class: 'empty', style: 'padding:20px' },
          el('div', { class: 'big' }, '▩'),
          el('h3', null, 'Nothing on your panel fits yet'),
          el('p', null, 'Either the file is missing the details the screen needs — province, LTV, credit score — or no product on your panel covers this scenario. The ruled-out list below says which.'))
      : el('div', { class: 'table-wrap' }, el('table', { class: 'data stackable' },
          el('thead', null, el('tr', null, ['Lender / product', 'Rate', 'Term', 'Est. payment', 'Rate hold', ''].map((h, i) => el('th', { class: i === 1 || i === 3 ? 'num' : '' }, h)))),
          el('tbody', null, data.matched.map((p) => productRow(p, false))))),
    data.excluded.length
      ? el('details', { style: 'margin-top:14px' },
          el('summary', { class: 'faint', style: 'cursor:pointer' }, `Ruled out (${data.excluded.length}) — and why`),
          el('div', { class: 'table-wrap', style: 'margin-top:8px' }, el('table', { class: 'data stackable' },
            el('thead', null, el('tr', null, ['Lender / product', 'Rate', 'Term', 'Est. payment', 'Ruled out because', ''].map((h, i) => el('th', { class: i === 1 || i === 3 ? 'num' : '' }, h)))),
            el('tbody', null, data.excluded.map((p) => productRow(p, true))))))
      : null);
}

// ==================================================================
// Standalone calculator
// ==================================================================

function calculatorModal() {
  const principal = el('input', { type: 'number', step: '1000', class: 'money', value: '600000' });
  const rate = el('input', { type: 'number', step: '0.01', class: 'rate', value: '4.29' });
  const amort = el('input', { type: 'number', value: '300' });
  const frequency = el('select', null, Object.entries(FREQUENCY_LABEL).map(([v, l]) =>
    el('option', { value: v }, l)));
  const out = el('div', { class: 'card sunken tight' });

  const run = debounce(async () => {
    try {
      const q = new URLSearchParams({
        principal: principal.value, rate: rate.value,
        amortization_months: amort.value, frequency: frequency.value,
      });
      const res = await api.get(`/api/broker/calculator?${q}`);
      clearNode(out);
      out.append(el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('div', { class: 'k' }, 'Payment'), el('div', { class: 'v num' }, fmtMoneyExact(res.contract.payment))),
        el('div', { class: 'fact' }, el('div', { class: 'k' }, 'Monthly equivalent'), el('div', { class: 'v num' }, fmtMoneyExact(res.contract.payment_monthly_equivalent))),
        el('div', { class: 'fact' }, el('div', { class: 'k' }, `Qualifying rate ${fmtPct(res.qualifying.rate)}`), el('div', { class: 'v num' }, fmtMoneyExact(res.qualifying.payment_monthly)))));
    } catch (err) { clearNode(out); out.append(el('span', { class: 'form-error' }, err.message)); }
  }, 250);
  [principal, rate, amort, frequency].forEach((node) => { node.addEventListener('input', run); node.addEventListener('change', run); });

  openModal('Payment calculator',
    el('div', null,
      el('p', { class: 'faint' }, 'Semi-annual compounding, the Canadian standard. Accelerated frequencies are the monthly payment split, which is why they shorten the amortization.'),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Principal'), principal),
        el('label', { class: 'field' }, el('span', null, 'Rate %'), rate)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Amortization (months)'), amort),
        el('label', { class: 'field' }, el('span', null, 'Frequency'), frequency)),
      out),
    (close) => [el('button', { class: 'btn secondary', onclick: close }, 'Close')]);
  run();
}

// ==================================================================
// Relationship reports
// ==================================================================

const RELATIONSHIP_REPORTS = [
  ['maturities', 'Maturities', 180, 'Funded mortgages coming up for renewal. Reach the client before the incumbent lender does.'],
  ['rate_expiries', 'Rate holds expiring', 120, 'Files with a rate hold running out. Re-price or extend before it lapses.'],
  ['closings', 'Upcoming closings', 45, 'Everything closing soon, so nothing is a surprise on the day.'],
  ['conditions_due', 'Conditions due', 30, 'Files where lender conditions have a deadline attached.'],
  ['birthdays', 'Birthdays', 30, 'A cheap, genuine touchpoint that keeps a book of business warm.'],
  ['anniversaries', 'Funding anniversaries', 30, 'A year on from funding — a natural moment to check in.'],
];

async function renderRelationshipReport(kind, days) {
  const meta = RELATIONSHIP_REPORTS.find(([k]) => k === kind) || RELATIONSHIP_REPORTS[0];
  const holder = el('div', null, el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:140px' })));
  const mine = localStorage.getItem('rel_mine') === '1';

  const paint = async () => {
    try {
      const res = await api.get(`/api/broker/reports/relationships?kind=${kind}&days=${days}${mine ? '&mine=1' : ''}`);
      clearNode(holder);
      if (!res.rows.length) {
        holder.append(el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '📆'),
          el('h3', null, `Nothing in the next ${res.days} days`),
          el('p', null, meta[3])));
        return;
      }
      const isPerson = kind === 'birthdays' || kind === 'anniversaries';
      holder.append(el('div', { class: 'card flush' },
        el('div', { class: 'table-wrap' }, el('table', { class: 'data stackable' },
          el('thead', null, el('tr', null,
            (isPerson ? ['Name', 'Date', 'Contact', 'File'] : ['Client', 'Date', 'Amount', 'Stage', 'Broker']).map((h) => el('th', null, h)))),
          el('tbody', null, res.rows.map((row) => el('tr', {
            class: 'clickable', onclick: () => goFile(row.file_id),
          },
            el('td', { 'data-label': isPerson ? 'Name' : 'Client' },
              el('div', { style: 'font-weight:600' }, isPerson ? `${row.first_name} ${row.last_name}` : (row.client_name || '(no applicant)')),
              el('div', { class: 'faint mono' }, row.file_number)),
            el('td', { 'data-label': 'Date' }, fmtDate(row.on_date)),
            isPerson
              ? el('td', { 'data-label': 'Contact' }, el('span', { class: 'faint' }, [row.email, row.phone].filter(Boolean).join(' · ') || '—'))
              : el('td', { class: 'num', 'data-label': 'Amount' }, fmtMoney(row.mortgage_amount)),
            isPerson
              ? el('td', { 'data-label': 'File' }, el('span', { class: 'pill' }, row.status))
              : el('td', { 'data-label': 'Stage' }, row.stage_name
                  ? el('span', { class: 'pill', style: `background:${row.stage_color}1a;color:${row.stage_color}` }, row.stage_name)
                  : el('span', { class: 'faint' }, '—')),
            isPerson ? null : el('td', { 'data-label': 'Broker' }, row.broker_name || '—'))))))));
    } catch (err) {
      clearNode(holder);
      holder.append(el('div', { class: 'card empty' }, el('p', null, err.message)));
    }
  };
  paint();
  return holder;
}

// ==================================================================
// Automation (workflow rules)
// ==================================================================

async function renderAutomation() {
  setView(el('div', { class: 'card' }, el('div', { class: 'skeleton', style: 'height:220px' })));
  let data;
  try {
    data = await api.get('/api/broker/workflows');
  } catch (err) {
    setView(el('div', { class: 'card empty' }, el('p', null, err.message)));
    return;
  }
  const canManage = can('settings.manage');
  const triggerLabel = (field) => (data.triggers.find(([k]) => k === field) || [field, field])[1];

  const rows = data.rules.map((rule) => el('tr', null,
    el('td', { 'data-label': 'Rule' },
      el('div', { style: 'font-weight:600' }, rule.name),
      rule.stage_key ? el('div', { class: 'faint' }, `Only in stage: ${rule.stage_key.replace(/_/g, ' ')}`) : null),
    el('td', { 'data-label': 'Fires' },
      rule.offset_days === 0
        ? `On ${triggerLabel(rule.trigger_field).toLowerCase()}`
        : `${rule.offset_days} day${rule.offset_days === 1 ? '' : 's'} ${rule.offset_direction} ${triggerLabel(rule.trigger_field).toLowerCase()}`),
    el('td', { 'data-label': 'Does' },
      rule.action === 'task' ? `Creates a task: ${rule.task_title}`
        : rule.action === 'notify' ? 'Sends an in-app notification'
        : `Emails the client (${rule.email_template_key || 'no template'})`),
    el('td', { 'data-label': 'Status' }, rule.active === 1
      ? el('span', { class: 'pill good' }, 'Active')
      : el('span', { class: 'pill' }, 'Paused')),
    el('td', { class: 'nowrap' },
      canManage ? el('button', { class: 'btn sm ghost', onclick: () => workflowModal(data, rule) }, 'Edit') : null,
      canManage ? el('button', {
        class: 'btn sm ghost', style: 'color:var(--bad)',
        onclick: async () => {
          if (!(await confirmDialog(`Delete "${rule.name}"? Tasks it already created stay where they are.`, { danger: true, confirmLabel: 'Delete' }))) return;
          await api.del(`/api/broker/workflows/${rule.id}`);
          toast('Rule deleted.', 'good');
          renderAutomation();
        },
      }, 'Delete') : null)));

  const preview = el('div');
  const previewBtn = el('button', { class: 'btn secondary' }, 'Preview what would fire today');
  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      const res = await api.get('/api/broker/workflows/preview');
      clearNode(preview);
      preview.append(res.actions.length === 0
        ? el('div', { class: 'notice' }, el('span', { class: 'ic' }, 'ℹ'), el('div', null, 'Nothing is due to fire right now.'))
        : el('div', { class: 'card' },
            el('h3', null, `${res.actions.length} would fire`),
            el('ul', { class: 'list' }, res.actions.map((a) => el('li', { class: 'row wrap' },
              el('span', { class: 'grow' }, a.rule),
              el('span', { class: 'faint mono' }, a.file_number),
              el('span', { class: 'pill' }, a.action))))));
    } catch (err) { toast(err.message, 'bad'); }
    previewBtn.disabled = false;
  });

  setView(
    el('div', { class: 'page-head' },
      el('div', { class: 'grow' },
        el('h1', null, 'Automation'),
        el('p', { class: 'sub' }, 'Rules that fire a set number of days before or after a key date on a file.')),
      canManage ? el('button', { class: 'btn', onclick: () => workflowModal(data, null) }, '+ Add rule') : null),

    data.client_email_enabled
      ? el('div', { class: 'notice warn' }, el('span', { class: 'ic' }, '!'),
          el('div', null, el('strong', null, 'Client email automation is on. '),
            'Rules with the “email the client” action will send to real clients without anyone reviewing them first. Turn it off under Settings → Automation if that is not what you want.'))
      : el('div', { class: 'notice' }, el('span', { class: 'ic' }, 'ℹ'),
          el('div', null, el('strong', null, 'Rules create tasks for a person, not emails to clients. '),
            'Automatic client email is off by default and has to be switched on deliberately under Settings → Automation — an engine that can email a real client about a real mortgage should not be a surprise.')),

    data.rules.length === 0
      ? el('div', { class: 'card empty' },
          el('div', { class: 'big' }, '⟳'),
          el('h3', null, 'No automation rules'),
          el('p', null, 'A rule watches one of a file’s key dates — submitted, conditions due, closing, rate hold expiry, maturity — and creates the follow-up before it becomes a problem.'),
          canManage ? el('button', { class: 'btn', onclick: () => workflowModal(data, null) }, 'Create the first rule') : null)
      : el('div', { class: 'card flush' }, el('div', { class: 'table-wrap' },
          el('table', { class: 'data stackable' },
            el('thead', null, el('tr', null, ['Rule', 'Fires', 'Does', 'Status', ''].map((h) => el('th', null, h)))),
            el('tbody', null, rows)))),

    el('div', { class: 'row', style: 'margin-bottom:12px' }, previewBtn),
    preview);
}

function workflowModal(data, rule) {
  const val = (k, d = '') => (rule && rule[k] !== null && rule[k] !== undefined ? rule[k] : d);
  const f = {
    name: el('input', { type: 'text', value: val('name'), placeholder: 'e.g. Chase the lender after submission' }),
    trigger_field: el('select', null, data.triggers.map(([k, l]) =>
      el('option', { value: k, selected: val('trigger_field') === k ? '' : undefined }, l))),
    offset_days: el('input', { type: 'number', min: '0', max: '365', value: val('offset_days', 3) }),
    offset_direction: el('select', null, [['after', 'after'], ['before', 'before']].map(([v, l]) =>
      el('option', { value: v, selected: val('offset_direction', 'after') === v ? '' : undefined }, l))),
    stage_key: el('select', null,
      el('option', { value: '' }, 'Any stage'),
      data.stages.map((s) => el('option', { value: s.key, selected: val('stage_key') === s.key ? '' : undefined }, s.name))),
    action: el('select', null, [['task', 'Create a task'], ['notify', 'Notify the assigned broker'], ['email_client', 'Email the client']].map(([v, l]) =>
      el('option', { value: v, selected: val('action', 'task') === v ? '' : undefined }, l))),
    task_title: el('input', { type: 'text', value: val('task_title'), placeholder: 'Supports {{file_number}}, {{closing_date}}, {{due_date}}' }),
    task_description: el('textarea', null, val('task_description')),
    task_priority: el('select', null, [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']].map(([v, l]) =>
      el('option', { value: v, selected: val('task_priority', 'normal') === v ? '' : undefined }, l))),
    assignee: el('select', null, data.assignees.map(([v, l]) =>
      el('option', { value: v, selected: val('assignee', 'assigned_broker') === v ? '' : undefined }, l))),
    email_template_key: el('select', null,
      el('option', { value: '' }, 'Choose a template'),
      data.templates.map((t) => el('option', { value: t.key, selected: val('email_template_key') === t.key ? '' : undefined }, t.name))),
  };
  const active = el('input', { type: 'checkbox', checked: !rule || rule.active === 1 ? '' : undefined });
  const error = el('p', { class: 'form-error' });

  const emailRow = el('div', { class: rule && rule.action === 'email_client' ? '' : 'hidden' },
    el('label', { class: 'field' }, el('span', null, 'Email template'), f.email_template_key),
    !data.client_email_enabled
      ? el('div', { class: 'notice warn' }, el('span', { class: 'ic' }, '!'),
          el('div', null, 'Client email automation is currently off, so this rule will record why it did nothing rather than sending. Enable it under Settings → Automation.'))
      : null);
  const taskRow = el('div', { class: rule && rule.action !== 'task' ? 'hidden' : '' },
    el('label', { class: 'field' }, el('span', null, 'Task title'), f.task_title),
    el('label', { class: 'field' }, el('span', null, 'Task description'), f.task_description),
    el('div', { class: 'form-row cols-2' },
      el('label', { class: 'field' }, el('span', null, 'Priority'), f.task_priority),
      el('label', { class: 'field' }, el('span', null, 'Assign to'), f.assignee)));
  f.action.addEventListener('change', () => {
    emailRow.classList.toggle('hidden', f.action.value !== 'email_client');
    taskRow.classList.toggle('hidden', f.action.value === 'email_client');
  });

  openModal(rule ? 'Edit rule' : 'New automation rule',
    el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Rule name'), f.name),
      el('div', { class: 'form-row cols-3' },
        el('label', { class: 'field' }, el('span', null, 'Days'), f.offset_days),
        el('label', { class: 'field' }, el('span', null, 'Before / after'), f.offset_direction),
        el('label', { class: 'field' }, el('span', null, 'This date'), f.trigger_field)),
      el('div', { class: 'form-row cols-2' },
        el('label', { class: 'field' }, el('span', null, 'Only when the file is in'), f.stage_key),
        el('label', { class: 'field' }, el('span', null, 'Then'), f.action)),
      taskRow,
      emailRow,
      rule ? el('label', { class: 'checkbox' }, active, 'Active') : null,
      el('p', { class: 'faint' }, 'A rule fires once per file per date. Changing a file’s date creates a new firing point; it never re-fires for one already passed.'),
      error),
    (close) => [
      el('button', { class: 'btn secondary', onclick: close }, 'Cancel'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          const payload = Object.fromEntries(Object.entries(f).map(([k, node]) => [k, node.value]));
          if (rule) payload.active = active.checked;
          try {
            if (rule) await api.patch(`/api/broker/workflows/${rule.id}`, payload);
            else await api.post('/api/broker/workflows', payload);
            close();
            toast(rule ? 'Rule saved.' : 'Rule created.', 'good');
            renderAutomation();
          } catch (err) { error.textContent = err.message; e.target.disabled = false; }
        },
      }, rule ? 'Save' : 'Create'),
    ]);
}
