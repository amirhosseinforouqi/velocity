'use strict';

/**
 * Qualification arithmetic.
 *
 * These are pure functions, so they are tested directly rather than over HTTP
 * — there is no boundary here for an attacker to reach, only numbers that a
 * lender will decline a client over. The expected values below come from the
 * standard Canadian formulas, not from a previous run of this code: a test
 * that only asserts "whatever it did last time" would happily lock in a bug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../server/metrics');

test('payment: semi-annual compounding, the Canadian standard', () => {
  // $600,000 at 5.00% over 25 years, compounded semi-annually.
  // Monthly periodic rate i = (1 + 0.05/2)^(1/6) - 1 = 0.004123915...
  // Payment = P·i / (1 - (1+i)^-300) = $3,489.63
  const payment = metrics.payment({ principal: 600000, annualRatePct: 5, amortizationMonths: 300 });
  assert.ok(Math.abs(payment - 3489.63) < 0.05, `expected ~3489.63, got ${payment}`);

  // The naive annual/12 rate would give ~$3,507.56. If this assertion ever
  // fails because the numbers converged, the compounding has been broken.
  const naive = 600000 * (0.05 / 12) / (1 - Math.pow(1 + 0.05 / 12, -300));
  assert.ok(Math.abs(payment - naive) > 15, 'semi-annual compounding must differ from a monthly-rate approximation');
});

test('payment: monthly compounding is available and differs', () => {
  const semi = metrics.payment({ principal: 400000, annualRatePct: 6, amortizationMonths: 300 });
  const monthly = metrics.payment({ principal: 400000, annualRatePct: 6, amortizationMonths: 300, compounding: 'monthly' });
  assert.ok(monthly > semi, 'monthly compounding costs more than semi-annual at the same nominal rate');
});

test('payment: accelerated frequencies are the monthly payment split, not a re-amortization', () => {
  const monthly = metrics.payment({ principal: 500000, annualRatePct: 4.5, amortizationMonths: 300 });
  const accelerated = metrics.payment({
    principal: 500000, annualRatePct: 4.5, amortizationMonths: 300, frequency: 'accelerated_biweekly',
  });
  assert.ok(Math.abs(accelerated - monthly / 2) < 0.01, 'accelerated bi-weekly is half the monthly payment');

  // 26 half-payments a year is 13 monthly payments, which is why it pays down
  // faster — the annualized total must exceed twelve monthly payments.
  assert.ok(accelerated * 26 > monthly * 12, 'accelerated payments total more per year');
});

test('payment: a zero rate amortizes linearly rather than dividing by zero', () => {
  const payment = metrics.payment({ principal: 120000, annualRatePct: 0, amortizationMonths: 120 });
  assert.equal(payment, 1000);
});

test('payment: no principal means no payment', () => {
  assert.equal(metrics.payment({ principal: 0, annualRatePct: 5, amortizationMonths: 300 }), 0);
  assert.equal(metrics.payment({ principal: null, annualRatePct: 5, amortizationMonths: 300 }), 0);
});

test('interest-only pays the interest and nothing else', () => {
  const payment = metrics.payment({
    principal: 300000, annualRatePct: 6, amortizationMonths: 300, interestOnly: true,
  });
  const i = Math.pow(1 + 0.06 / 2, 2 / 12) - 1;
  assert.ok(Math.abs(payment - 300000 * i) < 0.02);
});

test('qualifying rate is the greater of contract + buffer and the floor', () => {
  // Low contract rate: the floor wins.
  assert.equal(metrics.qualifyingRateFor(2.5), 5.25);
  // High contract rate: the buffer wins.
  assert.equal(metrics.qualifyingRateFor(5.0), 7.0);
  // Exactly at the boundary.
  assert.equal(metrics.qualifyingRateFor(3.25), 5.25);
  // A brokerage may set its own policy.
  assert.equal(metrics.qualifyingRateFor(4.0, { buffer_pct: 1, floor_rate: 4 }), 5.0);
});

test('monthly income normalizes every pay period', () => {
  assert.equal(metrics.monthlyIncome({ amount: 120000, period: 'annual' }), 10000);
  assert.equal(metrics.monthlyIncome({ amount: 5000, period: 'monthly' }), 5000);
  assert.equal(metrics.monthlyIncome({ amount: 2500, period: 'semi_monthly' }), 5000);
  assert.ok(Math.abs(metrics.monthlyIncome({ amount: 2000, period: 'biweekly' }) - 4333.33) < 0.01);
  // Hourly needs hours, which are not on the record — never assume a number.
  assert.equal(metrics.monthlyIncome({ amount: 40, period: 'hourly' }), 0);
});

test('property costs: half the condo fees, and heat is not double counted', () => {
  const costs = metrics.propertyCosts({
    annual_taxes: 6000, condo_fees_monthly: 400, heating_monthly: 150,
    hydro_monthly: 90, water_monthly: 40, condo_fees_include_heat: 0,
  });
  assert.equal(costs.taxes_monthly, 500);
  assert.equal(costs.condo_fees_counted, 200);
  assert.equal(costs.heat_monthly, 150);
  // 500 taxes + 200 half-fees + 150 heat. Hydro and water stay out of GDS.
  assert.equal(costs.gds_shelter_excluding_mortgage, 850);
  assert.equal(costs.other_monthly, 130);

  const bundled = metrics.propertyCosts({
    annual_taxes: 6000, condo_fees_monthly: 400, heating_monthly: 150, condo_fees_include_heat: 1,
  });
  assert.equal(bundled.heat_monthly, 0, 'heat inside the fees is not counted a second time');
  assert.equal(bundled.gds_shelter_excluding_mortgage, 700);
});

test('rental income: offset reduces costs, add raises income — and they differ', () => {
  const property = { rental_income_monthly: 2000, rental_offset_pct: 50, rental_treatment: 'offset' };
  const offset = metrics.applyRental(property, 3000, 8000);
  assert.equal(offset.shelter, 2000);
  assert.equal(offset.income, 8000);

  const added = metrics.applyRental({ ...property, rental_treatment: 'add' }, 3000, 8000);
  assert.equal(added.shelter, 3000);
  assert.equal(added.income, 9000);

  // The two treatments produce different ratios — which is exactly why the
  // choice is recorded per file rather than assumed.
  assert.notEqual(offset.shelter / offset.income, added.shelter / added.income);
});

test('rental offset never drives shelter costs below zero', () => {
  const result = metrics.applyRental(
    { rental_income_monthly: 9000, rental_offset_pct: 100, rental_treatment: 'offset' }, 1000, 5000
  );
  assert.equal(result.shelter, 0);
});

test('computeMetrics: a worked file produces the ratios by hand-checkable arithmetic', () => {
  const file = { mortgage_amount: 500000, purchase_price: 625000 };
  const property = {
    annual_taxes: 4800,          // 400/month
    condo_fees_monthly: 0,
    heating_monthly: 100,
    estimated_value: 625000,
  };
  const incomes = [
    { amount: 96000, period: 'annual', qualifies: 1 },   // 8000/month
    { amount: 24000, period: 'annual', qualifies: 1 },   // 2000/month
    { amount: 12000, period: 'annual', qualifies: 0 },   // excluded
  ];
  const liabilities = [
    { balance: 20000, monthly_payment: 400, include_in_tds: 1, payoff_at_close: 0 },
    { balance: 15000, monthly_payment: 300, include_in_tds: 1, payoff_at_close: 1 }, // paid off
  ];
  const assets = [{ value: 150000, down_payment_amount: 125000 }];
  const request = {
    principal: 500000, contract_rate: 4.0, amortization_months: 300,
    payment_frequency: 'monthly', compounding: 'semi_annual', rate_type: 'fixed', term_months: 60,
  };

  const m = metrics.computeMetrics({ file, property, incomes, assets, liabilities, request });

  assert.equal(m.income.gross_monthly, 10000, 'only qualifying income counts');
  assert.equal(m.income.excluded_monthly, 1000);
  assert.equal(m.debts.monthly_payments, 400, 'a debt paid off at closing leaves TDS');
  assert.equal(m.net_worth, 150000 - 35000);
  assert.equal(m.ratios.ltv, 80);

  // Qualifying rate: max(4.0 + 2.0, 5.25) = 6.0%.
  assert.equal(m.mortgage.qualifying_rate, 6.0);

  // Shelter at the qualifying rate: payment + 400 taxes + 100 heat.
  const qualifyingPayment = metrics.payment({
    principal: 500000, annualRatePct: 6.0, amortizationMonths: 300,
  });
  const expectedGds = ((qualifyingPayment + 500) / 10000) * 100;
  assert.ok(Math.abs(m.ratios.gds - expectedGds) < 0.02, `GDS ${m.ratios.gds} vs ${expectedGds}`);
  const expectedTds = ((qualifyingPayment + 500 + 400) / 10000) * 100;
  assert.ok(Math.abs(m.ratios.tds - expectedTds) < 0.02);

  // The contract-rate figures are lower, and are reported separately so the
  // broker can explain the gap rather than being shown only the flattering one.
  assert.ok(m.ratios.contract_gds < m.ratios.gds);
  assert.ok(m.ratios.contract_tds < m.ratios.tds);
});

test('computeMetrics: an empty file reports what is missing instead of pretending', () => {
  const m = metrics.computeMetrics({ file: {}, property: null, incomes: [], assets: [], liabilities: [], request: null });
  assert.equal(m.ratios.gds, null);
  assert.equal(m.ratios.tds, null);
  assert.equal(m.ratios.ltv, null);
  assert.equal(m.ratios.gds_status, 'unknown');
  assert.ok(m.warnings.some((w) => /no qualifying income/i.test(w)));
  assert.ok(m.warnings.some((w) => /no property value/i.test(w)));
  assert.ok(m.warnings.some((w) => /no mortgage request/i.test(w)));
});

test('computeMetrics: ratios over the guideline are flagged, and near ones warn', () => {
  const base = {
    file: { mortgage_amount: 700000 },
    property: { annual_taxes: 6000, estimated_value: 800000, heating_monthly: 150 },
    assets: [], liabilities: [],
    request: { principal: 700000, contract_rate: 5.5, amortization_months: 300, payment_frequency: 'monthly', compounding: 'semi_annual' },
  };
  const stretched = metrics.computeMetrics({ ...base, incomes: [{ amount: 100000, period: 'annual', qualifies: 1 }] });
  assert.equal(stretched.ratios.gds_status, 'over');
  assert.ok(stretched.warnings.some((w) => /GDS/.test(w)));

  const comfortable = metrics.computeMetrics({ ...base, incomes: [{ amount: 400000, period: 'annual', qualifies: 1 }] });
  assert.equal(comfortable.ratios.gds_status, 'ok');
  assert.equal(comfortable.warnings.filter((w) => /GDS|TDS/.test(w)).length, 0);
});

test('LTV above 95% is called out as uninsurable', () => {
  const m = metrics.computeMetrics({
    file: { mortgage_amount: 490000 },
    property: { estimated_value: 500000 },
    incomes: [{ amount: 200000, period: 'annual', qualifies: 1 }],
    assets: [], liabilities: [],
    request: { principal: 490000, contract_rate: 5, amortization_months: 300, payment_frequency: 'monthly', compounding: 'semi_annual' },
  });
  assert.equal(m.ratios.ltv, 98);
  assert.equal(m.ratios.ltv_status, 'over');
  assert.equal(m.insurance.suggested_premium_rate, 0, 'above 95% there is no standard premium band');
  assert.ok(m.warnings.some((w) => /not insurable/i.test(w)));
});

test('insurance premium bands follow the LTV thresholds', () => {
  assert.equal(metrics.insurancePremiumRate(80), 2.4);
  assert.equal(metrics.insurancePremiumRate(80.1), 2.8);
  assert.equal(metrics.insurancePremiumRate(95), 4.0);
  assert.equal(metrics.insurancePremiumRate(95.1), 0);
});

test('an appraisal outranks an estimate for LTV', () => {
  const m = metrics.computeMetrics({
    file: { mortgage_amount: 400000 },
    property: { estimated_value: 600000, appraisal_value: 500000 },
    incomes: [], assets: [], liabilities: [],
    request: { principal: 400000, contract_rate: 5, amortization_months: 300 },
  });
  assert.equal(m.ratios.ltv, 80, 'the appraised value is what a lender lends against');
});

test('a request may pin its own qualifying rate, overriding the policy', () => {
  const m = metrics.computeMetrics({
    file: { mortgage_amount: 300000 },
    property: { estimated_value: 500000 },
    incomes: [{ amount: 120000, period: 'annual', qualifies: 1 }],
    assets: [], liabilities: [],
    request: {
      principal: 300000, contract_rate: 4, amortization_months: 300,
      qualifying_rate: 4.5, payment_frequency: 'monthly', compounding: 'semi_annual',
    },
  });
  assert.equal(m.mortgage.qualifying_rate, 4.5, 'the pinned rate wins over max(4+2, 5.25)');
});
