'use strict';

/**
 * Date-driven workflow automation.
 *
 * A rule says: "N days before/after <lifecycle date>, for files in <stage>,
 * do <action>." The nightly pass finds every file whose computed trigger date
 * has arrived and fires the rule once.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never sends a client an email on its own initiative unless the rule
 *    explicitly says so AND the brokerage has turned client automation on.
 *    An automation engine that can silently email a real client on a real
 *    mortgage file is a liability, not a feature, so the default action is to
 *    create a task for a human.
 *  - It never fires the same rule twice for the same file and date. That is
 *    enforced by a unique index on workflow_runs rather than by remembering
 *    in process, so a restart mid-pass cannot produce duplicates.
 *
 * Date arithmetic is done on plain YYYY-MM-DD strings in UTC. Adding days to
 * a date this way has no daylight-saving edge cases, which is the classic bug
 * in exactly this kind of scheduler.
 */

const { all, get, run, getSetting } = require('./db');
const { now, today, str } = require('./util');
const { activity } = require('./log');
const { notifyUser } = require('./notify');

/**
 * The lifecycle dates a rule may trigger from, with the label the UI shows.
 * Adding one here is all it takes for it to become available as a trigger.
 */
const TRIGGERS = [
  ['lead_at', 'Lead received'],
  ['application_at', 'Application started'],
  ['submitted_at', 'Submitted to lender'],
  ['approved_at', 'Approved'],
  ['accepted_at', 'Commitment accepted'],
  ['conditions_due_date', 'Conditions due'],
  ['conditions_met_at', 'Conditions met'],
  ['appraisal_ordered_at', 'Appraisal ordered'],
  ['appraisal_received_at', 'Appraisal received'],
  ['solicitor_instructed_at', 'Solicitor instructed'],
  ['closing_date', 'Closing'],
  ['funded_at', 'Funded'],
  ['lender_payment_at', 'Lender payment received'],
  ['rate_hold_expires_at', 'Rate hold expiry'],
  ['maturity_date', 'Mortgage maturity'],
];

const TRIGGER_FIELDS = TRIGGERS.map(([field]) => field);
const ACTIONS = ['task', 'notify', 'email_client'];
const ASSIGNEES = [
  ['assigned_broker', 'The file’s assigned broker'],
  ['file_creator', 'Whoever created the file'],
  ['unassigned', 'Leave unassigned'],
];

/** Add days to a YYYY-MM-DD date. Pure string/UTC arithmetic — no DST traps. */
function shiftDate(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lifecycle values are stored variously as dates or timestamps; normalize. */
function dateOnly(value) {
  const s = str(value, 30);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** The day a rule fires for a given file, or null when the trigger is unset. */
function dueDateFor(rule, file) {
  const base = dateOnly(file[rule.trigger_field]);
  if (!base) return null;
  const days = Number(rule.offset_days) || 0;
  return shiftDate(base, rule.offset_direction === 'before' ? -days : days);
}

/** Merge fields available to a rule's title/description. */
function renderTemplate(text, context) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => {
    const value = context[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Evaluate every active rule against every active file.
 *
 * @param {object} options
 * @param {string} options.asOf   YYYY-MM-DD; defaults to today. Injectable so
 *                                the tests can assert the off-by-one boundary
 *                                rather than waiting a day.
 * @param {boolean} options.dryRun report what would fire without firing it.
 */
async function runWorkflowPass({ asOf = null, dryRun = false } = {}) {
  const asOfDate = asOf || today();
  const rules = await all('SELECT * FROM workflow_rules WHERE active = 1 ORDER BY id');
  if (!rules.length) return { rules: 0, fired: 0, skipped: 0, actions: [] };

  const automation = await getSetting('automation', {});
  const clientEmailAllowed = automation.workflow_client_email === true;

  const files = await all(
    `SELECT f.*, s.key AS stage_key
       FROM client_files f LEFT JOIN stages s ON s.id = f.stage_id
      WHERE f.status = 'active'`
  );

  let fired = 0;
  let skipped = 0;
  const actions = [];

  for (const rule of rules) {
    if (!TRIGGER_FIELDS.includes(rule.trigger_field)) continue;
    for (const file of files) {
      if (rule.stage_key && file.stage_key !== rule.stage_key) continue;
      const due = dueDateFor(rule, file);
      // Fire on or after the due day, so a pass that did not run yesterday
      // still catches up rather than silently skipping the window.
      if (!due || due > asOfDate) continue;

      const already = await get(
        'SELECT id FROM workflow_runs WHERE rule_id = ? AND file_id = ? AND due_date = ?',
        rule.id, file.id, due
      );
      if (already) { skipped++; continue; }

      if (dryRun) {
        actions.push({ rule_id: rule.id, rule: rule.name, file_id: file.id, file_number: file.file_number, due_date: due, action: rule.action });
        continue;
      }

      let result = 'fired';
      let detail = '';
      try {
        detail = await applyRule(rule, file, due, { clientEmailAllowed });
      } catch (err) {
        result = 'error';
        detail = err.message;
      }

      // Insert the ledger row last and tolerate a lost race: if a concurrent
      // pass got there first, the unique index rejects this one and we simply
      // move on rather than failing the whole pass.
      const inserted = await run(
        `INSERT INTO workflow_runs (rule_id, file_id, due_date, result, detail, fired_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (rule_id, file_id, due_date) DO NOTHING`,
        rule.id, file.id, due, result, str(detail, 500), now()
      );
      if (inserted.rowCount === 0) { skipped++; continue; }

      fired++;
      actions.push({ rule_id: rule.id, rule: rule.name, file_id: file.id, file_number: file.file_number, due_date: due, action: rule.action, result });
    }
  }

  return { rules: rules.length, fired, skipped, actions };
}

/** Carry out one rule for one file. Returns a short detail string. */
async function applyRule(rule, file, dueDate, { clientEmailAllowed }) {
  const context = {
    file_number: file.file_number,
    closing_date: file.closing_date || '',
    due_date: dueDate,
    trigger: rule.trigger_field,
  };
  const title = renderTemplate(rule.task_title || rule.name, context);
  const description = renderTemplate(rule.task_description, context);

  const assignee = rule.assignee === 'file_creator' ? file.created_by
    : rule.assignee === 'unassigned' ? null
    : file.assigned_broker_id;

  if (rule.action === 'task') {
    // Never stack duplicates of an identical open task on the same file — a
    // broker with fourteen copies of "call the client" stops reading tasks.
    const open = await get(
      `SELECT id FROM tasks WHERE file_id = ? AND source = 'workflow' AND title = ?
         AND status IN ('pending','in_progress')`,
      file.id, title
    );
    if (open) return 'an identical task was already open';
    await run(
      `INSERT INTO tasks (file_id, title, description, due_date, priority, status, assigned_to, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 'workflow', ?, ?)`,
      file.id, title, description, dueDate,
      ['low', 'normal', 'high'].includes(rule.task_priority) ? rule.task_priority : 'normal',
      assignee, now(), now()
    );
    await activity(file.id, null, 'task_created', `Task created by workflow "${rule.name}": ${title}`);
    return `task created${assignee ? '' : ' (unassigned)'}`;
  }

  if (rule.action === 'notify') {
    if (!assignee) return 'no one to notify';
    await notifyUser(assignee, 'workflow', title, description, file.id, `#/files/${file.id}`);
    return 'notification sent';
  }

  if (rule.action === 'email_client') {
    // Three gates, same shape as the AI review feature: the rule asks for it,
    // the brokerage has enabled client-facing automation, and a template
    // exists. Missing any one of them records why rather than guessing.
    if (!clientEmailAllowed) return 'skipped — client email automation is off in Settings';
    if (!rule.email_template_key) return 'skipped — no email template selected';
    const template = await get('SELECT key FROM email_templates WHERE key = ? AND active = 1', rule.email_template_key);
    if (!template) return 'skipped — the selected email template is missing or inactive';

    const { sendTemplate } = require('./emails');
    const users = await all(
      `SELECT u.* FROM users u JOIN applicants a ON a.portal_user_id = u.id
        WHERE a.file_id = ? GROUP BY u.id`,
      file.id
    );
    for (const u of users) {
      await sendTemplate(rule.email_template_key, {
        toEmail: u.email,
        toName: `${u.first_name} ${u.last_name}`.trim(),
        userId: u.id,
        fileId: file.id,
        vars: {
          client_first_name: u.first_name,
          client_last_name: u.last_name,
          closing_date: file.closing_date || '',
        },
      });
    }
    if (users.length) {
      await activity(file.id, null, 'email_sent', `Workflow "${rule.name}" emailed ${users.length} portal user${users.length === 1 ? '' : 's'}`);
    }
    return `emailed ${users.length} portal user${users.length === 1 ? '' : 's'}`;
  }

  return 'no action';
}

module.exports = {
  TRIGGERS,
  TRIGGER_FIELDS,
  ACTIONS,
  ASSIGNEES,
  shiftDate,
  dueDateFor,
  renderTemplate,
  runWorkflowPass,
};
