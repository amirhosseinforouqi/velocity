'use strict';

const { run, get, all, getSetting, setSetting } = require('./db');
const { now } = require('./util');

/** Every permission key known to the platform. */
const ALL_PERMISSIONS = [
  'clients.view',
  'clients.create',
  'clients.edit',
  'clients.archive',
  'documents.view',        // see the checklist and document metadata
  'documents.download',    // retrieve the actual file bytes (preview OR download)
  'documents.upload',
  'documents.review',
  'documents.request',
  'stage.change',
  'chat.send',
  'tasks.manage',
  'notes.manage',
  'emails.view',
  'reports.view',
  'audit.view',
  'settings.manage',
  'users.manage',
  // Deal module. Financial and AML data are separated from general client
  // access on purpose: an assistant who books appointments has no business
  // reading a client's liabilities or their PEP declaration.
  'financials.view',
  'financials.edit',
  'aml.view',
  'aml.manage',
  'lenders.view',
  'lenders.manage',
];

const DEFAULT_ROLE_PERMISSIONS = {
  admin: ALL_PERMISSIONS,
  manager: ALL_PERMISSIONS.filter((p) => p !== 'settings.manage'),
  broker: ALL_PERMISSIONS.filter((p) => !['settings.manage', 'users.manage', 'audit.view', 'lenders.manage'].includes(p)),
  processor: [
    'clients.view',
    'documents.view',
    'documents.upload',
    'documents.review',
    'documents.request',
    'documents.download',
    'chat.send',
    'tasks.manage',
    'notes.manage',
    'emails.view',
    'financials.view',
    'aml.view',
    'lenders.view',
  ],
  assistant: [
    'clients.view',
    'documents.view',
    'documents.upload',
    'chat.send',
    'tasks.manage',
    'notes.manage',
    'emails.view',
  ],
};

/**
 * Permissions added after the first release.
 *
 * An existing brokerage has its role→permission map stored in settings, so a
 * new permission key would otherwise be granted to nobody — including the
 * administrator — and the feature would look broken rather than new. Each
 * upgrade is applied once, recorded by name, and only ever grants what the
 * defaults above say that role should have. It never takes anything away, so
 * a brokerage that has deliberately tightened a role keeps its choice.
 */
const PERMISSION_UPGRADES = {
  deal_module_v1: [
    'financials.view', 'financials.edit', 'aml.view', 'aml.manage', 'lenders.view', 'lenders.manage',
  ],
};

const DEFAULT_SETTINGS = {
  brokerage: {
    name: 'Your Brokerage',
    broker_name: 'Your Broker',
    phone: '',
    email: '',
    website: '',
    address: '',
    welcome_message: 'Your mortgage journey starts here.',
    primary_color: '#1f4fd8',
    logo_text: '',
  },
  client_steps: [
    { key: 'application', label: 'Application' },
    { key: 'documents', label: 'Documents' },
    { key: 'review', label: 'Review' },
    { key: 'submission', label: 'Submission' },
    { key: 'approval', label: 'Approval' },
    { key: 'closing', label: 'Closing' },
  ],
  reminders: {
    enabled: true,
    cadence_days: [2, 5, 7],
    max_reminders: 3,
    min_hours_between: 24,
  },
  automation: {
    task_on_all_docs_uploaded: true,
    task_on_client_message: false,
    notify_all_staff_if_unassigned: true,
    // Date-driven workflow rules create tasks freely. Letting them email a
    // real client needs a deliberate decision, so it is off until switched on.
    workflow_client_email: false,
  },
  // The stress test and the ratio guidelines the qualification engine judges
  // a file against. Published figures move, so they are settings rather than
  // constants in the code.
  qualification: {
    buffer_pct: 2.0,
    floor_rate: 5.25,
    gds_limit: 39,
    tds_limit: 44,
  },
  uploads: {
    max_mb: 25,
    allowed_ext: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'],
  },
  security: {
    // Idle windows; the absolute lifetime below is never extended by activity.
    session_days_staff: 1,
    session_days_client: 7,
    session_absolute_hours_staff: 12,
    session_absolute_hours_client: 336,
    // Lockout is a last resort — rate limiting does the primary work, so the
    // threshold is high enough that it is not a practical way to lock a
    // broker out of their own account (audit finding H8).
    lockout_threshold: 8,
    lockout_minutes: 15,
    min_password_length_staff: 12,
    min_password_length_client: 10,
    mfa_required_roles: ['admin', 'manager', 'broker', 'processor'],
  },
  ai_review: {
    // Off until the brokerage turns it on AND the server is configured with a
    // processing agreement reference (audit finding C6).
    enabled: false,
    require_client_consent: true,
  },
  retention: {
    policy_note:
      'Configure retention according to your legal and regulatory obligations. Records are archived, never silently deleted.',
    archive_completed_after_days: null,
    archive_inactive_after_days: null,
  },
  notifications: {
    auto_send_welcome: true,
    email_broker_on_client_upload: false,
    email_broker_on_client_message: false,
  },
  role_permissions: DEFAULT_ROLE_PERMISSIONS,
};

const EMPLOYMENT_STATUSES = [
  ['employee', 'Employee'],
  ['self_employed', 'Self-Employed'],
];

/**
 * Statuses and services that shipped in earlier versions and are no longer
 * offered. They are deactivated rather than deleted: files created under them
 * still reference the row, and an admin can turn any of them back on under
 * Settings.
 */
const RETIRED_EMPLOYMENT_STATUSES = ['corporation_owner', 'commissioned', 'contract_worker', 'retired', 'unemployed', 'other'];
const RETIRED_APPLICATION_TYPES = ['builder_purchase', 'fthb'];

const STAGES = [
  ['new_inquiry',        'New Inquiry',              'Getting started',                'We have received your information and will be in touch shortly.', 1, '#8b5cf6', 0, 0],
  ['initial_contact',    'Initial Contact',          'Getting started',                'Your broker is gathering the details of your application.', 1, '#8b5cf6', 0, 0],
  ['application_started','Application Started',      'Application in progress',        'Your application has been started. Watch for document requests.', 1, '#6366f1', 0, 0],
  ['docs_requested',     'Documents Requested',      'Documents needed',               'Please upload the requested documents so we can keep things moving.', 2, '#f59e0b', 1, 0],
  ['docs_received',      'Documents Received',       'Documents received',             'Thanks! We have your documents and will review them shortly.', 2, '#f59e0b', 0, 0],
  ['broker_review',      'Broker Review',            'Your application is being reviewed', 'Your broker is reviewing your application and documents.', 3, '#0ea5e9', 0, 0],
  ['ready_to_submit',    'Ready to Submit',          'Preparing your submission',      'Your application is being prepared for submission to the lender.', 3, '#0ea5e9', 0, 0],
  ['submitted',          'Submitted',                'Submitted to lender',            'Your application has been submitted. We will update you as soon as we hear back.', 4, '#14b8a6', 1, 0],
  ['lender_review',      'Lender Review',            'Lender is reviewing',            'The lender is reviewing your application.', 4, '#14b8a6', 0, 0],
  ['conditional_approval','Conditional Approval',    'Conditionally approved',         'Great news — your application is conditionally approved. A few items may still be needed.', 5, '#22c55e', 1, 1],
  ['conditions_outstanding','Conditions Outstanding','A few items are needed',         'A few conditions are outstanding. Your broker will let you know exactly what is needed.', 5, '#f97316', 0, 0],
  ['final_approval',     'Final Approval',           'Approved',                       'Congratulations — your mortgage is approved!', 5, '#16a34a', 1, 0],
  ['closing',            'Closing',                  'Closing',                        'Your file is with the lawyers for closing. Almost there!', 6, '#16a34a', 0, 0],
  ['funded',             'Funded',                   'Funded',                         'Your mortgage has funded. Congratulations!', 6, '#15803d', 1, 0],
  ['completed',          'Completed',                'Completed',                      'Your file is complete. Thank you for working with us!', 6, '#334155', 0, 1],
  ['cancelled',          'Cancelled / Not Proceeding','Not proceeding',                'This application is not proceeding. Contact your broker with any questions.', 1, '#64748b', 0, 1],
];

const APPLICATION_TYPES = [
  ['purchase', 'Purchase'],
  ['refinance', 'Refinance'],
  ['business_loan', 'Business Loan'],
];

const DOCUMENT_TYPES = [
  // key, name, category, description
  // The order here is the order a client sees, so it follows the brokerage's
  // own intake list rather than the alphabet.
  ['equifax_credit_report', 'Equifax Credit Report', 'credit', 'Full report downloaded from Equifax Canada.'],
  ['government_id', 'Two Pieces of Government ID', 'identity', "Passport, driver's licence, or PR card. Health cards are not accepted."],

  // Employee income
  ['employment_letter', 'Recent Job Letter', 'income', 'Signed and dated, stating your position, salary or hourly rate, and start date.'],
  ['pay_stub', 'Three Recent Pay Stubs', 'income', 'Your three most recent pay stubs.'],
  ['t4', 'T4 Slips (2024 & 2025)', 'income', 'Your T4 slips for both 2024 and 2025.'],
  ['t1_general', 'T1 General (2024 & 2025)', 'income', 'Your complete T1 General return for both 2024 and 2025.'],
  ['noa', 'Notice of Assessment (2024 & 2025)', 'income', 'Your CRA Notice of Assessment for both 2024 and 2025.'],
  ['bank_statements', 'Bank Statements — Last 3 Months', 'financial', 'Your last three months of bank statements.'],

  // Self-employed
  ['asset_breakdown', 'Breakdown of Assets', 'financial', 'Vehicles: year, make, model and estimated market value. Investments: balance details for TFSA, RRSP, savings and other liquid accounts.'],
  ['business_bank_statements', 'Business Bank Statements — Last 12 Months', 'financial', 'Your last twelve months of business bank statements.'],
  ['personal_bank_statements', 'Personal Bank Statements — Last 6 Months', 'financial', 'Your last six months of personal bank statements.'],
  ['t2_corporate', 'T2 Corporate Income Tax Returns (2024 & 2025)', 'corporate', 'Your corporation\'s T2 returns for both 2024 and 2025.'],
  ['corporate_noa', 'Corporate Notice of Assessment (2024 & 2025)', 'corporate', 'The CRA Notice of Assessment issued to your corporation for both 2024 and 2025.'],
  ['certificate_of_incorporation', 'Certificate of Incorporation', 'corporate', 'The certificate of incorporation for your business.'],

  // Refinance
  ['mortgage_statement', 'Current Mortgage Statement', 'property', 'Your most recent statement for the mortgage being refinanced.'],
  ['property_tax_bill', 'Final Property Tax Bill 2026', 'property', 'The final (not interim) property tax bill for 2026.'],

  // Still in the catalog so a broker can add them to an individual file, but
  // no longer pulled in by any default rule.
  ['purchase_agreement', 'Purchase Agreement', 'property', 'The fully signed Agreement of Purchase and Sale.'],
  ['mls_listing', 'MLS Listing', 'property', 'The MLS listing for the property.'],
  ['down_payment_verification', 'Down Payment Verification', 'financial', '90-day history of the account(s) holding your down payment.'],
  ['gift_letter', 'Gift Letter', 'financial', 'A signed gift letter if part of your down payment is a gift.'],
  ['home_insurance', 'Home Insurance', 'property', 'Proof of home insurance.'],
  ['void_cheque', 'Void Cheque / PAD Form', 'financial', 'A void cheque or pre-authorized debit form.'],
  ['business_financials', 'Business Financial Statements', 'financial', 'Business financial statements for the last 2 years.'],
  ['articles_of_incorporation', 'Articles of Incorporation', 'corporate', 'Articles of incorporation for your business.'],
];

/**
 * Rule conditions JSON:
 *   application_type_keys: [..]  — match any (empty/omitted = any type)
 *   employment_types: [..]       — applicant-level; items become per-applicant for matching applicants
 *   fthb: true                   — only when file is first-time home buyer
 * Items: [document_type_key, requirement, per_applicant, expires_days]
 */
const DOCUMENT_RULES = [
  {
    name: 'All applications — credit & identification',
    conditions: {},
    items: [
      ['equifax_credit_report', 'required', 1, null],
      ['government_id', 'required', 1, null],
    ],
  },
  {
    name: 'Employees — income & banking',
    conditions: { employment_types: ['employee'] },
    items: [
      ['employment_letter', 'required', 1, 90],
      ['pay_stub', 'required', 1, 60],
      ['t4', 'required', 1, null],
      ['t1_general', 'required', 1, null],
      ['noa', 'required', 1, null],
      ['bank_statements', 'required', 1, null],
    ],
  },
  {
    name: 'Self-employed — assets, banking, tax & corporate',
    conditions: { employment_types: ['self_employed'] },
    items: [
      ['asset_breakdown', 'required', 1, null],
      ['business_bank_statements', 'required', 1, null],
      ['personal_bank_statements', 'required', 1, null],
      ['t1_general', 'required', 1, null],
      ['noa', 'required', 1, null],
      ['t2_corporate', 'required', 1, null],
      ['corporate_noa', 'required', 1, null],
      ['certificate_of_incorporation', 'required', 1, null],
    ],
  },
  {
    name: 'Refinance — property documents',
    conditions: { application_type_keys: ['refinance'] },
    items: [
      ['mortgage_statement', 'required', 0, null],
      ['property_tax_bill', 'required', 0, null],
    ],
  },
  {
    name: 'Business loans',
    conditions: { application_type_keys: ['business_loan'] },
    items: [
      ['articles_of_incorporation', 'required', 0, null],
      ['business_financials', 'required', 0, null],
    ],
  },
];


const EMAIL_TEMPLATES = [
  {
    key: 'welcome',
    name: 'Welcome / account credentials',
    subject: 'Welcome to {{brokerage_name}}',
    body: `Hi {{client_first_name}},

Welcome to {{brokerage_name}}.

We have created your secure mortgage client portal. Use it to see exactly where your application stands, upload documents, and message {{broker_name}}.

You can access your account here:
{{portal_link}}

Username:
{{username}}

Temporary Password:
{{temporary_password}}

Please log in and change your temporary password after your first login.

If you have any questions, please contact {{broker_name}}.

Best,
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    subject: 'Reset your {{brokerage_name}} portal password',
    body: `Hi {{client_first_name}},

We received a request to reset your portal password. Use the link below to choose a new one:

{{portal_link}}

If you didn't request this, you can safely ignore this email.

{{brokerage_name}}`,
  },
  {
    key: 'stage_changed',
    name: 'Application stage update',
    subject: 'Update on your mortgage application',
    body: `Hi {{client_first_name}},

Good news — there's an update on your application.

Status: {{application_stage}}

Log in to your portal to see the details and any next steps:
{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_requested',
    name: 'Document requested',
    subject: 'We need a document from you: {{document_name}}',
    body: `Hi {{client_first_name}},

To keep your application moving, please upload the following document:

{{document_name}}

You can upload it in a few taps from your phone:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_reminder',
    name: 'Document reminder',
    subject: 'Friendly reminder: {{document_name}} still needed',
    body: `Hi {{client_first_name}},

Just a friendly reminder that we're still waiting on:

{{document_name}}

Upload it here whenever you're ready:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_rejected',
    name: 'Document needs replacement',
    subject: 'One of your documents needs a replacement',
    body: `Hi {{client_first_name}},

We reviewed your {{document_name}} and need an updated copy.

Please log in to see the details and upload a replacement:
{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'document_approved',
    name: 'Document approved',
    subject: 'Your {{document_name}} has been approved',
    body: `Hi {{client_first_name}},

Your {{document_name}} has been reviewed and approved. Nothing else is needed for this item.

See your progress here:
{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'new_message',
    name: 'New message notification',
    subject: 'New message from {{broker_name}}',
    body: `Hi {{client_first_name}},

You have a new message from {{broker_name}} in your client portal.

Read and reply here:
{{portal_link}}

{{brokerage_name}}`,
  },
  {
    key: 'generic_update',
    name: 'Important application update',
    subject: 'An update on your mortgage application',
    body: `Hi {{client_first_name}},

There's an update on your mortgage application. Please log in to your portal for the details:

{{portal_link}}

{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'documents_outstanding',
    name: 'Outstanding documents summary',
    subject: 'Documents Required for Your Mortgage Application',
    body: `Hi {{client_first_name}},

We still need the following documents:

{{document_list}}

Please log in to your client portal to upload them:

{{portal_link}}

Thank you!
{{broker_name}}
{{brokerage_name}}`,
  },
  {
    key: 'staff_invite',
    name: 'Staff invitation',
    subject: 'Your {{brokerage_name}} account',
    body: `Hi {{client_first_name}},

An administrator has created a brokerage account for you at {{brokerage_name}}.

Use the link below to set your own password and finish setting up your account. The link works once and expires in 7 days.

{{portal_link}}

No password was set for you, so this link is the only way in. If you were not expecting this email, tell your administrator — do not use the link.

— {{brokerage_name}} platform`,
  },
  {
    key: 'staff_notification',
    name: 'Staff notification (internal)',
    subject: '{{notification_title}}',
    body: `{{notification_title}}

{{notification_body}}

Open the broker portal for details:
{{portal_link}}

— {{brokerage_name}} platform`,
  },
];

async function seedIfNeeded() {
  // Settings
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if ((await getSetting(key, undefined)) === undefined) await setSetting(key, value);
  }

  // Stages
  if (!(await get('SELECT id FROM stages LIMIT 1'))) {
    for (const [i, [key, name, clientLabel, clientMessage, step, color, sendEmail, isTerminal]] of STAGES.entries()) {
      await run(
        `INSERT INTO stages (key, name, client_label, client_message, client_step, color, sort, send_email, email_template_key, is_terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key, name, clientLabel, clientMessage, step, color, (i + 1) * 10, sendEmail, sendEmail ? 'stage_changed' : null, isTerminal
      );
    }
  }

  // Application types (services)
  if (!(await get('SELECT id FROM application_types LIMIT 1'))) {
    for (const [i, [key, name]] of APPLICATION_TYPES.entries()) {
      await run('INSERT INTO application_types (key, name, sort) VALUES (?, ?, ?)', key, name, (i + 1) * 10);
    }
  }

  // Employment statuses (configurable; seeded once, then admin-managed)
  if (!(await get('SELECT id FROM employment_statuses LIMIT 1'))) {
    for (const [i, [key, name]] of EMPLOYMENT_STATUSES.entries()) {
      await run('INSERT INTO employment_statuses (key, name, sort) VALUES (?, ?, ?)', key, name, (i + 1) * 10);
    }
  }

  // Document types
  if (!(await get('SELECT id FROM document_types LIMIT 1'))) {
    for (const [i, [key, name, category, description]] of DOCUMENT_TYPES.entries()) {
      await run(
        'INSERT INTO document_types (key, name, category, description, sort) VALUES (?, ?, ?, ?, ?)',
        key, name, category, description, (i + 1) * 10
      );
    }
  }

  // Document rules
  if (!(await get('SELECT id FROM document_rules LIMIT 1'))) {
    await insertDocumentRules();
  }

  // Email templates
  for (const t of EMAIL_TEMPLATES) {
    if (!(await get('SELECT key FROM email_templates WHERE key = ?', t.key))) {
      await run(
        'INSERT INTO email_templates (key, name, subject, body, active) VALUES (?, ?, ?, ?, 1)',
        t.key, t.name, t.subject, t.body
      );
    }
  }

  await seedLenders();
  await seedWorkflowRules();
  await applyPermissionUpgrades();
  await applyCatalogUpgrades();
  await bootstrapAdmin();
}

/**
 * A small, honest starter catalog.
 *
 * These are placeholder partner records with placeholder rates, not a live
 * rate feed — a brokerage replaces them with its own lender panel. They exist
 * so the product-matching screen has something to demonstrate against rather
 * than opening onto an empty table.
 */
const LENDERS = [
  {
    name: 'Example Prime Trust', kind: 'prime',
    products: [
      ['3 Year Fixed — Standard', 4.59, 'fixed', 36, 300, 'any', 95, 600, 'ON,BC,AB,MB,SK,NS,NB,PE,NL', 'purchase,refinance,fthb,builder_purchase', 'owner_occupied,second_home', 120],
      ['5 Year Fixed — Standard', 4.29, 'fixed', 60, 300, 'any', 95, 600, 'ON,BC,AB,MB,SK,NS,NB,PE,NL', 'purchase,refinance,fthb,builder_purchase', 'owner_occupied,second_home', 120],
      ['5 Year Variable — Prime less', 4.95, 'variable', 60, 300, 'any', 80, 650, 'ON,BC,AB', 'purchase,refinance,fthb', 'owner_occupied', 90],
    ],
  },
  {
    name: 'Example Alternative Lending', kind: 'alternative',
    products: [
      ['1 Year Fixed — Alt A', 6.49, 'fixed', 12, 360, 'uninsurable', 80, 550, 'ON,BC,AB', 'purchase,refinance', 'owner_occupied,rental', 60],
      ['2 Year Fixed — Business for Self', 6.19, 'fixed', 24, 360, 'uninsurable', 75, 550, 'ON,BC,AB', 'purchase,refinance,business_loan', 'owner_occupied,rental', 60],
    ],
  },
];

async function seedLenders() {
  if (await get('SELECT id FROM lenders LIMIT 1')) return;
  for (const [i, lender] of LENDERS.entries()) {
    const row = await get(
      `INSERT INTO lenders (name, kind, notes, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id`,
      lender.name, lender.kind,
      'Sample record — replace with your brokerage’s own lender panel and current rates.',
      (i + 1) * 10, now(), now()
    );
    for (const [name, rate, rateType, term, amort, insurability, maxLtv, minScore, provinces, purposes, occupancy, hold] of lender.products) {
      await run(
        `INSERT INTO lender_products
           (lender_id, name, rate, rate_type, term_months, max_amortization_months, compounding, insurability,
            max_ltv, min_credit_score, eligible_provinces, eligible_purposes, eligible_occupancy, rate_hold_days,
            notes, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'semi_annual', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        row.id, name, rate, rateType, term, amort, insurability, maxLtv, minScore,
        provinces, purposes, occupancy, hold, 'Sample rate — not a live quote.', now(), now()
      );
    }
  }
}

/**
 * Starter automation. Every one of these creates a task for a human rather
 * than emailing a client, because an automation engine that reaches real
 * clients on its own should be something a brokerage switches on knowingly.
 */
const WORKFLOW_RULES = [
  {
    name: 'Chase the lender three days after submission',
    trigger_field: 'submitted_at', offset_days: 3, offset_direction: 'after',
    action: 'task', task_title: 'Follow up with the lender on {{file_number}}',
    task_description: 'No decision yet three days after submission. Call the underwriter.',
    task_priority: 'normal',
  },
  {
    name: 'Conditions due in five days',
    trigger_field: 'conditions_due_date', offset_days: 5, offset_direction: 'before',
    action: 'task', task_title: 'Conditions due {{due_date}} on {{file_number}}',
    task_description: 'Check every outstanding condition and chase what is missing.',
    task_priority: 'high',
  },
  {
    name: 'Two weeks before closing',
    trigger_field: 'closing_date', offset_days: 14, offset_direction: 'before',
    action: 'task', task_title: 'Pre-closing check on {{file_number}}',
    task_description: 'Confirm the solicitor has instructions, insurance is in place and the client knows what to expect.',
    task_priority: 'high',
  },
  {
    name: 'Rate hold expires in ten days',
    trigger_field: 'rate_hold_expires_at', offset_days: 10, offset_direction: 'before',
    action: 'task', task_title: 'Rate hold expiring on {{file_number}}',
    task_description: 'Re-price or extend the hold before it lapses.',
    task_priority: 'high',
  },
  {
    name: 'Renewal conversation, 150 days before maturity',
    trigger_field: 'maturity_date', offset_days: 150, offset_direction: 'before',
    action: 'task', task_title: 'Start the renewal conversation for {{file_number}}',
    task_description: 'Maturity is approaching. Reach out before the incumbent lender does.',
    task_priority: 'normal',
  },
];

async function seedWorkflowRules() {
  if (await get('SELECT id FROM workflow_rules LIMIT 1')) return;
  for (const rule of WORKFLOW_RULES) {
    await run(
      `INSERT INTO workflow_rules
         (name, active, stage_key, trigger_field, offset_days, offset_direction, action,
          task_title, task_description, task_priority, assignee, created_at, updated_at)
       VALUES (?, 1, '', ?, ?, ?, ?, ?, ?, ?, 'assigned_broker', ?, ?)`,
      rule.name, rule.trigger_field, rule.offset_days, rule.offset_direction, rule.action,
      rule.task_title, rule.task_description, rule.task_priority, now(), now()
    );
  }
}

/**
 * Catalog upgrades for deployments that were seeded before the intake list was
 * rewritten.
 *
 * The seed blocks above only fire on an empty table, so an existing brokerage
 * would keep the old services, employment statuses and document rules forever.
 * This brings those in line, once, and records that it ran.
 *
 * It is deliberately conservative: nothing is deleted. Retired services and
 * employment statuses are deactivated so historical files still resolve their
 * row, retired documents stay in the catalog so a broker can still add one to
 * an individual file by hand, and only rules this file has ever authored are
 * replaced — a rule an admin wrote themselves is left alone.
 */
const RETIRED_DOCUMENT_RULES = [
  'All applications — identification',
  'Business loans',
  'Purchase — property & down payment',
  'Employees — income documents',
  'Self-employed — income documents',
  'Refinance — property documents',
  'First-time home buyers',
];

async function applyCatalogUpgrades() {
  const applied = await getSetting('catalog_upgrades', []);
  if (applied.includes('intake_list_v2')) return;

  for (const [i, [key, name]] of APPLICATION_TYPES.entries()) {
    await run(
      `INSERT INTO application_types (key, name, active, sort) VALUES (?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, active = 1, sort = EXCLUDED.sort`,
      key, name, (i + 1) * 10
    );
  }
  for (const key of RETIRED_APPLICATION_TYPES) {
    await run('UPDATE application_types SET active = 0 WHERE key = ?', key);
  }

  for (const [i, [key, name]] of EMPLOYMENT_STATUSES.entries()) {
    await run(
      `INSERT INTO employment_statuses (key, name, active, sort) VALUES (?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, active = 1, sort = EXCLUDED.sort`,
      key, name, (i + 1) * 10
    );
  }
  for (const key of RETIRED_EMPLOYMENT_STATUSES) {
    await run('UPDATE employment_statuses SET active = 0 WHERE key = ?', key);
  }

  for (const [i, [key, name, category, description]] of DOCUMENT_TYPES.entries()) {
    await run(
      `INSERT INTO document_types (key, name, category, description, active, sort)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE
          SET name = EXCLUDED.name, category = EXCLUDED.category,
              description = EXCLUDED.description, active = 1, sort = EXCLUDED.sort`,
      key, name, category, description, (i + 1) * 10
    );
  }

  // Rules are replaced rather than edited: their item order is what decides the
  // order the client sees, and editing in place cannot express a reordering.
  const replaceable = [...RETIRED_DOCUMENT_RULES, ...DOCUMENT_RULES.map((r) => r.name)];
  for (const name of replaceable) {
    const rows = await all('SELECT id FROM document_rules WHERE name = ?', name);
    for (const row of rows) {
      await run('DELETE FROM document_rule_items WHERE rule_id = ?', row.id);
      await run('DELETE FROM document_rules WHERE id = ?', row.id);
    }
  }
  await insertDocumentRules();

  await setSetting('catalog_upgrades', [...applied, 'intake_list_v2']);
}

/** Insert DOCUMENT_RULES in order; item order within a rule is the client's order. */
async function insertDocumentRules() {
  for (const rule of DOCUMENT_RULES) {
    const ruleRow = await get(
      'INSERT INTO document_rules (name, active, conditions, created_at, updated_at) VALUES (?, 1, ?, ?, ?) RETURNING id',
      rule.name, JSON.stringify(rule.conditions), now(), now()
    );
    for (const [docKey, requirement, perApplicant, expiresDays] of rule.items) {
      const doc = await get('SELECT id FROM document_types WHERE key = ?', docKey);
      if (!doc) continue;
      await run(
        'INSERT INTO document_rule_items (rule_id, document_type_id, requirement, per_applicant, expires_days) VALUES (?, ?, ?, ?, ?)',
        ruleRow.id, doc.id, requirement, perApplicant, expiresDays
      );
    }
  }
}

async function applyPermissionUpgrades() {
  const applied = await getSetting('permission_upgrades', []);
  const pending = Object.entries(PERMISSION_UPGRADES).filter(([name]) => !applied.includes(name));
  if (!pending.length) return;

  const stored = await getSetting('role_permissions', DEFAULT_ROLE_PERMISSIONS);
  const next = { ...stored };
  for (const [, keys] of pending) {
    for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS)) {
      const current = new Set(next[role] || DEFAULT_ROLE_PERMISSIONS[role] || []);
      for (const key of keys) {
        if ((DEFAULT_ROLE_PERMISSIONS[role] || []).includes(key)) current.add(key);
      }
      next[role] = [...current];
    }
  }
  await setSetting('role_permissions', next);
  await setSetting('permission_upgrades', [...applied, ...pending.map(([name]) => name)]);
}

/**
 * Create the first administrator (audit finding C4).
 *
 * There is deliberately no default password. ADMIN_PASSWORD, when supplied,
 * must satisfy the staff password policy; otherwise a strong random one is
 * generated and printed once. Either way the account is flagged
 * must_change_password, so the bootstrap credential cannot become a standing
 * one, and MFA enrolment is then required on first sign-in.
 */
async function bootstrapAdmin() {
  if (await get("SELECT id FROM users WHERE role <> 'client' LIMIT 1")) return null;

  const { hashPassword, validatePasswordStrength, generateTemporaryPassword } = require('./auth');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) {
    // Deliberately NOT fatal.
    //
    // This used to throw, which took the whole application down — every
    // route, including the login page and the liveness probe — leaving an
    // operator with a 500 and no way to see why. On a managed host that is
    // the worst possible failure mode.
    //
    // Instead the app boots with no staff account and serves the one-time
    // setup flow (POST /api/auth/setup), which is gated on a token the
    // operator sets themselves. No account exists until they claim it, so
    // this is not a default account and not a backdoor.
    console.warn(
      '[setup] No administrator exists yet. Set ADMIN_SETUP_TOKEN and claim the first ' +
      'account at /setup, or set ADMIN_EMAIL to provision one at boot.'
    );
    return null;
  }

  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (password) {
    // A supplied bootstrap password is held to the same policy as any other
    // staff password — no weak value can enter the system this way.
    await validatePasswordStrength(password, { role: 'admin', user: { email } });
  } else {
    password = generateTemporaryPassword(6);
    generated = true;
  }

  await run(
    `INSERT INTO users (role, email, first_name, last_name, password_hash, status, must_change_password, created_at, updated_at)
     VALUES ('admin', ?, 'Admin', 'User', ?, 'active', 1, ?, ?)`,
    email, await hashPassword(password), now(), now()
  );

  if (generated) {
    console.log('--------------------------------------------------------------');
    console.log('  Created the first administrator account.');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    console.log('  This is shown once. You must change it at first sign-in,');
    console.log('  and then enrol in two-step verification.');
    console.log('--------------------------------------------------------------');
  }
  return { email, generated };
}

module.exports = {
  seedIfNeeded,
  bootstrapAdmin,
  applyPermissionUpgrades,
  applyCatalogUpgrades,
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_UPGRADES,
  DEFAULT_EMAIL_TEMPLATES: EMAIL_TEMPLATES,
};
