'use strict';

/**
 * The deal module, end to end over the real HTTP API.
 *
 * Same principle as every other suite here: nothing is called as an internal
 * function, because the API is the boundary a user — or an attacker — reaches.
 * The permission tests matter most: financial position and AML answers are
 * more sensitive than the rest of a client file, and a role that can see a
 * client's name must not automatically see their liabilities.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer, signInAdmin, clearRateLimits, makeClient, newTotpWindow, totpNow,
} = require('./helpers');

let ctx;
let admin;
let fileId;
let applicantId;

test.before(async () => {
  ctx = await startTestServer('deal');
  admin = await signInAdmin(ctx.base);
});

test.after(async () => { if (ctx) await ctx.stop(); });

/** Create a client file to work against. */
test('setup: a client file exists', async () => {
  const meta = await admin.get('/api/settings/meta');
  const type = meta.data.application_types.find((t) => t.key === 'purchase');
  const res = await admin.post('/api/broker/clients', {
    client: { first_name: 'Dana', last_name: 'Okonkwo', email: 'dana.deal@example.com', employment_type: 'employee' },
    application: { application_type_id: type.id, purchase_price: 800000, down_payment: 160000, mortgage_amount: 640000 },
    send_welcome: false,
    ignore_duplicates: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  fileId = res.data.file.id;

  const detail = await admin.get(`/api/broker/files/${fileId}`);
  applicantId = detail.data.applicants[0].id;
  assert.ok(applicantId);
});

test('a new file has no ratios and says exactly what is missing', async () => {
  const res = await admin.get(`/api/broker/files/${fileId}/deal`);
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.ratios.gds, null);
  assert.ok(res.data.metrics.warnings.some((w) => /no qualifying income/i.test(w)));
  assert.equal(res.data.mortgage_requests.length, 0);
});

test('income, assets and liabilities move the ratios', async () => {
  const income = await admin.post(`/api/broker/files/${fileId}/incomes`, {
    applicant_id: applicantId, kind: 'employment', employer: 'Northline Logistics',
    amount: 132000, period: 'annual',
  });
  assert.equal(income.status, 200, JSON.stringify(income.data));
  assert.equal(income.data.metrics.income.gross_monthly, 11000);

  // An excluded source is carried on the file but stays out of qualification.
  const bonus = await admin.post(`/api/broker/files/${fileId}/incomes`, {
    applicant_id: applicantId, kind: 'bonus', amount: 24000, period: 'annual', qualifies: false,
  });
  assert.equal(bonus.data.metrics.income.gross_monthly, 11000, 'excluded income does not raise the qualifying figure');
  assert.equal(bonus.data.metrics.income.excluded_monthly, 2000);

  const asset = await admin.post(`/api/broker/files/${fileId}/assets`, {
    kind: 'savings', description: 'Down payment savings', value: 180000, down_payment_amount: 160000,
  });
  assert.equal(asset.data.metrics.assets.total, 180000);
  assert.equal(asset.data.metrics.assets.down_payment_identified, 160000);

  const liability = await admin.post(`/api/broker/files/${fileId}/liabilities`, {
    kind: 'auto_loan', lender: 'Northline Credit', balance: 22000, monthly_payment: 480,
  });
  assert.equal(liability.data.metrics.debts.monthly_payments, 480);
  assert.equal(liability.data.metrics.net_worth, 180000 - 22000);
});

test('a liability paid off at closing stops counting toward TDS', async () => {
  const before = await admin.get(`/api/broker/files/${fileId}/metrics`);
  const created = await admin.post(`/api/broker/files/${fileId}/liabilities`, {
    kind: 'credit_card', lender: 'Store card', balance: 9000, monthly_payment: 270,
  });
  assert.equal(created.data.metrics.debts.monthly_payments, before.data.metrics.debts.monthly_payments + 270);

  const liabilities = (await admin.get(`/api/broker/files/${fileId}/deal`)).data.liabilities;
  const card = liabilities.find((l) => l.lender === 'Store card');
  const updated = await admin.patch(`/api/broker/liabilities/${card.id}`, { payoff_at_close: true });
  assert.equal(updated.data.metrics.debts.monthly_payments, before.data.metrics.debts.monthly_payments,
    'a debt being paid off at closing leaves the ratio, which is the point of a consolidation');
  assert.equal(updated.data.metrics.debts.total_balance, 22000 + 9000, 'but it still counts against net worth');
});

test('the subject property supplies the shelter costs GDS needs', async () => {
  const res = await admin.put(`/api/broker/files/${fileId}/property`, {
    city: 'Hamilton', province: 'ON', dwelling_type: 'detached', occupancy: 'owner_occupied',
    annual_taxes: 6000, heating_monthly: 140, hydro_monthly: 110, estimated_value: 800000,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.metrics.property.taxes_monthly, 500);
  assert.equal(res.data.metrics.property.heat_monthly, 140);
  assert.equal(res.data.metrics.property.gds_shelter_excluding_mortgage, 640,
    'hydro is real money but is not part of the GDS numerator');

  // Saving the property keeps the file's own province in step, because that
  // is what provincial compliance requirements key off.
  const deal = await admin.get(`/api/broker/files/${fileId}/deal`);
  assert.equal(deal.data.file.province, 'ON');
});

test('a mortgage request produces the payment and the qualifying figures', async () => {
  const res = await admin.post(`/api/broker/files/${fileId}/mortgage-requests`, {
    label: 'First mortgage', position: 'first', principal: 640000, contract_rate: 4.5,
    term_months: 60, amortization_months: 300, payment_frequency: 'monthly',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const m = res.data.metrics;

  assert.equal(m.mortgage.qualifying_rate, 6.5, 'max(4.5 + 2.0, 5.25)');
  assert.ok(m.mortgage.payment > 0);
  assert.ok(m.mortgage.qualifying_payment_monthly > m.mortgage.payment,
    'the stress-tested payment is higher than what the client actually pays');
  assert.ok(m.ratios.gds > m.ratios.contract_gds,
    'the headline GDS is the stress-tested one, not the flattering one');
  assert.equal(m.ratios.ltv, 80);
  assert.equal(m.insurance.required, false, 'exactly 80% is conventional');

  // The first request on a file becomes the primary one automatically.
  assert.equal(res.data.mortgage_requests[0].is_primary, 1);
});

test('a second request does not take over the ratios until it is made primary', async () => {
  const second = await admin.post(`/api/broker/files/${fileId}/mortgage-requests`, {
    label: 'Alternative pricing', position: 'first', principal: 640000, contract_rate: 6.9,
    amortization_months: 360,
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.mortgage_requests.length, 2);

  const stillFirst = await admin.get(`/api/broker/files/${fileId}/metrics`);
  assert.equal(stillFirst.data.metrics.mortgage.contract_rate, 4.5);

  const promoted = await admin.patch(`/api/broker/mortgage-requests/${second.data.id}`, { is_primary: true });
  assert.equal(promoted.data.metrics.mortgage.contract_rate, 6.9);

  // Put it back, and clean up.
  const requests = (await admin.get(`/api/broker/files/${fileId}/deal`)).data.mortgage_requests;
  const original = requests.find((r) => r.label === 'First mortgage');
  await admin.patch(`/api/broker/mortgage-requests/${original.id}`, { is_primary: true });
  const removed = await admin.del(`/api/broker/mortgage-requests/${second.data.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.mortgage_requests.length, 1);
});

test('a funded mortgage request cannot be deleted', async () => {
  const created = await admin.post(`/api/broker/files/${fileId}/mortgage-requests`, {
    label: 'Funded record', principal: 100000, contract_rate: 5,
  });
  await admin.patch(`/api/broker/mortgage-requests/${created.data.id}`, { status: 'funded' });
  const attempt = await admin.del(`/api/broker/mortgage-requests/${created.data.id}`);
  assert.equal(attempt.status, 400);
  assert.equal(attempt.data.code, 'funded_locked');

  // Marking it funded also stamped the file's lifecycle date, so the renewal
  // and anniversary automation has something to fire from.
  const deal = await admin.get(`/api/broker/files/${fileId}/deal`);
  assert.ok(deal.data.file.lifecycle.funded_at, 'funding stamps the file date');
});

test('the calculator never touches a record', async () => {
  const res = await admin.get('/api/broker/calculator?principal=600000&rate=5&amortization_months=300');
  assert.equal(res.status, 200);
  assert.ok(Math.abs(res.data.contract.payment - 3489.63) < 0.05);
  assert.equal(res.data.qualifying.rate, 7);
});

test('a child record cannot be reached from a fabricated id', async () => {
  assert.equal((await admin.patch('/api/broker/incomes/999999', { amount: 1 })).status, 404);
  assert.equal((await admin.del('/api/broker/assets/999999')).status, 404);
  assert.equal((await admin.patch('/api/broker/liabilities/abc', { balance: 1 })).status, 404);
  assert.equal((await admin.get('/api/broker/files/999999/deal')).status, 404);
});

test('income must belong to an applicant actually on the file', async () => {
  const other = await admin.post('/api/broker/clients', {
    client: { first_name: 'Rafe', last_name: 'Molina', email: 'rafe.deal@example.com', employment_type: 'employee' },
    send_welcome: false, ignore_duplicates: true,
  });
  const otherApplicant = (await admin.get(`/api/broker/files/${other.data.file.id}`)).data.applicants[0].id;

  const res = await admin.post(`/api/broker/files/${fileId}/incomes`, {
    applicant_id: otherApplicant, amount: 500000, period: 'annual',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'bad_applicant');
});

// ---------------------------------------------------------------------------
// AML

test('AML starts incomplete and names every gap', async () => {
  const res = await admin.get(`/api/broker/files/${fileId}/aml`);
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.complete, false);
  assert.ok(res.data.summary.outstanding.some((g) => /risk question/i.test(g)));
  assert.ok(res.data.summary.outstanding.some((g) => /identity not verified/i.test(g)));
  assert.ok(res.data.summary.outstanding.some((g) => /not screened/i.test(g)));
  assert.equal(res.data.summary.screening_mode, 'manual',
    'with no provider configured the platform asks a human rather than faking a clearance');
});

test('a reporting obligation forces high risk regardless of anything else', async () => {
  const answers = {};
  for (const section of (await admin.get(`/api/broker/files/${fileId}/aml`)).data.questions) {
    for (const item of section.items) answers[item.key] = false;
  }
  const clean = await admin.put(`/api/broker/files/${fileId}/aml`, { answers });
  assert.equal(clean.data.summary.risk_level, 'low');

  const flagged = await admin.put(`/api/broker/files/${fileId}/aml`, {
    answers: { ...answers, suspicious_transaction_report: true },
  });
  assert.equal(flagged.data.summary.risk_level, 'high',
    'a suspicious transaction report is not a few points on a scale');

  await admin.put(`/api/broker/files/${fileId}/aml`, { answers });
});

test('a flagged third party must be described before the record is complete', async () => {
  const base = {};
  for (const section of (await admin.get(`/api/broker/files/${fileId}/aml`)).data.questions) {
    for (const item of section.items) base[item.key] = false;
  }
  const res = await admin.put(`/api/broker/files/${fileId}/aml`, {
    answers: { ...base, funds_from_third_party: true },
  });
  assert.ok(res.data.summary.outstanding.some((g) => /third party/i.test(g)));

  const described = await admin.put(`/api/broker/files/${fileId}/aml`, {
    answers: { ...base, funds_from_third_party: true, third_party_details: 'Gift from the borrower’s parent; identity confirmed in person.' },
  });
  assert.ok(!described.data.summary.outstanding.some((g) => /third party/i.test(g)));

  await admin.put(`/api/broker/files/${fileId}/aml`, { answers: base });
});

test('a foreign PEP raises the deal’s risk, not just the borrower row', async () => {
  const res = await admin.put(`/api/broker/files/${fileId}/aml/borrowers/${applicantId}`, {
    pep_foreign: true, pep_relationship: 'family',
    pep_details: 'Spouse of a serving foreign minister.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.risk_level, 'high');

  const reset = await admin.put(`/api/broker/files/${fileId}/aml/borrowers/${applicantId}`, {
    pep_foreign: false, pep_relationship: '',
  });
  assert.notEqual(reset.data.summary.risk_level, 'high');
});

test('a PEP flag without a stated relationship is reported as a gap', async () => {
  const res = await admin.put(`/api/broker/files/${fileId}/aml/borrowers/${applicantId}`, {
    pep_domestic: true, pep_relationship: '',
  });
  assert.ok(res.data.summary.outstanding.some((g) => /relationship/i.test(g)),
    'FINTRAC covers family and close associates, so "who" is part of the answer');
  await admin.put(`/api/broker/files/${fileId}/aml/borrowers/${applicantId}`, { pep_domestic: false });
});

test('recording a screening result stamps who did it and when', async () => {
  const res = await admin.put(`/api/broker/files/${fileId}/aml/borrowers/${applicantId}`, {
    sanction_status: 'cleared', sanction_sources: ['un', 'sema'], sanction_note: 'No matches.',
  });
  assert.equal(res.status, 200);
  const detail = await admin.get(`/api/broker/files/${fileId}/aml`);
  const check = detail.data.borrowers.find((b) => b.applicant_id === applicantId).check;
  assert.equal(check.sanction_status, 'cleared');
  assert.ok(check.sanction_screened_at);
  assert.equal(check.sanction_sources, 'un,sema');
});

test('AML answers outside the known question set are discarded', async () => {
  const res = await admin.put(`/api/broker/files/${fileId}/aml`, {
    answers: { property_high_risk_area: false, made_up_question: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.answers.made_up_question, undefined,
    'a typo must not silently become a question nothing ever asks about again');
});

// ---------------------------------------------------------------------------
// Lender catalog and matching

test('the product matcher screens against the file and explains its exclusions', async () => {
  const res = await admin.get(`/api/broker/files/${fileId}/products`);
  assert.equal(res.status, 200);
  assert.equal(res.data.criteria.province, 'ON');
  assert.equal(res.data.criteria.ltv, 80);
  assert.ok(res.data.matched.length + res.data.excluded.length > 0, 'the seeded catalog has products');
  for (const p of res.data.excluded) {
    assert.ok(Array.isArray(p.reasons) && p.reasons.length, 'every exclusion says why');
  }
  for (const p of res.data.matched) {
    assert.ok(p.estimated_payment > 0, 'an eligible product is priced against this file’s principal');
  }
});

test('a product outside the file’s province is ruled out by name', async () => {
  const lender = await admin.post('/api/broker/lenders', { name: 'Prairie Only Trust', kind: 'alternative' });
  await admin.post(`/api/broker/lenders/${lender.data.id}/products`, {
    name: 'SK exclusive', rate: 3.99, eligible_provinces: 'SK',
  });
  const res = await admin.get(`/api/broker/files/${fileId}/products`);
  const excluded = res.data.excluded.find((p) => p.name === 'SK exclusive');
  assert.ok(excluded, 'the product is screened out rather than silently absent');
  assert.ok(excluded.reasons.some((r) => /ON/.test(r)));
});

test('applying a product snapshots the lender and product names', async () => {
  const products = await admin.get(`/api/broker/files/${fileId}/products`);
  const product = products.data.matched[0];
  assert.ok(product, 'at least one product fits this file');

  const requests = (await admin.get(`/api/broker/files/${fileId}/deal`)).data.mortgage_requests;
  const primary = requests.find((r) => r.is_primary === 1);
  const res = await admin.patch(`/api/broker/mortgage-requests/${primary.id}`, { product_id: product.id });
  assert.equal(res.status, 200);

  const applied = res.data.mortgage_requests.find((r) => r.id === primary.id);
  assert.equal(applied.product_id, product.id);
  assert.equal(applied.lender_name_snapshot, product.lender_name);
  assert.equal(Number(applied.contract_rate), Number(product.rate));

  // Change the catalog rate; the file must still say what was chosen.
  await admin.patch(`/api/broker/products/${product.id}`, { rate: 9.99 });
  const after = (await admin.get(`/api/broker/files/${fileId}/deal`)).data.mortgage_requests.find((r) => r.id === primary.id);
  assert.equal(Number(after.contract_rate), Number(product.rate), 'a catalog change never rewrites history');
  await admin.patch(`/api/broker/products/${product.id}`, { rate: product.rate });
});

test('retiring a product keeps it out of new matches without destroying it', async () => {
  const before = await admin.get('/api/broker/lenders?all=1');
  const target = before.data.lenders.flatMap((l) => l.products).find((p) => p.name === 'SK exclusive');
  await admin.del(`/api/broker/products/${target.id}`);
  const after = await admin.get('/api/broker/lenders');
  assert.ok(!after.data.lenders.flatMap((l) => l.products).some((p) => p.id === target.id));
  const withRetired = await admin.get('/api/broker/lenders?all=1');
  assert.ok(withRetired.data.lenders.flatMap((l) => l.products).some((p) => p.id === target.id));
});

test('a rate outside a plausible range is refused', async () => {
  const lenders = await admin.get('/api/broker/lenders');
  const lender = lenders.data.lenders[0];
  const res = await admin.post(`/api/broker/lenders/${lender.id}/products`, { name: 'Nonsense', rate: 400 });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'bad_value');
});

// ---------------------------------------------------------------------------
// Lifecycle dates, pipeline and reports

test('lifecycle dates are stored and reported back', async () => {
  const res = await admin.patch(`/api/broker/files/${fileId}/lifecycle`, {
    submitted_at: '2026-03-01', conditions_due_date: '2026-03-15', maturity_date: '2031-04-01',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.changed.sort(), ['conditions_due_date', 'maturity_date', 'submitted_at']);

  const deal = await admin.get(`/api/broker/files/${fileId}/deal`);
  assert.equal(deal.data.file.lifecycle.maturity_date, '2031-04-01');
});

test('the pipeline board reports true totals, not just the loaded page', async () => {
  const res = await admin.get('/api/broker/pipeline?limit=5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.columns));
  const withCards = res.data.columns.filter((c) => c.total > 0);
  assert.ok(withCards.length > 0);
  for (const column of res.data.columns) {
    assert.ok(column.cards.length <= column.total, 'a column never shows more cards than it has files');
    assert.ok(column.cards.length <= 5, 'the page size is respected');
  }
  const card = withCards[0].cards[0];
  assert.ok(card.client_name);
  assert.ok(Object.prototype.hasOwnProperty.call(card, 'metrics'));
});

test('relationship reports window over the lifecycle dates', async () => {
  const maturities = await admin.get('/api/broker/reports/relationships?kind=maturities&days=365');
  assert.equal(maturities.status, 200);
  // The maturity above is years out, so a one-year window must not include it.
  assert.ok(!maturities.data.rows.some((r) => r.file_id === fileId));

  const wide = await admin.get('/api/broker/reports/relationships?kind=maturities&days=730');
  assert.equal(wide.data.days, 730);

  const unknown = await admin.get('/api/broker/reports/relationships?kind=nonsense');
  assert.equal(unknown.status, 400);
});

// ---------------------------------------------------------------------------
// Workflow automation

test('workflow rules fire once, on the right day, and never twice', async () => {
  const workflows = require('../server/workflows');

  const created = await admin.post('/api/broker/workflows', {
    name: 'Test: five days after submission',
    trigger_field: 'submitted_at', offset_days: 5, offset_direction: 'after',
    action: 'task', task_title: 'Chase {{file_number}}',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  // Submitted 2026-03-01 + 5 days = 2026-03-06. The day before must not fire.
  const early = await workflows.runWorkflowPass({ asOf: '2026-03-05', dryRun: true });
  assert.ok(!early.actions.some((a) => a.rule_id === created.data.id && a.file_id === fileId),
    'off-by-one: a rule must not fire the day before it is due');

  const onTime = await workflows.runWorkflowPass({ asOf: '2026-03-06', dryRun: true });
  assert.ok(onTime.actions.some((a) => a.rule_id === created.data.id && a.file_id === fileId));

  const fired = await workflows.runWorkflowPass({ asOf: '2026-03-06' });
  assert.ok(fired.fired > 0);

  const again = await workflows.runWorkflowPass({ asOf: '2026-03-06' });
  assert.ok(!again.actions.some((a) => a.rule_id === created.data.id && a.file_id === fileId && a.result === 'fired'),
    'a nightly pass must not create the same follow-up every night');

  // A pass that missed a day still catches up rather than skipping the window.
  const late = await workflows.runWorkflowPass({ asOf: '2026-03-20', dryRun: true });
  assert.ok(!late.actions.some((a) => a.rule_id === created.data.id && a.file_id === fileId),
    'already fired for this date, so a later pass leaves it alone');

  const tasks = await admin.get(`/api/broker/tasks?filter=all`);
  assert.ok(tasks.data.tasks.some((t) => t.title.includes('Chase MTG-')),
    'the merge field was rendered with the real file number');

  await admin.del(`/api/broker/workflows/${created.data.id}`);
});

test('a workflow cannot email a client while client email automation is off', async () => {
  const workflows = require('../server/workflows');
  const rule = await admin.post('/api/broker/workflows', {
    name: 'Test: email on submission',
    trigger_field: 'submitted_at', offset_days: 6, offset_direction: 'after',
    action: 'email_client', email_template_key: 'stage_changed',
  });
  const result = await workflows.runWorkflowPass({ asOf: '2026-03-07' });
  const entry = result.actions.find((a) => a.rule_id === rule.data.id && a.file_id === fileId);
  assert.ok(entry, 'the rule was evaluated');

  const run = await require('../server/db').get(
    'SELECT detail FROM workflow_runs WHERE rule_id = ? AND file_id = ?', rule.data.id, fileId
  );
  assert.match(run.detail, /client email automation is off/i,
    'it records why it did nothing rather than quietly emailing a real client');

  await admin.del(`/api/broker/workflows/${rule.data.id}`);
});

test('a workflow rule needs a real trigger date field', async () => {
  const res = await admin.post('/api/broker/workflows', {
    name: 'Bad rule', trigger_field: 'whenever_i_feel_like_it', action: 'task',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'bad_trigger');
});

// ---------------------------------------------------------------------------
// Permissions

test('a role without financials.view cannot reach the financial picture', async () => {
  await clearRateLimits();
  // An assistant has clients.view but, by default, none of the deal-module
  // permissions.
  const created = await admin.post('/api/settings/users', {
    email: 'assistant.deal@test.local', first_name: 'Ines', last_name: 'Barros', role: 'assistant',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const db = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const password = 'Harbour-Lantern-Quiet-42';
  await db.run(
    "UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0 WHERE lower(email) = ?",
    await hashPassword(password), 'assistant.deal@test.local'
  );

  const assistant = makeClient(ctx.base);
  const login = await assistant.post('/api/auth/login', { email: 'assistant.deal@test.local', password });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  // They can see the client, which is the whole point of the role.
  assert.equal((await assistant.get(`/api/broker/files/${fileId}`)).status, 200);

  // But not the money, and not the compliance record.
  assert.equal((await assistant.get(`/api/broker/files/${fileId}/deal`)).status, 403);
  assert.equal((await assistant.get(`/api/broker/files/${fileId}/metrics`)).status, 403);
  assert.equal((await assistant.get(`/api/broker/files/${fileId}/aml`)).status, 403);
  assert.equal((await assistant.post(`/api/broker/files/${fileId}/incomes`, {
    applicant_id: applicantId, amount: 1, period: 'annual',
  })).status, 403);
  assert.equal((await assistant.get('/api/broker/lenders')).status, 403);
});

test('read-only financial access cannot write', async () => {
  await clearRateLimits();
  // A processor may view financials and AML but not edit them. The role is
  // retired — it cannot be assigned any more — but accounts that hold one
  // still resolve their permissions, which is exactly what this checks.
  const created = await admin.post('/api/settings/users', {
    email: 'processor.deal@test.local', first_name: 'Wren', last_name: 'Aoki', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const db = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const password = 'Cobalt-Willow-Anchor-77';
  await db.run(
    "UPDATE users SET role = 'processor', password_hash = ?, status = 'active', must_change_password = 0, mfa_secret = NULL WHERE lower(email) = ?",
    await hashPassword(password), 'processor.deal@test.local'
  );
  // Processors require MFA by default; enrol so the session is usable.
  const mfa = require('../server/mfa');
  const processor = makeClient(ctx.base);
  let login = await processor.post('/api/auth/login', { email: 'processor.deal@test.local', password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const begin = await processor.post('/api/auth/mfa/begin');
  const confirm = await processor.post('/api/auth/mfa/confirm', {
    code: mfa.codeForStep(begin.data.secret, mfa.currentStep()),
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));

  assert.equal((await processor.get(`/api/broker/files/${fileId}/deal`)).status, 200);
  const deal = await processor.get(`/api/broker/files/${fileId}/deal`);
  assert.equal(deal.data.can_edit, false, 'the response tells the UI not to offer editing');

  assert.equal((await processor.post(`/api/broker/files/${fileId}/incomes`, {
    applicant_id: applicantId, amount: 999999, period: 'annual',
  })).status, 403);
  assert.equal((await processor.put(`/api/broker/files/${fileId}/property`, { city: 'Nowhere' })).status, 403);
  assert.equal((await processor.put(`/api/broker/files/${fileId}/aml`, { answers: {} })).status, 403);
  assert.equal((await processor.post('/api/broker/lenders', { name: 'Rogue Bank' })).status, 403);

  // Reading AML is allowed for this role.
  assert.equal((await processor.get(`/api/broker/files/${fileId}/aml`)).status, 200);
});

test('a client portal user cannot reach any deal endpoint', async () => {
  await clearRateLimits();
  const invite = await admin.post(`/api/broker/applicants/${applicantId}/invite`, {});
  assert.equal(invite.status, 200, JSON.stringify(invite.data));

  const portal = makeClient(ctx.base);
  const login = await portal.post('/api/auth/login', {
    email: invite.data.username, password: invite.data.temporary_password,
  });
  assert.equal(login.status, 200);
  await portal.post('/api/auth/change-password', {
    current_password: invite.data.temporary_password,
    new_password: 'Seagrass-Marble-Kite-19',
  });

  for (const url of [
    `/api/broker/files/${fileId}/deal`,
    `/api/broker/files/${fileId}/aml`,
    `/api/broker/files/${fileId}/metrics`,
    '/api/broker/lenders',
    '/api/broker/pipeline',
    '/api/broker/calculator?principal=1&rate=1',
  ]) {
    const res = await portal.get(url);
    assert.equal(res.status, 403, `${url} must refuse a client portal session`);
  }
});

test('every deal endpoint refuses an unauthenticated caller', async () => {
  const anon = makeClient(ctx.base);
  for (const url of [
    `/api/broker/files/${fileId}/deal`,
    `/api/broker/files/${fileId}/aml`,
    '/api/broker/lenders',
    '/api/broker/pipeline',
    '/api/broker/workflows',
  ]) {
    const res = await anon.get(url);
    assert.equal(res.status, 401, `${url} must refuse an anonymous caller`);
  }
});
