'use strict';

/**
 * The deal workspace: everything a broker underwrites against.
 *
 * Split out from broker.routes.js rather than appended to it, because these
 * endpoints share a different shape — they are all "one file's financial
 * picture" — and because the qualification metrics are recomputed on nearly
 * every one of them.
 */

const { run, get, all, insert, getSetting, touchFile } = require('../db');
const { requirePermission, hasPermission } = require('../auth');
const {
  ApiError, now, str, num, intOrNull, bool, dateStr, parseJsonSafe, fullName,
} = require('../util');
const { audit, activity } = require('../log');
const metrics = require('../metrics');
const aml = require('../aml');
const workflows = require('../workflows');

// ---------------------------------------------------------------------------
// Helpers

function idParam(value) {
  const id = intOrNull(value);
  if (id === null || id <= 0) throw new ApiError(404, 'Not found.', 'not_found');
  return id;
}

async function fileOrThrow(id) {
  const file = await get('SELECT * FROM client_files WHERE id = ?', idParam(id));
  if (!file) throw new ApiError(404, 'That client file was not found.', 'not_found');
  return file;
}

/** Every child row belongs to a file; nothing is reachable by bare child id. */
async function childOrThrow(table, id, label) {
  const row = await get(`SELECT * FROM ${table} WHERE id = ?`, idParam(id));
  if (!row) throw new ApiError(404, `${label} not found.`, 'not_found');
  return row;
}

async function applicantOnFile(fileId, applicantId) {
  if (applicantId === null) return null;
  const row = await get('SELECT * FROM applicants WHERE id = ? AND file_id = ?', applicantId, fileId);
  if (!row) throw new ApiError(400, 'That applicant is not on this file.', 'bad_applicant');
  return row;
}

async function stressTestPolicy() {
  const stored = await getSetting('qualification', {});
  return { ...metrics.DEFAULT_STRESS_TEST, ...stored };
}

/** The primary mortgage request, or the newest one if none is flagged. */
function primaryRequest(requests) {
  return requests.find((r) => r.is_primary === 1) || requests[0] || null;
}

/** Load the whole financial picture for a file and compute its metrics. */
async function loadDeal(file) {
  const [property, incomes, assets, liabilities, requests] = await Promise.all([
    get('SELECT * FROM file_properties WHERE file_id = ?', file.id),
    all('SELECT * FROM applicant_incomes WHERE file_id = ? ORDER BY applicant_id, id', file.id),
    all('SELECT * FROM file_assets WHERE file_id = ? ORDER BY id', file.id),
    all('SELECT * FROM file_liabilities WHERE file_id = ? ORDER BY id', file.id),
    all('SELECT * FROM mortgage_requests WHERE file_id = ? ORDER BY is_primary DESC, id', file.id),
  ]);
  const policy = await stressTestPolicy();
  const request = primaryRequest(requests);
  return {
    property: property || null,
    incomes,
    assets,
    liabilities,
    requests,
    request,
    metrics: metrics.computeMetrics({ file, property, incomes, assets, liabilities, request, policy }),
  };
}

/**
 * A compact metric block for list/board rows.
 *
 * Computed set-based for a whole page of files at once: one query per child
 * table rather than five per file, so a 25-row board costs six queries no
 * matter how large the book is.
 */
async function metricsForFiles(files) {
  const out = new Map();
  if (!files.length) return out;
  const ids = files.map((f) => f.id);
  const policy = await stressTestPolicy();

  const [properties, incomes, assets, liabilities, requests] = await Promise.all([
    all('SELECT * FROM file_properties WHERE file_id = ANY(?::int[])', ids),
    all('SELECT * FROM applicant_incomes WHERE file_id = ANY(?::int[])', ids),
    all('SELECT * FROM file_assets WHERE file_id = ANY(?::int[])', ids),
    all('SELECT * FROM file_liabilities WHERE file_id = ANY(?::int[])', ids),
    all('SELECT * FROM mortgage_requests WHERE file_id = ANY(?::int[]) ORDER BY is_primary DESC, id', ids),
  ]);

  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.file_id)) map.set(row.file_id, []);
      map.get(row.file_id).push(row);
    }
    return map;
  };
  const propertyBy = new Map(properties.map((p) => [p.file_id, p]));
  const incomeBy = group(incomes);
  const assetBy = group(assets);
  const liabilityBy = group(liabilities);
  const requestBy = group(requests);

  for (const file of files) {
    const m = metrics.computeMetrics({
      file,
      property: propertyBy.get(file.id) || null,
      incomes: incomeBy.get(file.id) || [],
      assets: assetBy.get(file.id) || [],
      liabilities: liabilityBy.get(file.id) || [],
      request: primaryRequest(requestBy.get(file.id) || []),
      policy,
    });
    out.set(file.id, {
      gds: m.ratios.gds,
      tds: m.ratios.tds,
      ltv: m.ratios.ltv,
      gds_status: m.ratios.gds_status,
      tds_status: m.ratios.tds_status,
      ltv_status: m.ratios.ltv_status,
      net_worth: m.net_worth,
      mortgage_amount: m.mortgage.principal,
      lender: m.mortgage.lender,
    });
  }
  return out;
}

const INCOME_KINDS = ['employment', 'self_employment', 'commission', 'bonus', 'pension', 'rental', 'investment', 'support', 'other'];
const INCOME_PERIODS = ['annual', 'monthly', 'semi_monthly', 'biweekly', 'weekly', 'hourly'];
const ASSET_KINDS = ['savings', 'chequing', 'tfsa', 'rrsp', 'investment', 'gift', 'property', 'vehicle', 'business', 'other'];
const LIABILITY_KINDS = ['credit_card', 'line_of_credit', 'auto_loan', 'student_loan', 'personal_loan', 'mortgage', 'lease', 'support_payment', 'other'];
const POSITIONS = ['first', 'second', 'third'];
const RATE_TYPES = ['fixed', 'variable', 'adjustable', 'capped_variable'];
const REQUEST_STATUSES = ['draft', 'selected', 'submitted', 'approved', 'declined', 'funded', 'cancelled'];
const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

const LIFECYCLE_FIELDS = [
  'lead_at', 'application_at', 'submitted_at', 'approved_at', 'accepted_at',
  'conditions_met_at', 'conditions_due_date', 'funded_at', 'lender_payment_at',
  'appraisal_ordered_at', 'appraisal_received_at', 'solicitor_instructed_at',
  'rate_hold_expires_at', 'maturity_date', 'closing_date',
];

function pick(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

// ---------------------------------------------------------------------------

function register(router) {
  const viewFinancials = requirePermission('financials.view');
  const editFinancials = requirePermission('financials.edit');
  const viewAml = requirePermission('aml.view');
  const manageAml = requirePermission('aml.manage');
  const viewLenders = requirePermission('lenders.view');
  const manageLenders = requirePermission('lenders.manage');
  const manageSettings = requirePermission('settings.manage');

  // ======================= Deal workspace =======================

  router.get('/api/broker/files/:id/deal', viewFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const deal = await loadDeal(file);
    const applicants = await all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
    return {
      file: {
        id: file.id,
        file_number: file.file_number,
        province: file.province,
        purchase_price: file.purchase_price,
        down_payment: file.down_payment,
        mortgage_amount: file.mortgage_amount,
        property_address: file.property_address,
        lifecycle: Object.fromEntries(LIFECYCLE_FIELDS.map((f) => [f, file[f] || null])),
      },
      applicants: applicants.map((a) => ({
        id: a.id, name: fullName(a), role: a.role, credit_score: a.credit_score,
        credit_bureau: a.credit_bureau, credit_pulled_at: a.credit_pulled_at,
        casl_consent: a.casl_consent === 1, casl_consent_at: a.casl_consent_at,
        language: a.language, marital_status: a.marital_status, dependents: a.dependents,
      })),
      property: deal.property,
      incomes: deal.incomes,
      assets: deal.assets,
      liabilities: deal.liabilities,
      mortgage_requests: deal.requests,
      metrics: deal.metrics,
      can_edit: await hasPermission(ctx.user, 'financials.edit'),
      reference: {
        income_kinds: INCOME_KINDS,
        income_periods: INCOME_PERIODS,
        asset_kinds: ASSET_KINDS,
        liability_kinds: LIABILITY_KINDS,
        positions: POSITIONS,
        rate_types: RATE_TYPES,
        request_statuses: REQUEST_STATUSES,
        payment_frequencies: Object.keys(metrics.PAYMENTS_PER_YEAR),
        provinces: PROVINCES,
        lifecycle_fields: LIFECYCLE_FIELDS,
      },
    };
  });

  /** Metrics alone — cheap enough to poll after any edit. */
  router.get('/api/broker/files/:id/metrics', viewFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const deal = await loadDeal(file);
    return { metrics: deal.metrics };
  });

  /**
   * A what-if calculator that touches nothing.
   *
   * Brokers price scenarios out loud on the phone; making them save a
   * mortgage request first just to see a payment would be absurd.
   */
  router.get('/api/broker/calculator', viewFinancials, async (ctx) => {
    const q = ctx.query;
    const policy = await stressTestPolicy();
    const principal = num(q.principal) || 0;
    const rate = num(q.rate) || 0;
    const amortization = intOrNull(q.amortization_months) || 300;
    const frequency = pick(Object.keys(metrics.PAYMENTS_PER_YEAR), q.frequency, 'monthly');
    const compounding = q.compounding === 'monthly' ? 'monthly' : 'semi_annual';
    const qualifying = num(q.qualifying_rate) ?? metrics.qualifyingRateFor(rate, policy);

    return {
      principal,
      contract: {
        rate,
        payment: metrics.payment({ principal, annualRatePct: rate, amortizationMonths: amortization, frequency, compounding }),
        payment_monthly_equivalent: metrics.toMonthly(
          metrics.payment({ principal, annualRatePct: rate, amortizationMonths: amortization, frequency, compounding }),
          frequency
        ),
      },
      qualifying: {
        rate: qualifying,
        payment_monthly: metrics.payment({ principal, annualRatePct: qualifying, amortizationMonths: amortization, frequency: 'monthly', compounding }),
      },
      frequency,
      amortization_months: amortization,
      policy,
    };
  });

  // ======================= Lifecycle dates =======================

  router.patch('/api/broker/files/:id/lifecycle', requirePermission('clients.edit'), async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const body = ctx.body || {};
    const updates = [];
    const params = [];
    const changed = [];
    for (const field of LIFECYCLE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = dateStr(body[field]);
      updates.push(`${field} = ?`);
      params.push(value);
      if ((file[field] || null) !== value) changed.push(field);
    }
    if (!updates.length) return { ok: true, changed: [] };
    await run(
      `UPDATE client_files SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`,
      ...params, now(), file.id
    );
    if (changed.length) {
      await activity(file.id, ctx.user, 'lifecycle_updated', `Key dates updated: ${changed.map((c) => c.replace(/_at$|_date$/, '').replace(/_/g, ' ')).join(', ')}`);
      await audit(ctx.user.id, 'lifecycle_updated', 'client_file', file.id, ctx.ip, { changed });
    }
    return { ok: true, changed };
  });

  // ======================= Subject property =======================

  router.put('/api/broker/files/:id/property', editFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const fields = {
      city: str(b.city, 120),
      province: pick(PROVINCES, str(b.province, 2).toUpperCase(), ''),
      postal_code: str(b.postal_code, 12).toUpperCase(),
      dwelling_type: str(b.dwelling_type, 60),
      dwelling_style: str(b.dwelling_style, 60),
      tenure: str(b.tenure, 40),
      occupancy: str(b.occupancy, 40),
      year_built: intOrNull(b.year_built),
      units: intOrNull(b.units),
      living_space_sqft: intOrNull(b.living_space_sqft),
      lot_size: str(b.lot_size, 60),
      heating_type: str(b.heating_type, 60),
      garage: str(b.garage, 60),
      mls_number: str(b.mls_number, 40),
      legal_description: str(b.legal_description, 500),
      zoning: str(b.zoning, 60),
      annual_taxes: num(b.annual_taxes),
      tax_year: intOrNull(b.tax_year),
      condo_fees_monthly: num(b.condo_fees_monthly),
      condo_fees_include_heat: bool(b.condo_fees_include_heat),
      heating_monthly: num(b.heating_monthly),
      hydro_monthly: num(b.hydro_monthly),
      water_monthly: num(b.water_monthly),
      other_expenses_monthly: num(b.other_expenses_monthly),
      rental_income_monthly: num(b.rental_income_monthly),
      rental_treatment: b.rental_treatment === 'add' ? 'add' : 'offset',
      rental_offset_pct: num(b.rental_offset_pct),
      estimated_value: num(b.estimated_value),
      appraisal_value: num(b.appraisal_value),
      appraisal_date: dateStr(b.appraisal_date),
    };

    const keys = Object.keys(fields);
    await run(
      `INSERT INTO file_properties (file_id, ${keys.join(', ')}, updated_by, updated_at)
       VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')},
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      file.id, ...keys.map((k) => fields[k]), ctx.user.id, now()
    );

    // The file's own province drives which provincial compliance documents
    // apply, so keep it in step with the property rather than asking twice.
    if (fields.province && fields.province !== file.province) {
      await run('UPDATE client_files SET province = ?, updated_at = ? WHERE id = ?', fields.province, now(), file.id);
    }
    await touchFile(file.id);
    await activity(file.id, ctx.user, 'property_updated', 'Subject property details updated');
    await audit(ctx.user.id, 'property_updated', 'client_file', file.id, ctx.ip);

    const deal = await loadDeal(await fileOrThrow(file.id));
    return { ok: true, property: deal.property, metrics: deal.metrics };
  });

  // ======================= Income =======================

  router.post('/api/broker/files/:id/incomes', editFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const applicantId = intOrNull(b.applicant_id);
    if (!applicantId) throw new ApiError(400, 'Income must be attached to an applicant.', 'missing_field');
    await applicantOnFile(file.id, applicantId);
    const id = await insert(
      `INSERT INTO applicant_incomes
         (file_id, applicant_id, kind, employer, job_title, description, amount, period, years_at_source, qualifies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id, applicantId, pick(INCOME_KINDS, b.kind, 'employment'),
      str(b.employer, 200), str(b.job_title, 200), str(b.description, 500),
      num(b.amount) || 0, pick(INCOME_PERIODS, b.period, 'annual'),
      num(b.years_at_source), b.qualifies === undefined ? 1 : bool(b.qualifies), now(), now()
    );
    await touchFile(file.id);
    await activity(file.id, ctx.user, 'income_added', `Income source added (${str(b.employer, 60) || pick(INCOME_KINDS, b.kind, 'employment').replace(/_/g, ' ')})`);
    const deal = await loadDeal(file);
    return { ok: true, id, metrics: deal.metrics };
  });

  router.patch('/api/broker/incomes/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('applicant_incomes', ctx.params.id, 'Income');
    const b = ctx.body || {};
    if (b.applicant_id !== undefined) await applicantOnFile(row.file_id, intOrNull(b.applicant_id));
    await run(
      `UPDATE applicant_incomes SET applicant_id = ?, kind = ?, employer = ?, job_title = ?, description = ?,
         amount = ?, period = ?, years_at_source = ?, qualifies = ?, updated_at = ?
       WHERE id = ?`,
      b.applicant_id !== undefined ? intOrNull(b.applicant_id) : row.applicant_id,
      b.kind !== undefined ? pick(INCOME_KINDS, b.kind, row.kind) : row.kind,
      b.employer !== undefined ? str(b.employer, 200) : row.employer,
      b.job_title !== undefined ? str(b.job_title, 200) : row.job_title,
      b.description !== undefined ? str(b.description, 500) : row.description,
      b.amount !== undefined ? (num(b.amount) || 0) : row.amount,
      b.period !== undefined ? pick(INCOME_PERIODS, b.period, row.period) : row.period,
      b.years_at_source !== undefined ? num(b.years_at_source) : row.years_at_source,
      b.qualifies !== undefined ? bool(b.qualifies) : row.qualifies,
      now(), row.id
    );
    await touchFile(row.file_id);
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  router.delete('/api/broker/incomes/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('applicant_incomes', ctx.params.id, 'Income');
    await run('DELETE FROM applicant_incomes WHERE id = ?', row.id);
    await activity(row.file_id, ctx.user, 'income_removed', 'Income source removed');
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  // ======================= Assets =======================

  router.post('/api/broker/files/:id/assets', editFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const applicantId = intOrNull(b.applicant_id);
    if (applicantId) await applicantOnFile(file.id, applicantId);
    const id = await insert(
      `INSERT INTO file_assets (file_id, applicant_id, kind, description, institution, value, down_payment_amount, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id, applicantId, pick(ASSET_KINDS, b.kind, 'savings'),
      str(b.description, 300), str(b.institution, 200), num(b.value) || 0,
      num(b.down_payment_amount), bool(b.verified), now(), now()
    );
    await touchFile(file.id);
    await activity(file.id, ctx.user, 'asset_added', `Asset added (${str(b.description, 60) || pick(ASSET_KINDS, b.kind, 'savings')})`);
    const deal = await loadDeal(file);
    return { ok: true, id, metrics: deal.metrics };
  });

  router.patch('/api/broker/assets/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('file_assets', ctx.params.id, 'Asset');
    const b = ctx.body || {};
    if (b.applicant_id) await applicantOnFile(row.file_id, intOrNull(b.applicant_id));
    await run(
      `UPDATE file_assets SET applicant_id = ?, kind = ?, description = ?, institution = ?, value = ?,
         down_payment_amount = ?, verified = ?, updated_at = ? WHERE id = ?`,
      b.applicant_id !== undefined ? intOrNull(b.applicant_id) : row.applicant_id,
      b.kind !== undefined ? pick(ASSET_KINDS, b.kind, row.kind) : row.kind,
      b.description !== undefined ? str(b.description, 300) : row.description,
      b.institution !== undefined ? str(b.institution, 200) : row.institution,
      b.value !== undefined ? (num(b.value) || 0) : row.value,
      b.down_payment_amount !== undefined ? num(b.down_payment_amount) : row.down_payment_amount,
      b.verified !== undefined ? bool(b.verified) : row.verified,
      now(), row.id
    );
    await touchFile(row.file_id);
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  router.delete('/api/broker/assets/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('file_assets', ctx.params.id, 'Asset');
    await run('DELETE FROM file_assets WHERE id = ?', row.id);
    await activity(row.file_id, ctx.user, 'asset_removed', 'Asset removed');
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  // ======================= Liabilities =======================

  router.post('/api/broker/files/:id/liabilities', editFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const applicantId = intOrNull(b.applicant_id);
    if (applicantId) await applicantOnFile(file.id, applicantId);
    const id = await insert(
      `INSERT INTO file_liabilities
         (file_id, applicant_id, kind, lender, description, credit_limit, balance, monthly_payment,
          from_bureau, include_in_tds, payoff_at_close, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id, applicantId, pick(LIABILITY_KINDS, b.kind, 'credit_card'),
      str(b.lender, 200), str(b.description, 300), num(b.credit_limit), num(b.balance) || 0,
      num(b.monthly_payment), bool(b.from_bureau),
      b.include_in_tds === undefined ? 1 : bool(b.include_in_tds), bool(b.payoff_at_close),
      now(), now()
    );
    await touchFile(file.id);
    await activity(file.id, ctx.user, 'liability_added', `Liability added (${str(b.lender, 60) || pick(LIABILITY_KINDS, b.kind, 'credit_card').replace(/_/g, ' ')})`);
    const deal = await loadDeal(file);
    return { ok: true, id, metrics: deal.metrics };
  });

  router.patch('/api/broker/liabilities/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('file_liabilities', ctx.params.id, 'Liability');
    const b = ctx.body || {};
    if (b.applicant_id) await applicantOnFile(row.file_id, intOrNull(b.applicant_id));
    await run(
      `UPDATE file_liabilities SET applicant_id = ?, kind = ?, lender = ?, description = ?, credit_limit = ?,
         balance = ?, monthly_payment = ?, from_bureau = ?, include_in_tds = ?, payoff_at_close = ?, updated_at = ?
       WHERE id = ?`,
      b.applicant_id !== undefined ? intOrNull(b.applicant_id) : row.applicant_id,
      b.kind !== undefined ? pick(LIABILITY_KINDS, b.kind, row.kind) : row.kind,
      b.lender !== undefined ? str(b.lender, 200) : row.lender,
      b.description !== undefined ? str(b.description, 300) : row.description,
      b.credit_limit !== undefined ? num(b.credit_limit) : row.credit_limit,
      b.balance !== undefined ? (num(b.balance) || 0) : row.balance,
      b.monthly_payment !== undefined ? num(b.monthly_payment) : row.monthly_payment,
      b.from_bureau !== undefined ? bool(b.from_bureau) : row.from_bureau,
      b.include_in_tds !== undefined ? bool(b.include_in_tds) : row.include_in_tds,
      b.payoff_at_close !== undefined ? bool(b.payoff_at_close) : row.payoff_at_close,
      now(), row.id
    );
    await touchFile(row.file_id);
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  router.delete('/api/broker/liabilities/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('file_liabilities', ctx.params.id, 'Liability');
    await run('DELETE FROM file_liabilities WHERE id = ?', row.id);
    await activity(row.file_id, ctx.user, 'liability_removed', 'Liability removed');
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, metrics: deal.metrics };
  });

  // ======================= Credit =======================

  router.patch('/api/broker/applicants/:id/credit', editFinancials, async (ctx) => {
    const applicant = await childOrThrow('applicants', ctx.params.id, 'Applicant');
    const b = ctx.body || {};
    const score = intOrNull(b.credit_score);
    if (score !== null && (score < 300 || score > 900)) {
      throw new ApiError(400, 'A Canadian credit score is between 300 and 900.', 'bad_value');
    }
    await run(
      'UPDATE applicants SET credit_score = ?, credit_bureau = ?, credit_pulled_at = ?, updated_at = ? WHERE id = ?',
      score,
      b.credit_bureau !== undefined ? str(b.credit_bureau, 40) : applicant.credit_bureau,
      b.credit_pulled_at !== undefined ? dateStr(b.credit_pulled_at) : applicant.credit_pulled_at,
      now(), applicant.id
    );
    await activity(applicant.file_id, ctx.user, 'credit_updated', `Credit details updated for ${fullName(applicant)}`);
    await audit(ctx.user.id, 'credit_updated', 'applicant', applicant.id, ctx.ip);
    return { ok: true };
  });

  /**
   * CASL consent. Its own endpoint rather than a field on the applicant form,
   * because Canadian anti-spam law wants to know when and how consent was
   * captured, and that trail should not be editable as a side effect of a
   * routine name correction.
   */
  router.post('/api/broker/applicants/:id/casl', requirePermission('clients.edit'), async (ctx) => {
    const applicant = await childOrThrow('applicants', ctx.params.id, 'Applicant');
    const consent = bool(ctx.body && ctx.body.consent);
    const source = str(ctx.body && ctx.body.source, 200) || 'Recorded by brokerage staff';
    await run(
      'UPDATE applicants SET casl_consent = ?, casl_consent_at = ?, casl_consent_source = ?, updated_at = ? WHERE id = ?',
      consent, consent ? now() : null, consent ? source : '', now(), applicant.id
    );
    await activity(
      applicant.file_id, ctx.user, 'casl_consent',
      consent
        ? `Marketing consent (CASL) recorded for ${fullName(applicant)} — ${source}`
        : `Marketing consent (CASL) withdrawn for ${fullName(applicant)}`
    );
    await audit(ctx.user.id, 'casl_consent_changed', 'applicant', applicant.id, ctx.ip, { consent });
    return { ok: true, casl_consent: consent === 1 };
  });

  // ======================= Mortgage requests =======================

  /** Copy the catalog product's terms onto a request, and remember the names. */
  async function applyProduct(fields, productId) {
    if (!productId) return fields;
    const product = await get(
      `SELECT p.*, l.name AS lender_name FROM lender_products p
         JOIN lenders l ON l.id = p.lender_id WHERE p.id = ?`,
      productId
    );
    if (!product) throw new ApiError(400, 'That lender product was not found.', 'bad_product');
    return {
      ...fields,
      lender_id: product.lender_id,
      product_id: product.id,
      // Snapshots, because a catalog rate changes and the file must still say
      // what was actually chosen on the day.
      lender_name_snapshot: product.lender_name,
      product_name_snapshot: product.name,
      contract_rate: fields.contract_rate ?? product.rate,
      rate_type: fields.rate_type || product.rate_type,
      term_months: fields.term_months || product.term_months,
      compounding: fields.compounding || product.compounding,
    };
  }

  router.post('/api/broker/files/:id/mortgage-requests', editFinancials, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const b = ctx.body || {};
    const existing = await all('SELECT id FROM mortgage_requests WHERE file_id = ?', file.id);
    if (existing.length >= 10) {
      throw new ApiError(400, 'A file can hold at most ten mortgage requests.', 'too_many');
    }

    let fields = {
      label: str(b.label, 120),
      position: pick(POSITIONS, b.position, 'first'),
      purpose: str(b.purpose, 120),
      status: pick(REQUEST_STATUSES, b.status, 'draft'),
      purchase_price: num(b.purchase_price) ?? file.purchase_price,
      property_value: num(b.property_value),
      down_payment: num(b.down_payment) ?? file.down_payment,
      down_payment_source: str(b.down_payment_source, 120),
      principal: num(b.principal) ?? file.mortgage_amount,
      insurance_premium: num(b.insurance_premium),
      contract_rate: num(b.contract_rate),
      rate_type: pick(RATE_TYPES, b.rate_type, 'fixed'),
      term_type: b.term_type === 'open' ? 'open' : 'closed',
      term_months: intOrNull(b.term_months) || 60,
      amortization_months: intOrNull(b.amortization_months) || 300,
      payment_frequency: pick(Object.keys(metrics.PAYMENTS_PER_YEAR), b.payment_frequency, 'monthly'),
      compounding: b.compounding === 'monthly' ? 'monthly' : 'semi_annual',
      interest_only: bool(b.interest_only),
      qualifying_rate: num(b.qualifying_rate),
      qualifying_amortization_months: intOrNull(b.qualifying_amortization_months),
      lender_id: null,
      product_id: null,
      lender_name_snapshot: str(b.lender_name, 200),
      product_name_snapshot: str(b.product_name, 200),
      notes: str(b.notes, 2000),
    };
    fields = await applyProduct(fields, intOrNull(b.product_id));

    const keys = Object.keys(fields);
    const id = await insert(
      `INSERT INTO mortgage_requests (file_id, ${keys.join(', ')}, is_primary, created_by, created_at, updated_at)
       VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
      file.id, ...keys.map((k) => fields[k]), existing.length === 0 ? 1 : 0, ctx.user.id, now(), now()
    );
    await touchFile(file.id);
    await activity(file.id, ctx.user, 'mortgage_request_added', `Mortgage request added (${fields.label || fields.position} position)`);
    await audit(ctx.user.id, 'mortgage_request_created', 'mortgage_request', id, ctx.ip);
    const deal = await loadDeal(file);
    return { ok: true, id, mortgage_requests: deal.requests, metrics: deal.metrics };
  });

  router.patch('/api/broker/mortgage-requests/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('mortgage_requests', ctx.params.id, 'Mortgage request');
    const b = ctx.body || {};
    const keep = (key, transform) => (b[key] !== undefined ? transform(b[key]) : row[key]);

    let fields = {
      label: keep('label', (v) => str(v, 120)),
      position: keep('position', (v) => pick(POSITIONS, v, row.position)),
      purpose: keep('purpose', (v) => str(v, 120)),
      status: keep('status', (v) => pick(REQUEST_STATUSES, v, row.status)),
      purchase_price: keep('purchase_price', num),
      property_value: keep('property_value', num),
      down_payment: keep('down_payment', num),
      down_payment_source: keep('down_payment_source', (v) => str(v, 120)),
      principal: keep('principal', num),
      insurance_premium: keep('insurance_premium', num),
      contract_rate: keep('contract_rate', num),
      rate_type: keep('rate_type', (v) => pick(RATE_TYPES, v, row.rate_type)),
      term_type: keep('term_type', (v) => (v === 'open' ? 'open' : 'closed')),
      term_months: keep('term_months', (v) => intOrNull(v) || row.term_months),
      amortization_months: keep('amortization_months', (v) => intOrNull(v) || row.amortization_months),
      payment_frequency: keep('payment_frequency', (v) => pick(Object.keys(metrics.PAYMENTS_PER_YEAR), v, row.payment_frequency)),
      compounding: keep('compounding', (v) => (v === 'monthly' ? 'monthly' : 'semi_annual')),
      interest_only: keep('interest_only', bool),
      qualifying_rate: keep('qualifying_rate', num),
      qualifying_amortization_months: keep('qualifying_amortization_months', intOrNull),
      lender_id: row.lender_id,
      product_id: row.product_id,
      // The request body names these `lender_name`/`product_name`, but the
      // column is the *snapshot* — read the body under one name and fall back
      // to the stored column under the other, never mixing them up.
      lender_name_snapshot: b.lender_name !== undefined ? str(b.lender_name, 200) : row.lender_name_snapshot,
      product_name_snapshot: b.product_name !== undefined ? str(b.product_name, 200) : row.product_name_snapshot,
      notes: keep('notes', (v) => str(v, 2000)),
    };
    if (b.product_id !== undefined) {
      const productId = intOrNull(b.product_id);
      fields = productId
        ? await applyProduct({ ...fields, contract_rate: b.contract_rate !== undefined ? num(b.contract_rate) : null }, productId)
        : { ...fields, lender_id: null, product_id: null };
    }

    const keys = Object.keys(fields);
    await run(
      `UPDATE mortgage_requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), now(), row.id
    );
    if (b.is_primary) {
      await run('UPDATE mortgage_requests SET is_primary = 0 WHERE file_id = ?', row.file_id);
      await run('UPDATE mortgage_requests SET is_primary = 1 WHERE id = ?', row.id);
    }
    if (fields.status !== row.status) {
      await activity(row.file_id, ctx.user, 'mortgage_request_updated', `Mortgage request marked ${fields.status}`);
      // A submitted or funded request is a lifecycle event; stamp the file's
      // date so the workflow engine can trigger off it without the broker
      // having to remember to type the same date twice.
      if (fields.status === 'submitted') {
        await run('UPDATE client_files SET submitted_at = COALESCE(submitted_at, ?) WHERE id = ?', new Date().toISOString().slice(0, 10), row.file_id);
      }
      if (fields.status === 'approved') {
        await run('UPDATE client_files SET approved_at = COALESCE(approved_at, ?) WHERE id = ?', new Date().toISOString().slice(0, 10), row.file_id);
      }
      if (fields.status === 'funded') {
        await run('UPDATE client_files SET funded_at = COALESCE(funded_at, ?) WHERE id = ?', new Date().toISOString().slice(0, 10), row.file_id);
      }
    }
    await touchFile(row.file_id);
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, mortgage_requests: deal.requests, metrics: deal.metrics };
  });

  router.delete('/api/broker/mortgage-requests/:id', editFinancials, async (ctx) => {
    const row = await childOrThrow('mortgage_requests', ctx.params.id, 'Mortgage request');
    if (row.status === 'funded') {
      throw new ApiError(400, 'A funded mortgage request is part of the permanent record and cannot be deleted.', 'funded_locked');
    }
    await run('DELETE FROM mortgage_requests WHERE id = ?', row.id);
    // Never leave a file with requests but no primary.
    if (row.is_primary === 1) {
      const next = await get('SELECT id FROM mortgage_requests WHERE file_id = ? ORDER BY id LIMIT 1', row.file_id);
      if (next) await run('UPDATE mortgage_requests SET is_primary = 1 WHERE id = ?', next.id);
    }
    await activity(row.file_id, ctx.user, 'mortgage_request_removed', 'Mortgage request removed');
    await audit(ctx.user.id, 'mortgage_request_deleted', 'mortgage_request', row.id, ctx.ip);
    const deal = await loadDeal(await fileOrThrow(row.file_id));
    return { ok: true, mortgage_requests: deal.requests, metrics: deal.metrics };
  });

  // ======================= AML / FINTRAC =======================

  router.get('/api/broker/files/:id/aml', viewAml, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const applicants = await all('SELECT * FROM applicants WHERE file_id = ? ORDER BY id', file.id);
    const assessment = await get('SELECT * FROM aml_assessments WHERE file_id = ?', file.id);
    const checks = await all('SELECT * FROM aml_borrower_checks WHERE file_id = ? ORDER BY applicant_id', file.id);

    return {
      summary: aml.summarize(assessment, checks, applicants),
      questions: aml.DEAL_QUESTIONS,
      borrower_questions: aml.BORROWER_QUESTIONS,
      id_methods: aml.ID_METHODS,
      sanction_sources: aml.SANCTION_SOURCES,
      sanction_statuses: aml.SANCTION_STATUSES,
      borrowers: applicants.map((a) => {
        const check = checks.find((c) => c.applicant_id === a.id) || null;
        return {
          applicant_id: a.id,
          name: fullName(a),
          role: a.role,
          check: check ? { ...check, answers: parseJsonSafe(check.answers, {}) } : null,
        };
      }),
      can_manage: await hasPermission(ctx.user, 'aml.manage'),
    };
  });

  router.put('/api/broker/files/:id/aml', manageAml, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const incoming = (ctx.body && ctx.body.answers) || {};

    // Only known keys are stored, so a typo cannot quietly become a new
    // "question" that nothing ever asks about again.
    const allowed = new Set([...aml.dealQuestionKeys(), 'third_party_details', 'beneficial_owner_details', 'notes']);
    const answers = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key)) continue;
      answers[key] = typeof value === 'string' ? str(value, 2000) : (value === true || value === false ? value : str(value, 20));
    }

    const checks = await all('SELECT * FROM aml_borrower_checks WHERE file_id = ?', file.id);
    const applicants = await all('SELECT * FROM applicants WHERE file_id = ?', file.id);
    const risk = aml.assessRisk(answers, checks);
    const gaps = aml.outstanding({ answers: JSON.stringify(answers) }, checks, applicants);
    const status = gaps.length === 0 ? 'complete' : 'in_progress';

    await run(
      `INSERT INTO aml_assessments (file_id, answers, status, risk_level, risk_score, completed_at, completed_by, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET answers = EXCLUDED.answers, status = EXCLUDED.status,
         risk_level = EXCLUDED.risk_level, risk_score = EXCLUDED.risk_score,
         completed_at = EXCLUDED.completed_at, completed_by = EXCLUDED.completed_by,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      file.id, JSON.stringify(answers), status, risk.risk_level, risk.risk_score,
      status === 'complete' ? now() : null, status === 'complete' ? ctx.user.id : null,
      ctx.user.id, now()
    );
    await activity(file.id, ctx.user, 'aml_updated', `AML risk assessment updated — risk assessed as ${risk.risk_level}`);
    await audit(ctx.user.id, 'aml_assessment_updated', 'client_file', file.id, ctx.ip, { risk_level: risk.risk_level, status });

    const assessment = await get('SELECT * FROM aml_assessments WHERE file_id = ?', file.id);
    return { ok: true, summary: aml.summarize(assessment, checks, applicants) };
  });

  router.put('/api/broker/files/:id/aml/borrowers/:applicantId', manageAml, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const applicant = await applicantOnFile(file.id, idParam(ctx.params.applicantId));
    const b = ctx.body || {};
    const existing = await get('SELECT * FROM aml_borrower_checks WHERE file_id = ? AND applicant_id = ?', file.id, applicant.id);

    const answers = {};
    for (const q of aml.BORROWER_QUESTIONS) {
      const value = (b.answers || {})[q.key];
      if (value !== undefined) answers[q.key] = value === true || value === 'yes' || value === 1;
    }
    const merged = existing ? { ...parseJsonSafe(existing.answers, {}), ...answers } : answers;

    const sanctionStatus = pick(aml.SANCTION_STATUSES, b.sanction_status, existing ? existing.sanction_status : 'not_screened');
    const screeningChanged = !existing || sanctionStatus !== existing.sanction_status;
    const idVerified = b.id_verified === undefined
      ? (existing ? existing.id_verified_at : null)
      : (bool(b.id_verified) ? (existing && existing.id_verified_at ? existing.id_verified_at : now()) : null);

    const fields = {
      id_method: b.id_method !== undefined ? str(b.id_method, 60) : (existing ? existing.id_method : ''),
      id_document_primary: b.id_document_primary !== undefined ? str(b.id_document_primary, 200) : (existing ? existing.id_document_primary : ''),
      id_document_secondary: b.id_document_secondary !== undefined ? str(b.id_document_secondary, 200) : (existing ? existing.id_document_secondary : ''),
      id_verified_at: idVerified,
      id_verified_by: idVerified ? ctx.user.id : null,
      pep_foreign: b.pep_foreign !== undefined ? bool(b.pep_foreign) : (existing ? existing.pep_foreign : 0),
      pep_domestic: b.pep_domestic !== undefined ? bool(b.pep_domestic) : (existing ? existing.pep_domestic : 0),
      pep_hio: b.pep_hio !== undefined ? bool(b.pep_hio) : (existing ? existing.pep_hio : 0),
      pep_relationship: b.pep_relationship !== undefined
        ? pick(['self', 'family', 'close_associate', ''], str(b.pep_relationship, 30), '')
        : (existing ? existing.pep_relationship : ''),
      pep_details: b.pep_details !== undefined ? str(b.pep_details, 1000) : (existing ? existing.pep_details : ''),
      sanction_status: sanctionStatus,
      sanction_sources: b.sanction_sources !== undefined
        ? (Array.isArray(b.sanction_sources) ? b.sanction_sources : [])
            .filter((s) => aml.SANCTION_SOURCES.some(([key]) => key === s)).join(',')
        : (existing ? existing.sanction_sources : ''),
      sanction_screened_at: screeningChanged && sanctionStatus !== 'not_screened' ? now() : (existing ? existing.sanction_screened_at : null),
      sanction_screened_by: screeningChanged && sanctionStatus !== 'not_screened' ? ctx.user.id : (existing ? existing.sanction_screened_by : null),
      sanction_note: b.sanction_note !== undefined ? str(b.sanction_note, 1000) : (existing ? existing.sanction_note : ''),
      answers: JSON.stringify(merged),
    };

    const keys = Object.keys(fields);
    await run(
      `INSERT INTO aml_borrower_checks (file_id, applicant_id, ${keys.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?)
       ON CONFLICT (file_id, applicant_id) DO UPDATE SET
         ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = EXCLUDED.updated_at`,
      file.id, applicant.id, ...keys.map((k) => fields[k]), now(), now()
    );

    if (screeningChanged && sanctionStatus !== 'not_screened') {
      await activity(file.id, ctx.user, 'aml_screening', `Sanction screening for ${fullName(applicant)} recorded as "${sanctionStatus.replace('_', ' ')}"`);
      await audit(ctx.user.id, 'aml_screening_recorded', 'applicant', applicant.id, ctx.ip, { status: sanctionStatus });
    }

    // Re-derive the file's risk level: a borrower-level PEP or a screening
    // match changes the deal's risk, not just that borrower's row.
    const checks = await all('SELECT * FROM aml_borrower_checks WHERE file_id = ?', file.id);
    const applicants = await all('SELECT * FROM applicants WHERE file_id = ?', file.id);
    const assessment = await get('SELECT * FROM aml_assessments WHERE file_id = ?', file.id);
    const dealAnswers = assessment ? parseJsonSafe(assessment.answers, {}) : {};
    const risk = aml.assessRisk(dealAnswers, checks);
    const gaps = aml.outstanding(assessment || { answers: '{}' }, checks, applicants);
    await run(
      `INSERT INTO aml_assessments (file_id, answers, status, risk_level, risk_score, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET status = EXCLUDED.status, risk_level = EXCLUDED.risk_level,
         risk_score = EXCLUDED.risk_score, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      file.id, JSON.stringify(dealAnswers), gaps.length === 0 ? 'complete' : 'in_progress',
      risk.risk_level, risk.risk_score, ctx.user.id, now()
    );

    const refreshed = await get('SELECT * FROM aml_assessments WHERE file_id = ?', file.id);
    return { ok: true, summary: aml.summarize(refreshed, checks, applicants) };
  });

  // ======================= Lender / product catalog =======================

  router.get('/api/broker/lenders', viewLenders, async (ctx) => {
    const includeInactive = ctx.query.all === '1';
    const lenders = await all(
      `SELECT * FROM lenders ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`
    );
    const products = await all(
      `SELECT * FROM lender_products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY rate, name`
    );
    const byLender = new Map();
    for (const p of products) {
      if (!byLender.has(p.lender_id)) byLender.set(p.lender_id, []);
      byLender.get(p.lender_id).push(p);
    }
    return {
      lenders: lenders.map((l) => ({ ...l, products: byLender.get(l.id) || [] })),
      can_manage: await hasPermission(ctx.user, 'lenders.manage'),
    };
  });

  /**
   * Products that fit a specific file.
   *
   * Pre-filtered from the deal's own data — province, LTV, purpose, credit
   * score — because making a broker re-key what is already on the file is
   * exactly the friction that pushes rate shopping into a spreadsheet.
   */
  router.get('/api/broker/files/:id/products', viewLenders, async (ctx) => {
    const file = await fileOrThrow(ctx.params.id);
    const deal = await loadDeal(file);
    const applicants = await all('SELECT credit_score FROM applicants WHERE file_id = ?', file.id);
    const scores = applicants.map((a) => a.credit_score).filter((s) => s !== null && s !== undefined);
    const lowestScore = scores.length ? Math.min(...scores) : null;
    const ltv = deal.metrics.ratios.ltv;
    const province = file.province || (deal.property && deal.property.province) || '';
    const occupancy = deal.property ? deal.property.occupancy : '';
    const appType = file.application_type_id
      ? await get('SELECT key FROM application_types WHERE id = ?', file.application_type_id)
      : null;
    const purpose = appType ? appType.key : '';

    const rows = await all(
      `SELECT p.*, l.name AS lender_name, l.kind AS lender_kind
         FROM lender_products p JOIN lenders l ON l.id = p.lender_id
        WHERE p.active = 1 AND l.active = 1
        ORDER BY p.rate, l.name`
    );

    const csvHas = (csv, value) => {
      const list = String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
      return list.length === 0 || (value && list.includes(value));
    };

    const matched = [];
    const excluded = [];
    for (const p of rows) {
      const reasons = [];
      if (!csvHas(p.eligible_provinces, province)) reasons.push(province ? `not available in ${province}` : 'province not set on the file');
      if (!csvHas(p.eligible_purposes, purpose)) reasons.push('application purpose not eligible');
      if (!csvHas(p.eligible_occupancy, occupancy)) reasons.push('occupancy not eligible');
      if (p.max_ltv !== null && ltv !== null && ltv > Number(p.max_ltv)) reasons.push(`LTV ${ltv}% exceeds the ${p.max_ltv}% maximum`);
      if (p.min_credit_score !== null && lowestScore !== null && lowestScore < p.min_credit_score) {
        reasons.push(`credit score ${lowestScore} is below the ${p.min_credit_score} minimum`);
      }
      const principal = deal.metrics.mortgage.principal || 0;
      const entry = {
        ...p,
        estimated_payment: principal
          ? metrics.payment({
              principal,
              annualRatePct: p.rate,
              amortizationMonths: Math.min(deal.metrics.mortgage.amortization_months, p.max_amortization_months || 300),
              frequency: deal.metrics.mortgage.payment_frequency,
              compounding: p.compounding,
            })
          : null,
      };
      if (reasons.length) excluded.push({ ...entry, reasons });
      else matched.push(entry);
    }

    return {
      criteria: { province, purpose, occupancy, ltv, lowest_credit_score: lowestScore, principal: deal.metrics.mortgage.principal },
      matched,
      excluded,
    };
  });

  router.post('/api/broker/lenders', manageLenders, async (ctx) => {
    const b = ctx.body || {};
    const name = str(b.name, 200);
    if (!name) throw new ApiError(400, 'The lender needs a name.', 'missing_field');
    const maxSort = await get('SELECT MAX(sort) AS m FROM lenders');
    const id = await insert(
      `INSERT INTO lenders (name, kind, contact_name, contact_email, contact_phone, portal_url, notes, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      name, pick(['prime', 'alternative', 'private'], b.kind, 'prime'),
      str(b.contact_name, 200), str(b.contact_email, 200), str(b.contact_phone, 40),
      str(b.portal_url, 400), str(b.notes, 2000), ((maxSort && maxSort.m) || 0) + 10, now(), now()
    );
    await audit(ctx.user.id, 'lender_created', 'lender', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/broker/lenders/:id', manageLenders, async (ctx) => {
    const row = await childOrThrow('lenders', ctx.params.id, 'Lender');
    const b = ctx.body || {};
    await run(
      `UPDATE lenders SET name = ?, kind = ?, contact_name = ?, contact_email = ?, contact_phone = ?,
         portal_url = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`,
      b.name !== undefined ? (str(b.name, 200) || row.name) : row.name,
      b.kind !== undefined ? pick(['prime', 'alternative', 'private'], b.kind, row.kind) : row.kind,
      b.contact_name !== undefined ? str(b.contact_name, 200) : row.contact_name,
      b.contact_email !== undefined ? str(b.contact_email, 200) : row.contact_email,
      b.contact_phone !== undefined ? str(b.contact_phone, 40) : row.contact_phone,
      b.portal_url !== undefined ? str(b.portal_url, 400) : row.portal_url,
      b.notes !== undefined ? str(b.notes, 2000) : row.notes,
      b.active !== undefined ? bool(b.active) : row.active,
      now(), row.id
    );
    await audit(ctx.user.id, 'lender_updated', 'lender', row.id, ctx.ip);
    return { ok: true };
  });

  router.post('/api/broker/lenders/:id/products', manageLenders, async (ctx) => {
    const lender = await childOrThrow('lenders', ctx.params.id, 'Lender');
    const b = ctx.body || {};
    const name = str(b.name, 200);
    if (!name) throw new ApiError(400, 'The product needs a name.', 'missing_field');
    const rate = num(b.rate);
    if (rate === null || rate < 0 || rate > 30) {
      throw new ApiError(400, 'The rate must be a percentage between 0 and 30.', 'bad_value');
    }
    const id = await insert(
      `INSERT INTO lender_products
         (lender_id, name, rate, rate_type, term_months, max_amortization_months, compounding, insurability,
          max_ltv, min_credit_score, eligible_provinces, eligible_purposes, eligible_occupancy,
          finder_fee_bps, rate_hold_days, prepayment, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      lender.id, name, rate, pick(RATE_TYPES, b.rate_type, 'fixed'),
      intOrNull(b.term_months) || 60, intOrNull(b.max_amortization_months) || 300,
      b.compounding === 'monthly' ? 'monthly' : 'semi_annual',
      pick(['any', 'insured', 'insurable', 'uninsurable'], b.insurability, 'any'),
      num(b.max_ltv), intOrNull(b.min_credit_score),
      str(b.eligible_provinces, 120).toUpperCase(), str(b.eligible_purposes, 300),
      str(b.eligible_occupancy, 200), intOrNull(b.finder_fee_bps), intOrNull(b.rate_hold_days),
      str(b.prepayment, 300), str(b.notes, 2000), now(), now()
    );
    await audit(ctx.user.id, 'lender_product_created', 'lender_product', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/broker/products/:id', manageLenders, async (ctx) => {
    const row = await childOrThrow('lender_products', ctx.params.id, 'Product');
    const b = ctx.body || {};
    if (b.rate !== undefined) {
      const rate = num(b.rate);
      if (rate === null || rate < 0 || rate > 30) {
        throw new ApiError(400, 'The rate must be a percentage between 0 and 30.', 'bad_value');
      }
    }
    await run(
      `UPDATE lender_products SET name = ?, rate = ?, rate_type = ?, term_months = ?, max_amortization_months = ?,
         compounding = ?, insurability = ?, max_ltv = ?, min_credit_score = ?, eligible_provinces = ?,
         eligible_purposes = ?, eligible_occupancy = ?, finder_fee_bps = ?, rate_hold_days = ?,
         prepayment = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`,
      b.name !== undefined ? (str(b.name, 200) || row.name) : row.name,
      b.rate !== undefined ? num(b.rate) : row.rate,
      b.rate_type !== undefined ? pick(RATE_TYPES, b.rate_type, row.rate_type) : row.rate_type,
      b.term_months !== undefined ? (intOrNull(b.term_months) || row.term_months) : row.term_months,
      b.max_amortization_months !== undefined ? (intOrNull(b.max_amortization_months) || row.max_amortization_months) : row.max_amortization_months,
      b.compounding !== undefined ? (b.compounding === 'monthly' ? 'monthly' : 'semi_annual') : row.compounding,
      b.insurability !== undefined ? pick(['any', 'insured', 'insurable', 'uninsurable'], b.insurability, row.insurability) : row.insurability,
      b.max_ltv !== undefined ? num(b.max_ltv) : row.max_ltv,
      b.min_credit_score !== undefined ? intOrNull(b.min_credit_score) : row.min_credit_score,
      b.eligible_provinces !== undefined ? str(b.eligible_provinces, 120).toUpperCase() : row.eligible_provinces,
      b.eligible_purposes !== undefined ? str(b.eligible_purposes, 300) : row.eligible_purposes,
      b.eligible_occupancy !== undefined ? str(b.eligible_occupancy, 200) : row.eligible_occupancy,
      b.finder_fee_bps !== undefined ? intOrNull(b.finder_fee_bps) : row.finder_fee_bps,
      b.rate_hold_days !== undefined ? intOrNull(b.rate_hold_days) : row.rate_hold_days,
      b.prepayment !== undefined ? str(b.prepayment, 300) : row.prepayment,
      b.notes !== undefined ? str(b.notes, 2000) : row.notes,
      b.active !== undefined ? bool(b.active) : row.active,
      now(), row.id
    );
    await audit(ctx.user.id, 'lender_product_updated', 'lender_product', row.id, ctx.ip);
    return { ok: true };
  });

  router.delete('/api/broker/products/:id', manageLenders, async (ctx) => {
    const row = await childOrThrow('lender_products', ctx.params.id, 'Product');
    // Deactivate rather than delete: a funded file's snapshot must keep
    // pointing at something.
    await run('UPDATE lender_products SET active = 0, updated_at = ? WHERE id = ?', now(), row.id);
    await audit(ctx.user.id, 'lender_product_retired', 'lender_product', row.id, ctx.ip);
    return { ok: true };
  });

  // ======================= Pipeline board =======================

  /**
   * The pipeline, grouped by stage.
   *
   * Each column is capped and reports its own total, so a brokerage with two
   * thousand active files gets a usable board instead of a browser that
   * renders for nine seconds.
   */
  router.get('/api/broker/pipeline', requirePermission('clients.view'), async (ctx) => {
    const mine = ctx.query.mine === '1' ? ctx.user.id : null;
    const scope = mine ? 'AND f.assigned_broker_id = ?' : '';
    const scopeParams = mine ? [mine] : [];
    const perColumn = Math.min(50, Math.max(5, intOrNull(ctx.query.limit) || 20));

    const stages = await all('SELECT * FROM stages WHERE active = 1 ORDER BY sort');
    const totals = await all(
      `SELECT f.stage_id, COUNT(*)::int AS n, COALESCE(SUM(f.mortgage_amount), 0)::numeric AS volume
         FROM client_files f WHERE f.status = 'active' ${scope} GROUP BY f.stage_id`,
      ...scopeParams
    );
    const totalById = new Map(totals.map((t) => [t.stage_id, t]));

    // One windowed query for the whole board rather than one per column.
    const rows = await all(
      `WITH ranked AS (
         SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.stage_id ORDER BY COALESCE(f.last_activity_at, f.updated_at) DESC) AS rn
           FROM client_files f WHERE f.status = 'active' ${scope}
       )
       SELECT * FROM ranked WHERE rn <= ?`,
      ...scopeParams, perColumn
    );

    const applicantRows = rows.length
      ? await all(
          `SELECT file_id, first_name, last_name, preferred_name, role FROM applicants
            WHERE file_id = ANY(?::int[]) ORDER BY file_id, id`,
          rows.map((r) => r.id)
        )
      : [];
    const nameByFile = new Map();
    for (const a of applicantRows) {
      if (!nameByFile.has(a.file_id)) nameByFile.set(a.file_id, fullName(a));
    }

    const counts = rows.length
      ? await all(
          `SELECT r.file_id,
             COUNT(*) FILTER (WHERE r.status IN ('uploaded','under_review'))::int AS to_review,
             COUNT(*) FILTER (WHERE r.requirement = 'required'
               AND r.status IN ('required','rejected','replacement_requested','expired'))::int AS outstanding
           FROM document_requests r WHERE r.file_id = ANY(?::int[]) GROUP BY r.file_id`,
          rows.map((r) => r.id)
        )
      : [];
    const countByFile = new Map(counts.map((c) => [c.file_id, c]));
    const fileMetrics = await metricsForFiles(rows);

    const columns = stages.map((stage) => {
      const total = totalById.get(stage.id);
      return {
        stage: { id: stage.id, key: stage.key, name: stage.name, color: stage.color, is_terminal: stage.is_terminal === 1 },
        total: total ? total.n : 0,
        volume: total ? Number(total.volume) : 0,
        cards: rows
          .filter((r) => r.stage_id === stage.id)
          .map((r) => ({
            id: r.id,
            file_number: r.file_number,
            client_name: nameByFile.get(r.id) || '(no applicant)',
            mortgage_amount: r.mortgage_amount,
            closing_date: r.closing_date,
            last_activity_at: r.last_activity_at || r.updated_at,
            to_review: (countByFile.get(r.id) || {}).to_review || 0,
            outstanding: (countByFile.get(r.id) || {}).outstanding || 0,
            metrics: fileMetrics.get(r.id) || null,
          })),
      };
    });

    const unstaged = rows.filter((r) => !r.stage_id);
    if (unstaged.length) {
      columns.unshift({
        stage: { id: null, key: '', name: 'No stage', color: '#94a3b8', is_terminal: false },
        total: unstaged.length,
        volume: 0,
        cards: unstaged.map((r) => ({
          id: r.id, file_number: r.file_number, client_name: nameByFile.get(r.id) || '(no applicant)',
          mortgage_amount: r.mortgage_amount, closing_date: r.closing_date,
          last_activity_at: r.last_activity_at || r.updated_at,
          to_review: 0, outstanding: 0, metrics: fileMetrics.get(r.id) || null,
        })),
      });
    }

    return { columns, per_column: perColumn };
  });

  // ======================= Relationship reports =======================

  /**
   * The six "one-touch" reports: the cheap, high-value ones that turn a
   * document tracker into a book of business. Each is a window over data the
   * platform already holds, so none of them needs a new table.
   */
  router.get('/api/broker/reports/relationships', requirePermission('reports.view'), async (ctx) => {
    const kind = str(ctx.query.kind, 40) || 'maturities';
    const days = Math.min(730, Math.max(1, intOrNull(ctx.query.days) || 0));
    const mine = ctx.query.mine === '1' ? ctx.user.id : null;
    const scope = mine ? 'AND f.assigned_broker_id = ?' : '';
    const scopeParams = mine ? [mine] : [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const horizon = (n) => {
      const d = new Date(`${todayStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };

    if (kind === 'birthdays' || kind === 'anniversaries') {
      const window = days || 30;
      // Month/day comparison, so the year on file never matters. Done in SQL
      // with to_char so it stays a single indexed-scan-friendly pass.
      const column = kind === 'birthdays' ? 'a.dob' : 'f.funded_at';
      const rows = await all(
        `SELECT f.id AS file_id, f.file_number, f.status, a.first_name, a.last_name, a.email, a.phone,
                ${column} AS on_date
           FROM applicants a JOIN client_files f ON f.id = a.file_id
          WHERE ${column} IS NOT NULL AND ${column} <> '' ${scope}
          ORDER BY substring(${column} from 6 for 5)`,
        ...scopeParams
      );
      const inWindow = rows.filter((r) => {
        const md = String(r.on_date).slice(5, 10);
        for (let i = 0; i <= window; i++) {
          if (horizon(i).slice(5, 10) === md) return true;
        }
        return false;
      });
      return { kind, days: window, count: inWindow.length, rows: inWindow };
    }

    const dateColumn = {
      maturities: 'f.maturity_date',
      rate_expiries: 'f.rate_hold_expires_at',
      closings: 'f.closing_date',
      conditions_due: 'f.conditions_due_date',
    }[kind];

    if (!dateColumn) throw new ApiError(400, 'Unknown report.', 'bad_report');

    const window = days || (kind === 'maturities' ? 180 : kind === 'rate_expiries' ? 120 : 45);
    const rows = await all(
      `SELECT f.id AS file_id, f.file_number, f.status, f.mortgage_amount, ${dateColumn} AS on_date,
              s.name AS stage_name, s.color AS stage_color,
              (SELECT a.first_name || ' ' || a.last_name FROM applicants a
                WHERE a.file_id = f.id ORDER BY (a.role = 'primary') DESC, a.id LIMIT 1) AS client_name,
              u.first_name || ' ' || u.last_name AS broker_name
         FROM client_files f
         LEFT JOIN stages s ON s.id = f.stage_id
         LEFT JOIN users u ON u.id = f.assigned_broker_id
        WHERE ${dateColumn} IS NOT NULL AND ${dateColumn} >= ? AND ${dateColumn} <= ? ${scope}
        ORDER BY ${dateColumn}
        LIMIT 500`,
      todayStr, horizon(window), ...scopeParams
    );
    return { kind, days: window, count: rows.length, rows };
  });

  // ======================= Workflow rules =======================

  router.get('/api/broker/workflows', requirePermission('clients.view'), async () => ({
    rules: await all('SELECT * FROM workflow_rules ORDER BY id'),
    triggers: workflows.TRIGGERS,
    actions: workflows.ACTIONS,
    assignees: workflows.ASSIGNEES,
    stages: await all('SELECT key, name FROM stages WHERE active = 1 ORDER BY sort'),
    templates: await all('SELECT key, name FROM email_templates WHERE active = 1 ORDER BY name'),
    client_email_enabled: (await getSetting('automation', {})).workflow_client_email === true,
  }));

  function workflowFields(b, existing) {
    const trigger = str(b.trigger_field, 40);
    if (!workflows.TRIGGER_FIELDS.includes(trigger)) {
      throw new ApiError(400, 'Choose a trigger date this rule fires from.', 'bad_trigger');
    }
    const offset = Math.abs(intOrNull(b.offset_days) || 0);
    if (offset > 365) throw new ApiError(400, 'The offset must be within a year of the trigger date.', 'bad_value');
    return {
      name: str(b.name, 200) || (existing ? existing.name : ''),
      active: b.active === undefined ? (existing ? existing.active : 1) : bool(b.active),
      stage_key: str(b.stage_key, 60),
      trigger_field: trigger,
      offset_days: offset,
      offset_direction: b.offset_direction === 'before' ? 'before' : 'after',
      action: pick(workflows.ACTIONS, b.action, 'task'),
      task_title: str(b.task_title, 200),
      task_description: str(b.task_description, 2000),
      task_priority: pick(['low', 'normal', 'high'], b.task_priority, 'normal'),
      assignee: pick(workflows.ASSIGNEES.map(([k]) => k), b.assignee, 'assigned_broker'),
      email_template_key: str(b.email_template_key, 60) || null,
    };
  }

  router.post('/api/broker/workflows', manageSettings, async (ctx) => {
    const fields = workflowFields(ctx.body || {}, null);
    if (!fields.name) throw new ApiError(400, 'The rule needs a name.', 'missing_field');
    if (fields.action === 'task' && !fields.task_title) fields.task_title = fields.name;
    const keys = Object.keys(fields);
    const id = await insert(
      `INSERT INTO workflow_rules (${keys.join(', ')}, created_by, created_at, updated_at)
       VALUES (${keys.map(() => '?').join(', ')}, ?, ?, ?)`,
      ...keys.map((k) => fields[k]), ctx.user.id, now(), now()
    );
    await audit(ctx.user.id, 'workflow_created', 'workflow_rule', id, ctx.ip);
    return { ok: true, id };
  });

  router.patch('/api/broker/workflows/:id', manageSettings, async (ctx) => {
    const row = await childOrThrow('workflow_rules', ctx.params.id, 'Workflow rule');
    const fields = workflowFields({ ...row, ...(ctx.body || {}) }, row);
    const keys = Object.keys(fields);
    await run(
      `UPDATE workflow_rules SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), now(), row.id
    );
    await audit(ctx.user.id, 'workflow_updated', 'workflow_rule', row.id, ctx.ip);
    return { ok: true };
  });

  router.delete('/api/broker/workflows/:id', manageSettings, async (ctx) => {
    const row = await childOrThrow('workflow_rules', ctx.params.id, 'Workflow rule');
    await run('DELETE FROM workflow_rules WHERE id = ?', row.id);
    await audit(ctx.user.id, 'workflow_deleted', 'workflow_rule', row.id, ctx.ip);
    return { ok: true };
  });

  /** What would fire today, without firing it. */
  router.get('/api/broker/workflows/preview', manageSettings, async (ctx) => {
    const result = await workflows.runWorkflowPass({ asOf: dateStr(ctx.query.as_of), dryRun: true });
    return result;
  });
}

module.exports = { register, metricsForFiles, loadDeal };
