'use strict';

/**
 * FINTRAC / anti-money-laundering compliance.
 *
 * A Canadian mortgage brokerage is a reporting entity. The obligations are
 * not optional and they are not satisfied by a note in a text box, so this
 * module models them as structured, reportable data:
 *
 *   1. a risk assessment per deal (property risk + reporting flags + third
 *      party determination + beneficial ownership),
 *   2. identity verification, PEP declaration and sanction screening per
 *      borrower.
 *
 * Two design decisions worth stating, because both are easy to get wrong:
 *
 *  - PEP status is captured per FINTRAC's actual definition, which extends to
 *    family members and close associates. A single "is this person a PEP?"
 *    checkbox under-reports and would leave the brokerage exposed.
 *  - The risk level is DERIVED from the answers every time it is read. There
 *    is no editable "risk level" field for someone to quietly downgrade, and
 *    a generated assessment document is regenerated rather than hand-edited.
 *
 * Sanction screening records a status and a timestamp against configurable
 * list sources. The actual list check is an integration point: `screen()`
 * below is where a provider is wired in, and until one is configured the
 * status is set by a human who did the check, which is auditable and honest
 * rather than a green tick nobody earned.
 */

const { parseJsonSafe } = require('./util');

/** Deal-level questions. `weight` feeds the derived risk score. */
const DEAL_QUESTIONS = [
  {
    section: 'Subject property',
    items: [
      { key: 'property_high_risk_area', label: 'Is the property in an area known for high criminal activity?', weight: 2 },
      { key: 'property_value_inconsistent', label: 'Is the property value inconsistent with the local market?', weight: 2 },
      { key: 'property_rapid_resale', label: 'Is this a rapid resale (purchased and re-sold within 12 months) at a materially different price?', weight: 2 },
    ],
  },
  {
    section: 'Transaction',
    items: [
      { key: 'funds_from_third_party', label: 'Is any part of the down payment being provided or gifted by someone who is not a borrower?', weight: 1, follow_up: 'third_party_details' },
      { key: 'beneficial_owner_entity', label: 'Is any borrower a corporation, partnership or trust rather than a natural person?', weight: 1, follow_up: 'beneficial_owner_details' },
      { key: 'unusual_documentation', label: 'Was any document provided unusual, altered or difficult to verify?', weight: 3 },
      { key: 'structure_unusual', label: 'Is the transaction structured in a way that has no clear economic purpose?', weight: 3 },
    ],
  },
  {
    section: 'Reporting obligations',
    items: [
      { key: 'suspicious_transaction_report', label: 'Does this transaction require a Suspicious Transaction Report?', weight: 5 },
      { key: 'terrorist_property_report', label: 'Does this transaction require a Terrorist Property Report?', weight: 5 },
      { key: 'large_cash_received', label: 'Was $10,000 or more received in cash in a single transaction?', weight: 3 },
    ],
  },
];

/** Per-borrower questions, asked once for each applicant on the file. */
const BORROWER_QUESTIONS = [
  { key: 'high_risk_occupation', label: 'Does the borrower work in an occupation with elevated money-laundering risk?', weight: 2 },
  { key: 'high_risk_country', label: 'Is the borrower a national of, or resident in, a high-risk jurisdiction?', weight: 3 },
  { key: 'id_difficult', label: 'Was there any difficulty confirming the borrower’s identity?', weight: 3 },
  { key: 'concerns', label: 'Do you have any concerns or suspicions about this borrower or the transaction?', weight: 5 },
];

const ID_METHODS = [
  ['government_photo_id', 'Government-issued photo ID (in person or by video)'],
  ['dual_process', 'Dual process — two independent, reliable sources'],
  ['credit_file', 'Credit file method (single Canadian credit file, 3+ years)'],
  ['electronic', 'Third-party electronic identity verification'],
  ['agent_mandatary', 'Agent or mandatary agreement'],
];

const SANCTION_SOURCES = [
  ['un', 'United Nations consolidated list'],
  ['sema', 'Special Economic Measures Act (Canada)'],
  ['jvcfoa', 'Justice for Victims of Corrupt Foreign Officials Act'],
  ['fatf', 'FATF high-risk jurisdictions'],
];

const SANCTION_STATUSES = ['not_screened', 'cleared', 'match_review', 'rejected'];

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'yes';
}

/** Every deal question key, flattened. */
function dealQuestionKeys() {
  return DEAL_QUESTIONS.flatMap((s) => s.items.map((i) => i.key));
}

function dealQuestionByKey(key) {
  for (const section of DEAL_QUESTIONS) {
    for (const item of section.items) if (item.key === key) return item;
  }
  return null;
}

/**
 * Derive risk from the answers.
 *
 * Any reporting obligation, or an explicit suspicion, is high risk regardless
 * of what else is on the file — those are not points on a scale, they are
 * facts that change what the brokerage must do next.
 */
function assessRisk(dealAnswers, borrowerChecks = []) {
  const answers = dealAnswers || {};
  let score = 0;
  const drivers = [];

  for (const section of DEAL_QUESTIONS) {
    for (const item of section.items) {
      if (truthy(answers[item.key])) {
        score += item.weight;
        drivers.push(item.label);
      }
    }
  }

  let mandatoryHigh = truthy(answers.suspicious_transaction_report) || truthy(answers.terrorist_property_report);

  for (const check of borrowerChecks) {
    const borrowerAnswers = typeof check.answers === 'string' ? parseJsonSafe(check.answers, {}) : (check.answers || {});
    for (const q of BORROWER_QUESTIONS) {
      if (truthy(borrowerAnswers[q.key])) {
        score += q.weight;
        drivers.push(q.label);
        if (q.key === 'concerns') mandatoryHigh = true;
      }
    }
    if (check.pep_foreign) { score += 4; drivers.push('Foreign politically exposed person'); mandatoryHigh = true; }
    if (check.pep_domestic) { score += 2; drivers.push('Domestic politically exposed person'); }
    if (check.pep_hio) { score += 2; drivers.push('Head of an international organization'); }
    if (check.sanction_status === 'rejected') { score += 10; drivers.push('Sanction screening returned a match'); mandatoryHigh = true; }
    if (check.sanction_status === 'match_review') { score += 4; drivers.push('Sanction screening needs review'); }
  }

  let level = 'low';
  if (score >= 8) level = 'high';
  else if (score >= 3) level = 'medium';
  if (mandatoryHigh) level = 'high';

  return { risk_score: score, risk_level: level, drivers };
}

/**
 * What is still missing before this file's AML record is complete.
 *
 * Returned as human-readable strings because they are shown directly to the
 * broker — a compliance gap the user cannot read is a compliance gap.
 */
function outstanding(assessment, borrowerChecks, applicants) {
  const gaps = [];
  const answers = assessment ? parseJsonSafe(assessment.answers, {}) : {};

  const unanswered = dealQuestionKeys().filter((k) => answers[k] === undefined || answers[k] === null || answers[k] === '');
  if (unanswered.length) {
    gaps.push(`${unanswered.length} deal risk question${unanswered.length === 1 ? '' : 's'} unanswered`);
  }
  if (truthy(answers.funds_from_third_party) && !String(answers.third_party_details || '').trim()) {
    gaps.push('Third party providing funds is flagged but not described');
  }
  if (truthy(answers.beneficial_owner_entity) && !String(answers.beneficial_owner_details || '').trim()) {
    gaps.push('An entity borrower is flagged but beneficial ownership is not recorded');
  }

  const byApplicant = new Map(borrowerChecks.map((c) => [c.applicant_id, c]));
  for (const applicant of applicants) {
    const name = `${applicant.first_name} ${applicant.last_name}`.trim();
    // A borrower with no record yet is missing everything, so enumerate it
    // rather than stopping at "no record started" — a list that says what to
    // do is worth more than one that says something is wrong.
    const check = byApplicant.get(applicant.id) || { answers: '{}' };
    if (!check.id_verified_at) gaps.push(`${name}: identity not verified`);
    if (!check.sanction_status || check.sanction_status === 'not_screened') gaps.push(`${name}: not screened against sanction lists`);
    if (check.sanction_status === 'match_review') gaps.push(`${name}: sanction screening match needs review`);
    if (check.sanction_status === 'rejected') gaps.push(`${name}: sanction screening returned a match — do not proceed without compliance sign-off`);
    const borrowerAnswers = parseJsonSafe(check.answers, {});
    const unansweredB = BORROWER_QUESTIONS.filter((q) => borrowerAnswers[q.key] === undefined || borrowerAnswers[q.key] === '');
    if (unansweredB.length) gaps.push(`${name}: ${unansweredB.length} risk question${unansweredB.length === 1 ? '' : 's'} unanswered`);
    if (!check.pep_relationship && (check.pep_foreign || check.pep_domestic || check.pep_hio)) {
      gaps.push(`${name}: PEP flagged but the relationship (self, family, close associate) is not recorded`);
    }
  }
  return gaps;
}

/**
 * Sanction screening.
 *
 * There is no list provider wired in by default, and that is a deliberate
 * choice rather than an omission: a stubbed "cleared" result would be worse
 * than no result at all, because it would look like the check happened. Until
 * AML_SCREENING_PROVIDER names a provider, this returns `manual`, and the UI
 * asks a human to record what they actually found.
 */
function screeningMode() {
  return process.env.AML_SCREENING_PROVIDER ? String(process.env.AML_SCREENING_PROVIDER) : 'manual';
}

/** The whole AML picture for one file, ready to serialize. */
function summarize(assessment, borrowerChecks, applicants) {
  const answers = assessment ? parseJsonSafe(assessment.answers, {}) : {};
  const risk = assessRisk(answers, borrowerChecks);
  const gaps = outstanding(assessment, borrowerChecks, applicants);
  return {
    answers,
    status: gaps.length === 0 ? 'complete' : (assessment && assessment.status === 'not_started' && !Object.keys(answers).length ? 'not_started' : 'in_progress'),
    ...risk,
    outstanding: gaps,
    complete: gaps.length === 0,
    completed_at: assessment ? assessment.completed_at : null,
    screening_mode: screeningMode(),
  };
}

module.exports = {
  DEAL_QUESTIONS,
  BORROWER_QUESTIONS,
  ID_METHODS,
  SANCTION_SOURCES,
  SANCTION_STATUSES,
  dealQuestionKeys,
  dealQuestionByKey,
  assessRisk,
  outstanding,
  summarize,
  screeningMode,
  truthy,
};
