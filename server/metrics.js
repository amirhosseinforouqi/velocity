'use strict';

/**
 * Mortgage qualification arithmetic.
 *
 * Everything in this file is a pure function of plain numbers and plain rows.
 * That is deliberate: GDS/TDS/LTV are the numbers a lender declines a client
 * over and a regulator asks about later, so they are computed on demand from
 * the underlying records and never stored as editable fields. If a broker
 * changes an income row, the ratios change; there is no second copy to drift.
 *
 * The Canadian specifics that are easy to get wrong, and are therefore
 * spelled out rather than folded into a magic constant:
 *
 *  - Fixed-rate mortgages here compound SEMI-ANNUALLY, not in advance. The
 *    monthly periodic rate is (1 + annual/2)^(1/6) - 1, not annual/12. On a
 *    $600k mortgage the difference is roughly $90 a month, which is the
 *    difference between qualifying and not.
 *  - The stress test qualifies at the greater of the contract rate plus a
 *    buffer and a benchmark floor. Both are brokerage-configurable because
 *    the published numbers move; the defaults are the long-standing 2.00%
 *    buffer and 5.25% floor.
 *  - GDS counts heat, and counts only HALF of condo fees.
 *  - Rental income is either an offset against the property's own expenses or
 *    an addition to income; which one a lender uses changes the ratio, so it
 *    is a per-file choice rather than a house rule.
 */

const DEFAULT_STRESS_TEST = {
  buffer_pct: 2.0,
  floor_rate: 5.25,
  gds_limit: 39,
  tds_limit: 44,
};

const PAYMENTS_PER_YEAR = {
  monthly: 12,
  semi_monthly: 24,
  biweekly: 26,
  accelerated_biweekly: 26,
  weekly: 52,
  accelerated_weekly: 52,
};

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * The periodic interest rate for one payment period.
 *
 * @param {number} annualRatePct e.g. 4.89 for 4.89%
 * @param {string} compounding   'semi_annual' (Canadian default) or 'monthly'
 * @param {number} periodsPerYear
 */
function periodicRate(annualRatePct, compounding, periodsPerYear) {
  const rate = n(annualRatePct) / 100;
  if (rate <= 0) return 0;
  if (compounding === 'monthly') return rate / periodsPerYear;
  // Semi-annual compounding: find the equivalent effective rate per period.
  return Math.pow(1 + rate / 2, 2 / periodsPerYear) - 1;
}

/**
 * Level payment that amortizes `principal` over `amortizationMonths`.
 *
 * Accelerated frequencies are not a different amortization — they are the
 * monthly payment cut in half (or quarters) and paid more often, which is
 * exactly why they pay a mortgage off early. Modelling them any other way
 * produces a payment that no lender would recognise.
 */
function payment({
  principal,
  annualRatePct,
  amortizationMonths,
  frequency = 'monthly',
  compounding = 'semi_annual',
  interestOnly = false,
}) {
  const p = n(principal);
  if (p <= 0) return 0;

  const accelerated = frequency === 'accelerated_biweekly' || frequency === 'accelerated_weekly';
  const periodsPerYear = PAYMENTS_PER_YEAR[frequency] || 12;

  if (interestOnly) {
    const i = periodicRate(annualRatePct, compounding, accelerated ? 12 : periodsPerYear);
    const base = p * i;
    if (frequency === 'accelerated_biweekly') return round2(base / 2);
    if (frequency === 'accelerated_weekly') return round2(base / 4);
    return round2(base);
  }

  // Accelerated payments derive from the monthly payment, so compute that first.
  const calcPeriods = accelerated ? 12 : periodsPerYear;
  const months = Math.max(1, n(amortizationMonths) || 300);
  const nPeriods = Math.round((months / 12) * calcPeriods);
  const i = periodicRate(annualRatePct, compounding, calcPeriods);

  const base = i === 0 ? p / nPeriods : (p * i) / (1 - Math.pow(1 + i, -nPeriods));
  if (frequency === 'accelerated_biweekly') return round2(base / 2);
  if (frequency === 'accelerated_weekly') return round2(base / 4);
  return round2(base);
}

/** Normalize any payment frequency to a monthly figure, for ratio purposes. */
function toMonthly(amount, frequency = 'monthly') {
  const periods = PAYMENTS_PER_YEAR[frequency] || 12;
  return round2((n(amount) * periods) / 12);
}

/**
 * CMHC-style default-insurance premium, as a percentage of the loan, by LTV
 * band. Used only as a *suggestion* in the UI — the broker can always
 * override the stored premium, because programme rules vary by insurer and by
 * property type.
 */
function insurancePremiumRate(ltvPct) {
  const ltv = n(ltvPct);
  if (ltv <= 65) return 0.6;
  if (ltv <= 75) return 1.7;
  if (ltv <= 80) return 2.4;
  if (ltv <= 85) return 2.8;
  if (ltv <= 90) return 3.1;
  if (ltv <= 95) return 4.0;
  return 0; // Above 95% is not insurable; the caller surfaces that as a warning.
}

/** Annualize one income row to a monthly figure. */
function monthlyIncome(row) {
  const amount = n(row.amount);
  switch (row.period) {
    case 'monthly': return amount;
    case 'semi_monthly': return amount * 24 / 12;
    case 'biweekly': return amount * 26 / 12;
    case 'weekly': return amount * 52 / 12;
    case 'hourly': return 0; // needs hours; carried on file but never assumed
    case 'annual':
    default: return amount / 12;
  }
}

/**
 * The subject property's monthly carrying costs, split the way GDS needs them.
 *
 * Heat is included whether it is entered directly or bundled into condo fees.
 * Only half of condo fees count, which is the long-standing insurer treatment.
 */
function propertyCosts(property) {
  const p = property || {};
  const taxes = n(p.annual_taxes) / 12;
  const condoFull = n(p.condo_fees_monthly);
  const condoCounted = condoFull * 0.5;
  // When the fees include heat, the heat line is already covered by the fees.
  const heat = p.condo_fees_include_heat ? 0 : n(p.heating_monthly);
  const other = n(p.hydro_monthly) + n(p.water_monthly) + n(p.other_expenses_monthly);

  return {
    taxes_monthly: round2(taxes),
    condo_fees_monthly: round2(condoFull),
    condo_fees_counted: round2(condoCounted),
    heat_monthly: round2(heat),
    other_monthly: round2(other),
    // "other" costs are not part of the standard GDS numerator; they are shown
    // to the broker as real money the client will spend, but kept out of the
    // ratio so the number matches what a lender computes.
    gds_shelter_excluding_mortgage: round2(taxes + condoCounted + heat),
  };
}

/**
 * Rental treatment.
 *
 * 'offset' reduces the property's own carrying costs by a percentage of the
 * rent (the common treatment for a subject property with a rented unit);
 * 'add' adds the recognised portion to gross income (the common treatment for
 * an investment property). Both are real lender policies, so the file records
 * which one it used.
 */
function applyRental(property, shelterMonthly, grossMonthlyIncome) {
  const rent = n(property && property.rental_income_monthly);
  if (rent <= 0) {
    return { shelter: shelterMonthly, income: grossMonthlyIncome, rental_applied: 0, rental_treatment: 'none' };
  }
  const pct = property.rental_offset_pct === null || property.rental_offset_pct === undefined
    ? 50
    : n(property.rental_offset_pct);
  const recognised = round2(rent * (pct / 100));

  if (property.rental_treatment === 'add') {
    return {
      shelter: shelterMonthly,
      income: round2(grossMonthlyIncome + recognised),
      rental_applied: recognised,
      rental_treatment: 'add',
    };
  }
  return {
    shelter: round2(Math.max(0, shelterMonthly - recognised)),
    income: grossMonthlyIncome,
    rental_applied: recognised,
    rental_treatment: 'offset',
  };
}

/** The rate a file must qualify at, given its contract rate and the policy. */
function qualifyingRateFor(contractRatePct, policy) {
  const p = { ...DEFAULT_STRESS_TEST, ...(policy || {}) };
  return round2(Math.max(n(contractRatePct) + n(p.buffer_pct), n(p.floor_rate)));
}

/**
 * The whole qualification picture for one file.
 *
 * @param {object} input
 * @param {object} input.file        client_files row
 * @param {object} input.property    file_properties row (may be null)
 * @param {Array}  input.incomes     applicant_incomes rows
 * @param {Array}  input.assets      file_assets rows
 * @param {Array}  input.liabilities file_liabilities rows
 * @param {object} input.request     the primary mortgage_requests row (may be null)
 * @param {object} input.policy      stress-test settings
 */
function computeMetrics({ file, property, incomes = [], assets = [], liabilities = [], request = null, policy = null }) {
  const rules = { ...DEFAULT_STRESS_TEST, ...(policy || {}) };

  // ---- Income -------------------------------------------------------------
  const qualifyingIncomes = incomes.filter((i) => i.qualifies !== 0);
  const grossMonthlyRaw = round2(qualifyingIncomes.reduce((sum, i) => sum + monthlyIncome(i), 0));
  const totalMonthlyOnFile = round2(incomes.reduce((sum, i) => sum + monthlyIncome(i), 0));

  // ---- Debts --------------------------------------------------------------
  // A liability being paid off at closing stops being a monthly obligation,
  // which is the entire point of a debt-consolidation refinance.
  const countedDebts = liabilities.filter((l) => l.include_in_tds !== 0 && l.payoff_at_close !== 1);
  const monthlyDebts = round2(countedDebts.reduce((sum, l) => sum + n(l.monthly_payment), 0));

  const totalAssets = round2(assets.reduce((sum, a) => sum + n(a.value), 0));
  const totalLiabilities = round2(liabilities.reduce((sum, l) => sum + n(l.balance), 0));
  const netWorth = round2(totalAssets - totalLiabilities);
  const downPaymentFromAssets = round2(assets.reduce((sum, a) => sum + n(a.down_payment_amount), 0));

  // ---- The mortgage itself ------------------------------------------------
  const principal = request && request.principal !== null && request.principal !== undefined
    ? n(request.principal)
    : n(file && file.mortgage_amount);

  const propertyValue = n(
    (property && (property.appraisal_value || property.estimated_value)) ||
    (request && (request.property_value || request.purchase_price)) ||
    (file && file.purchase_price)
  );

  const contractRate = request ? n(request.contract_rate) : 0;
  const amortization = request ? (n(request.amortization_months) || 300) : 300;
  const frequency = request ? (request.payment_frequency || 'monthly') : 'monthly';
  const compounding = request ? (request.compounding || 'semi_annual') : 'semi_annual';
  const interestOnly = !!(request && request.interest_only);

  const contractPayment = payment({
    principal, annualRatePct: contractRate, amortizationMonths: amortization,
    frequency, compounding, interestOnly,
  });
  const contractMonthly = toMonthly(contractPayment, frequency);

  const qualifyingRate = request && request.qualifying_rate !== null && request.qualifying_rate !== undefined
    ? n(request.qualifying_rate)
    : qualifyingRateFor(contractRate, rules);
  const qualifyingAmortization = request && request.qualifying_amortization_months
    ? n(request.qualifying_amortization_months)
    : amortization;

  const qualifyingPayment = payment({
    principal, annualRatePct: qualifyingRate, amortizationMonths: qualifyingAmortization,
    frequency: 'monthly', compounding, interestOnly: false,
  });

  // ---- Shelter costs ------------------------------------------------------
  const costs = propertyCosts(property);
  const contractShelterRaw = round2(contractMonthly + costs.gds_shelter_excluding_mortgage);
  const qualifyingShelterRaw = round2(qualifyingPayment + costs.gds_shelter_excluding_mortgage);

  const contractRental = applyRental(property, contractShelterRaw, grossMonthlyRaw);
  const qualifyingRental = applyRental(property, qualifyingShelterRaw, grossMonthlyRaw);

  const ratio = (numerator, income) => (income > 0 ? round2((numerator / income) * 100) : null);

  const contractGds = ratio(contractRental.shelter, contractRental.income);
  const contractTds = ratio(contractRental.shelter + monthlyDebts, contractRental.income);
  const qualifyingGds = ratio(qualifyingRental.shelter, qualifyingRental.income);
  const qualifyingTds = ratio(qualifyingRental.shelter + monthlyDebts, qualifyingRental.income);

  const ltv = propertyValue > 0 ? round2((principal / propertyValue) * 100) : null;
  const suggestedPremiumRate = ltv !== null && ltv > 80 ? insurancePremiumRate(ltv) : 0;

  // ---- Verdict ------------------------------------------------------------
  // Qualification is judged on the stress-tested numbers, because that is what
  // the lender does. The contract numbers are shown beside them so the broker
  // can explain the gap to the client.
  const warnings = [];
  if (grossMonthlyRaw <= 0) warnings.push('No qualifying income has been recorded, so the ratios cannot be calculated.');
  if (propertyValue <= 0) warnings.push('No property value (purchase price, estimate or appraisal) has been recorded, so LTV is unknown.');
  if (!request) warnings.push('No mortgage request has been created yet, so the payment is not modelled.');
  else if (contractRate <= 0) warnings.push('The mortgage request has no contract rate, so the payment shows as interest-free.');
  if (ltv !== null && ltv > 95) warnings.push('Loan-to-value is above 95% — this is not insurable under standard programmes.');
  if (qualifyingGds !== null && qualifyingGds > rules.gds_limit) warnings.push(`Stress-tested GDS of ${qualifyingGds}% is above the ${rules.gds_limit}% guideline.`);
  if (qualifyingTds !== null && qualifyingTds > rules.tds_limit) warnings.push(`Stress-tested TDS of ${qualifyingTds}% is above the ${rules.tds_limit}% guideline.`);

  const status = (value, limit) => {
    if (value === null) return 'unknown';
    if (value > limit) return 'over';
    if (value > limit - 4) return 'near';
    return 'ok';
  };

  return {
    income: {
      gross_monthly: grossMonthlyRaw,
      gross_annual: round2(grossMonthlyRaw * 12),
      total_monthly_on_file: totalMonthlyOnFile,
      excluded_monthly: round2(totalMonthlyOnFile - grossMonthlyRaw),
      sources: incomes.length,
    },
    debts: {
      monthly_payments: monthlyDebts,
      total_balance: totalLiabilities,
      counted: countedDebts.length,
      excluded: liabilities.length - countedDebts.length,
    },
    assets: {
      total: totalAssets,
      down_payment_identified: downPaymentFromAssets,
      count: assets.length,
    },
    net_worth: netWorth,
    property: {
      value: propertyValue || null,
      ...costs,
      rental_applied: contractRental.rental_applied,
      rental_treatment: contractRental.rental_treatment,
    },
    mortgage: {
      principal: principal || null,
      contract_rate: contractRate || null,
      rate_type: request ? request.rate_type : null,
      term_months: request ? request.term_months : null,
      amortization_months: amortization,
      payment_frequency: frequency,
      payment: contractPayment,
      payment_monthly_equivalent: contractMonthly,
      qualifying_rate: qualifyingRate,
      qualifying_amortization_months: qualifyingAmortization,
      qualifying_payment_monthly: qualifyingPayment,
      lender: request ? (request.lender_name_snapshot || null) : null,
      product: request ? (request.product_name_snapshot || null) : null,
    },
    insurance: {
      required: ltv !== null && ltv > 80,
      suggested_premium_rate: suggestedPremiumRate,
      suggested_premium: suggestedPremiumRate ? round2(principal * (suggestedPremiumRate / 100)) : 0,
      recorded_premium: request ? n(request.insurance_premium) : 0,
    },
    ratios: {
      gds: qualifyingGds,
      tds: qualifyingTds,
      ltv,
      contract_gds: contractGds,
      contract_tds: contractTds,
      gds_limit: rules.gds_limit,
      tds_limit: rules.tds_limit,
      gds_status: status(qualifyingGds, rules.gds_limit),
      tds_status: status(qualifyingTds, rules.tds_limit),
      ltv_status: ltv === null ? 'unknown' : ltv > 95 ? 'over' : ltv > 80 ? 'near' : 'ok',
    },
    policy: rules,
    warnings,
  };
}

module.exports = {
  DEFAULT_STRESS_TEST,
  PAYMENTS_PER_YEAR,
  periodicRate,
  payment,
  toMonthly,
  monthlyIncome,
  propertyCosts,
  applyRental,
  qualifyingRateFor,
  insurancePremiumRate,
  computeMetrics,
};
