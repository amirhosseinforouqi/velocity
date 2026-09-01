-- ---------------------------------------------------------------------------
-- Mortgage client platform — PostgreSQL schema (Supabase-compatible).
--
-- Timestamp columns are stored as ISO-8601 UTC TEXT rather than TIMESTAMPTZ.
-- This is deliberate: ISO-8601 UTC sorts and range-scans correctly as text,
-- and it keeps the application's existing comparison semantics byte-for-byte
-- identical through the SQLite→Postgres migration, which matters more than
-- type purity in a system of record for financial documents. Migrating these
-- to TIMESTAMPTZ is tracked as a follow-up.
--
-- Boolean-ish columns are SMALLINT 0/1 with CHECK constraints for the same
-- reason — the application's truthiness logic is preserved exactly.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  password_hash         TEXT,
  status                TEXT NOT NULL DEFAULT 'invited',
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  welcomed_at           TEXT,
  must_change_password  SMALLINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  mfa_secret            TEXT,
  mfa_enrolled_at       TEXT,
  mfa_last_used_step    BIGINT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
-- Case-insensitive uniqueness; all writes normalize to lowercase already.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON mfa_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at  TEXT,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        TEXT,
  ip           TEXT,
  success      SMALLINT NOT NULL CHECK (success IN (0,1)),
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, attempted_at);

-- Distributed rate limiting: works across serverless instances because the
-- counter lives in the database, not in process memory.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_types (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    TEXT UNIQUE,
  name   TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employment_statuses (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    TEXT UNIQUE,
  name   TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                TEXT UNIQUE,
  name               TEXT NOT NULL,
  client_label       TEXT NOT NULL DEFAULT '',
  client_message     TEXT NOT NULL DEFAULT '',
  client_step        INTEGER NOT NULL DEFAULT 1,
  color              TEXT NOT NULL DEFAULT '#4f6ef7',
  icon               TEXT NOT NULL DEFAULT '',
  sort               INTEGER NOT NULL DEFAULT 0,
  active             SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  send_email         SMALLINT NOT NULL DEFAULT 0 CHECK (send_email IN (0,1)),
  email_template_key TEXT,
  create_task        SMALLINT NOT NULL DEFAULT 0 CHECK (create_task IN (0,1)),
  task_title         TEXT NOT NULL DEFAULT '',
  is_terminal        SMALLINT NOT NULL DEFAULT 0 CHECK (is_terminal IN (0,1))
);

CREATE TABLE IF NOT EXISTS client_files (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_number          TEXT NOT NULL UNIQUE,
  application_type_id  INTEGER REFERENCES application_types(id),
  stage_id             INTEGER REFERENCES stages(id),
  assigned_broker_id   INTEGER REFERENCES users(id),
  purchase_price       NUMERIC(14,2),
  down_payment         NUMERIC(14,2),
  mortgage_amount      NUMERIC(14,2),
  property_address     TEXT NOT NULL DEFAULT '',
  property_type        TEXT NOT NULL DEFAULT '',
  closing_date         TEXT,
  fthb                 SMALLINT NOT NULL DEFAULT 0 CHECK (fthb IN (0,1)),
  purpose              TEXT NOT NULL DEFAULT '',
  extra_info           TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'active',
  -- Per-file consent to automated (Claude) document review, with when it
  -- was recorded and how, so the decision is auditable (audit finding C6).
  ai_consent           SMALLINT NOT NULL DEFAULT 0 CHECK (ai_consent IN (0,1)),
  ai_consent_at        TEXT,
  ai_consent_source    TEXT,
  onedrive_folder_id   TEXT,
  onedrive_folder_path TEXT,
  onedrive_status      TEXT,
  onedrive_attempts    INTEGER NOT NULL DEFAULT 0,
  onedrive_error       TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_activity_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_status ON client_files(status);
CREATE INDEX IF NOT EXISTS idx_files_status_broker ON client_files(status, assigned_broker_id);
CREATE INDEX IF NOT EXISTS idx_files_activity ON client_files(status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_onedrive ON client_files(onedrive_status);

CREATE TABLE IF NOT EXISTS applicants (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  role              TEXT NOT NULL DEFAULT 'primary',
  first_name        TEXT NOT NULL,
  middle_name       TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL,
  preferred_name    TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  dob               TEXT,
  address           TEXT NOT NULL DEFAULT '',
  preferred_contact TEXT NOT NULL DEFAULT 'email',
  employment_type   TEXT NOT NULL DEFAULT '',
  employer_name     TEXT NOT NULL DEFAULT '',
  job_title         TEXT NOT NULL DEFAULT '',
  employment_notes  TEXT NOT NULL DEFAULT '',
  portal_user_id    INTEGER REFERENCES users(id),
  -- When 1, this applicant may see documents belonging to other applicants
  -- on the same file. Off by default: a guarantor must not inherit the
  -- primary borrower's ID and bank statements (audit finding H3).
  shares_documents  SMALLINT NOT NULL DEFAULT 0 CHECK (shares_documents IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applicants_file ON applicants(file_id);
CREATE INDEX IF NOT EXISTS idx_applicants_portal_user ON applicants(portal_user_id);

CREATE TABLE IF NOT EXISTS document_types (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                   TEXT UNIQUE,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other',
  description           TEXT NOT NULL DEFAULT '',
  active                SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort                  INTEGER NOT NULL DEFAULT 0,
  default_requirement   TEXT NOT NULL DEFAULT 'required',
  default_per_applicant SMALLINT NOT NULL DEFAULT 0 CHECK (default_per_applicant IN (0,1)),
  default_expires_days  INTEGER
);

CREATE TABLE IF NOT EXISTS document_rules (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  conditions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_rule_items (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id          INTEGER NOT NULL REFERENCES document_rules(id) ON DELETE CASCADE,
  document_type_id INTEGER NOT NULL REFERENCES document_types(id),
  requirement      TEXT NOT NULL DEFAULT 'required',
  per_applicant    SMALLINT NOT NULL DEFAULT 0 CHECK (per_applicant IN (0,1)),
  expires_days     INTEGER,
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rule_items_rule ON document_rule_items(rule_id);

CREATE TABLE IF NOT EXISTS checklist_exclusions (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  document_type_id INTEGER NOT NULL,
  applicant_id     INTEGER,
  excluded_by      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exclusions_file ON checklist_exclusions(file_id);
-- NULL applicant_id must still collide, so uniqueness uses a sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exclusions_unique
  ON checklist_exclusions (file_id, document_type_id, COALESCE(applicant_id, -1));

CREATE TABLE IF NOT EXISTS document_requests (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id            INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id       INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  document_type_id   INTEGER NOT NULL REFERENCES document_types(id),
  status             TEXT NOT NULL DEFAULT 'required',
  requirement        TEXT NOT NULL DEFAULT 'required',
  source             TEXT NOT NULL DEFAULT 'rule',
  rule_id            INTEGER,
  due_date           TEXT,
  client_message     TEXT NOT NULL DEFAULT '',
  internal_note      TEXT NOT NULL DEFAULT '',
  expires_days       INTEGER,
  expires_at         TEXT,
  current_version_id INTEGER,
  reminders_enabled  SMALLINT NOT NULL DEFAULT 1 CHECK (reminders_enabled IN (0,1)),
  last_reminder_at   TEXT,
  reminder_count     INTEGER NOT NULL DEFAULT 0,
  client_comment     TEXT NOT NULL DEFAULT '',
  created_by         INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_file ON document_requests(file_id);
CREATE INDEX IF NOT EXISTS idx_requests_file_status ON document_requests(file_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_applicant ON document_requests(applicant_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id          INTEGER NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  original_name       TEXT NOT NULL,
  display_name        TEXT NOT NULL DEFAULT '',
  stored_name         TEXT NOT NULL,
  mime                TEXT NOT NULL,
  size                BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'uploaded',
  review_note_client  TEXT NOT NULL DEFAULT '',
  review_note_internal TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM envelope for the stored bytes (audit finding C1).
  enc_envelope        TEXT,
  scan_status         TEXT NOT NULL DEFAULT 'pending',
  scan_result         TEXT,
  onedrive_item_id    TEXT,
  onedrive_path       TEXT,
  onedrive_status     TEXT,
  onedrive_attempts   INTEGER NOT NULL DEFAULT 0,
  onedrive_error      TEXT,
  uploaded_by         INTEGER,
  uploaded_at         TEXT NOT NULL,
  reviewed_by         INTEGER,
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_request ON document_versions(request_id);
CREATE INDEX IF NOT EXISTS idx_versions_onedrive ON document_versions(onedrive_status);

CREATE TABLE IF NOT EXISTS ai_reviews (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id    INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  request_id    INTEGER NOT NULL,
  file_id       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  running_since TEXT,
  model         TEXT,
  result        TEXT,          -- encrypted at rest (envelope JSON)
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_status ON ai_reviews(status);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_version ON ai_reviews(version_id);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  sender_kind       TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  attachment_name   TEXT,
  attachment_stored TEXT,
  attachment_mime   TEXT,
  attachment_size   BIGINT,
  created_at        TEXT NOT NULL,
  edited_at         TEXT,
  read_by_staff_at  TEXT,
  read_by_client_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(file_id, sender_kind, read_by_staff_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id      INTEGER REFERENCES client_files(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  due_date     TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'pending',
  assigned_to  INTEGER REFERENCES users(id),
  source       TEXT NOT NULL DEFAULT 'manual',
  created_by   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_file ON tasks(file_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_date);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  pinned     SMALLINT NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(file_id);

CREATE TABLE IF NOT EXISTS stage_history (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  from_stage_id INTEGER,
  to_stage_id   INTEGER NOT NULL,
  changed_by    INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_history_file ON stage_history(file_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id        INTEGER,
  actor_id       INTEGER,
  actor_name     TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL,
  message        TEXT NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  client_visible SMALLINT NOT NULL DEFAULT 0 CHECK (client_visible IN (0,1)),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_file ON activity_log(file_id, id DESC);

-- Append-only audit trail. A hash chain makes excision detectable: each row
-- carries the hash of the previous row, so removing or editing history breaks
-- the chain (audit finding H9). Revoke UPDATE/DELETE from the app role in
-- production; see docs/DEPLOYMENT.md.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  ip         TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  prev_hash  TEXT,
  row_hash   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  file_id    INTEGER,
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS email_templates (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS email_log (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_email     TEXT NOT NULL,
  to_name      TEXT NOT NULL DEFAULT '',
  user_id      INTEGER,
  file_id      INTEGER,
  template_key TEXT,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_log_file ON email_log(file_id, id DESC);

CREATE TABLE IF NOT EXISTS consent_forms (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  active     SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS consents (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id            INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id       INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  form_id            INTEGER NOT NULL,
  form_title         TEXT NOT NULL,
  form_version       INTEGER NOT NULL,
  form_body_snapshot TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'requested',
  requested_by       INTEGER,
  requested_at       TEXT NOT NULL,
  responded_at       TEXT,
  responded_by       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consents_file ON consents(file_id);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ===========================================================================
-- Deal module (v2)
--
-- Everything below extends the original client-file model with the data a
-- Canadian mortgage brokerage actually underwrites against: qualification
-- arithmetic (GDS/TDS/LTV/net worth), the subject property's carrying costs,
-- mortgage requests with parallel contract and stress-test rates, a lender
-- product catalog, and the FINTRAC compliance record.
--
-- Additive only. Nothing here changes or drops an existing column, so an
-- existing database migrates by running this file again.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Lifecycle dates on the file.
--
-- These are the trigger points every piece of date-driven automation hangs
-- off (see workflow_rules). They are indexed because the nightly workflow
-- pass range-scans them across the whole book.
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS province                TEXT NOT NULL DEFAULT '';
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS lead_at                 TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS application_at          TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS submitted_at            TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS approved_at             TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS accepted_at             TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS conditions_met_at       TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS funded_at               TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS lender_payment_at       TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS appraisal_ordered_at    TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS appraisal_received_at   TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS solicitor_instructed_at TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS conditions_due_date     TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS rate_hold_expires_at    TEXT;
ALTER TABLE client_files ADD COLUMN IF NOT EXISTS maturity_date           TEXT;
CREATE INDEX IF NOT EXISTS idx_files_maturity ON client_files(status, maturity_date);
CREATE INDEX IF NOT EXISTS idx_files_rate_hold ON client_files(status, rate_hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_files_closing ON client_files(status, closing_date);

-- Contact-level fields the original model had no room for. CASL consent is
-- first-class rather than a generic boolean: Canadian anti-spam law needs to
-- know when and how consent was captured, and it gates marketing sends.
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS language            TEXT NOT NULL DEFAULT 'en';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS marital_status      TEXT NOT NULL DEFAULT '';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS dependents          INTEGER;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS residency           TEXT NOT NULL DEFAULT '';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS credit_score        INTEGER;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS credit_pulled_at    TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS credit_bureau       TEXT NOT NULL DEFAULT '';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS casl_consent        SMALLINT NOT NULL DEFAULT 0 CHECK (casl_consent IN (0,1));
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS casl_consent_at     TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS casl_consent_source TEXT NOT NULL DEFAULT '';

-- Document dimensions the linear status genuinely cannot express. The
-- lifecycle (required → uploaded → approved) stays exactly as it was, because
-- it drives the client portal and the reminder engine; these are the
-- orthogonal facts that sit beside it.
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS is_condition     SMALLINT NOT NULL DEFAULT 0 CHECK (is_condition IN (0,1));
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS is_compliance    SMALLINT NOT NULL DEFAULT 0 CHECK (is_compliance IN (0,1));
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS esign_required   SMALLINT NOT NULL DEFAULT 0 CHECK (esign_required IN (0,1));
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS esign_completed_at TEXT;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS sent_to_lender_at  TEXT;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS sent_to_lender_by  INTEGER;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS lender_reference   TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- Subject property. 1:1 with the file, kept in its own table so the hot
-- client_files row (selected on every list and dashboard query) does not grow
-- forty rarely-read columns.
CREATE TABLE IF NOT EXISTS file_properties (
  file_id                 INTEGER PRIMARY KEY REFERENCES client_files(id) ON DELETE CASCADE,
  city                    TEXT NOT NULL DEFAULT '',
  province                TEXT NOT NULL DEFAULT '',
  postal_code             TEXT NOT NULL DEFAULT '',
  dwelling_type           TEXT NOT NULL DEFAULT '',
  dwelling_style          TEXT NOT NULL DEFAULT '',
  tenure                  TEXT NOT NULL DEFAULT '',
  occupancy               TEXT NOT NULL DEFAULT '',
  year_built              INTEGER,
  units                   INTEGER,
  living_space_sqft       INTEGER,
  lot_size                TEXT NOT NULL DEFAULT '',
  heating_type            TEXT NOT NULL DEFAULT '',
  garage                  TEXT NOT NULL DEFAULT '',
  mls_number              TEXT NOT NULL DEFAULT '',
  legal_description       TEXT NOT NULL DEFAULT '',
  zoning                  TEXT NOT NULL DEFAULT '',
  -- Carrying costs. These are GDS inputs, which is why they live here and not
  -- in a notes field: the qualification arithmetic has to be auditable.
  annual_taxes            NUMERIC(14,2),
  tax_year                INTEGER,
  condo_fees_monthly      NUMERIC(14,2),
  condo_fees_include_heat SMALLINT NOT NULL DEFAULT 0 CHECK (condo_fees_include_heat IN (0,1)),
  heating_monthly         NUMERIC(14,2),
  hydro_monthly           NUMERIC(14,2),
  water_monthly           NUMERIC(14,2),
  other_expenses_monthly  NUMERIC(14,2),
  rental_income_monthly   NUMERIC(14,2),
  rental_treatment        TEXT NOT NULL DEFAULT 'offset',
  rental_offset_pct       NUMERIC(6,2),
  estimated_value         NUMERIC(14,2),
  appraisal_value         NUMERIC(14,2),
  appraisal_date          TEXT,
  updated_by              INTEGER,
  updated_at              TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Income, assets and liabilities. Each row is per-applicant where that is
-- meaningful (income always; assets and liabilities may be joint, hence the
-- nullable applicant_id).
CREATE TABLE IF NOT EXISTS applicant_incomes (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id  INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'employment',
  employer      TEXT NOT NULL DEFAULT '',
  job_title     TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  period        TEXT NOT NULL DEFAULT 'annual',
  years_at_source NUMERIC(6,2),
  -- Variable/bonus income a lender will not fully recognise can be carried on
  -- file but excluded from the ratios.
  qualifies     SMALLINT NOT NULL DEFAULT 1 CHECK (qualifies IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incomes_file ON applicant_incomes(file_id);
CREATE INDEX IF NOT EXISTS idx_incomes_applicant ON applicant_incomes(applicant_id);

CREATE TABLE IF NOT EXISTS file_assets (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id   INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'savings',
  description    TEXT NOT NULL DEFAULT '',
  institution    TEXT NOT NULL DEFAULT '',
  value          NUMERIC(14,2) NOT NULL DEFAULT 0,
  down_payment_amount NUMERIC(14,2),
  verified       SMALLINT NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_file ON file_assets(file_id);

CREATE TABLE IF NOT EXISTS file_liabilities (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id    INTEGER REFERENCES applicants(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'credit_card',
  lender          TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  credit_limit    NUMERIC(14,2),
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  monthly_payment NUMERIC(14,2),
  from_bureau     SMALLINT NOT NULL DEFAULT 0 CHECK (from_bureau IN (0,1)),
  include_in_tds  SMALLINT NOT NULL DEFAULT 1 CHECK (include_in_tds IN (0,1)),
  payoff_at_close SMALLINT NOT NULL DEFAULT 0 CHECK (payoff_at_close IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liabilities_file ON file_liabilities(file_id);

-- ---------------------------------------------------------------------------
-- Lender / product catalog. A first-class entity, not a text field on the
-- deal, so that rate shopping can happen in context and a chosen product can
-- be traced back to what it actually was on the day it was chosen.
CREATE TABLE IF NOT EXISTS lenders (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'prime',
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  portal_url    TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  active        SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lender_products (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lender_id          INTEGER NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  rate               NUMERIC(8,4) NOT NULL DEFAULT 0,
  rate_type          TEXT NOT NULL DEFAULT 'fixed',
  term_months        INTEGER NOT NULL DEFAULT 60,
  max_amortization_months INTEGER NOT NULL DEFAULT 300,
  compounding        TEXT NOT NULL DEFAULT 'semi_annual',
  insurability       TEXT NOT NULL DEFAULT 'any',
  max_ltv            NUMERIC(6,2),
  min_credit_score   INTEGER,
  eligible_provinces TEXT NOT NULL DEFAULT '',
  eligible_purposes  TEXT NOT NULL DEFAULT '',
  eligible_occupancy TEXT NOT NULL DEFAULT '',
  finder_fee_bps     INTEGER,
  rate_hold_days     INTEGER,
  prepayment         TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  active             SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_lender ON lender_products(lender_id, active);

-- ---------------------------------------------------------------------------
-- Mortgage requests. A file may carry several (first + second position, or
-- the same deal shopped at two lenders), so the money never collapses onto
-- the file itself.
--
-- contract_* and qualifying_* are deliberately separate column families. The
-- stress test is a regulatory calculation with its own rate and amortization,
-- and reusing one field for both would make it impossible to show a regulator
-- what was actually qualified against.
CREATE TABLE IF NOT EXISTS mortgage_requests (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id             INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  label               TEXT NOT NULL DEFAULT '',
  position            TEXT NOT NULL DEFAULT 'first',
  purpose             TEXT NOT NULL DEFAULT '',
  is_primary          SMALLINT NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  status              TEXT NOT NULL DEFAULT 'draft',
  purchase_price      NUMERIC(14,2),
  property_value      NUMERIC(14,2),
  down_payment        NUMERIC(14,2),
  down_payment_source TEXT NOT NULL DEFAULT '',
  principal           NUMERIC(14,2),
  insurance_premium   NUMERIC(14,2),
  contract_rate       NUMERIC(8,4),
  rate_type           TEXT NOT NULL DEFAULT 'fixed',
  term_type           TEXT NOT NULL DEFAULT 'closed',
  term_months         INTEGER NOT NULL DEFAULT 60,
  amortization_months INTEGER NOT NULL DEFAULT 300,
  payment_frequency   TEXT NOT NULL DEFAULT 'monthly',
  compounding         TEXT NOT NULL DEFAULT 'semi_annual',
  interest_only       SMALLINT NOT NULL DEFAULT 0 CHECK (interest_only IN (0,1)),
  -- NULL means "derive from the brokerage's stress-test policy"; a number
  -- pins it, e.g. when a lender qualifies at its own posted rate.
  qualifying_rate     NUMERIC(8,4),
  qualifying_amortization_months INTEGER,
  lender_id           INTEGER REFERENCES lenders(id) ON DELETE SET NULL,
  product_id          INTEGER REFERENCES lender_products(id) ON DELETE SET NULL,
  lender_name_snapshot  TEXT NOT NULL DEFAULT '',
  product_name_snapshot TEXT NOT NULL DEFAULT '',
  submitted_at        TEXT,
  submission_method   TEXT NOT NULL DEFAULT '',
  submission_note     TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  created_by          INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mortgage_requests_file ON mortgage_requests(file_id);

-- ---------------------------------------------------------------------------
-- FINTRAC / AML compliance.
--
-- Structured, not free text: the answers have to be reportable and the
-- assessment has to be reproducible from the underlying data rather than
-- from a PDF somebody hand-edited.
CREATE TABLE IF NOT EXISTS aml_assessments (
  file_id        INTEGER PRIMARY KEY REFERENCES client_files(id) ON DELETE CASCADE,
  answers        TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'not_started',
  risk_level     TEXT NOT NULL DEFAULT 'unassessed',
  risk_score     INTEGER NOT NULL DEFAULT 0,
  completed_at   TEXT,
  completed_by   INTEGER,
  updated_by     INTEGER,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aml_borrower_checks (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id              INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  applicant_id         INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  id_method            TEXT NOT NULL DEFAULT '',
  id_document_primary  TEXT NOT NULL DEFAULT '',
  id_document_secondary TEXT NOT NULL DEFAULT '',
  id_verified_at       TEXT,
  id_verified_by       INTEGER,
  -- FINTRAC's three PEP categories, each of which extends to family members
  -- and close associates — that is the regulatory definition, so the
  -- relationship is captured rather than assumed to be "self".
  pep_foreign          SMALLINT NOT NULL DEFAULT 0 CHECK (pep_foreign IN (0,1)),
  pep_domestic         SMALLINT NOT NULL DEFAULT 0 CHECK (pep_domestic IN (0,1)),
  pep_hio              SMALLINT NOT NULL DEFAULT 0 CHECK (pep_hio IN (0,1)),
  pep_relationship     TEXT NOT NULL DEFAULT '',
  pep_details          TEXT NOT NULL DEFAULT '',
  sanction_status      TEXT NOT NULL DEFAULT 'not_screened',
  sanction_sources     TEXT NOT NULL DEFAULT '',
  sanction_screened_at TEXT,
  sanction_screened_by INTEGER,
  sanction_note        TEXT NOT NULL DEFAULT '',
  answers              TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aml_check_unique ON aml_borrower_checks(file_id, applicant_id);

-- ---------------------------------------------------------------------------
-- Date-driven workflow automation.
--
-- A rule fires relative to one of the lifecycle dates above. workflow_runs is
-- the idempotency ledger: the unique index is what stops a nightly pass from
-- creating the same follow-up task every night for a week.
CREATE TABLE IF NOT EXISTS workflow_rules (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT NOT NULL,
  active           SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  stage_key        TEXT NOT NULL DEFAULT '',
  trigger_field    TEXT NOT NULL,
  offset_days      INTEGER NOT NULL DEFAULT 0,
  offset_direction TEXT NOT NULL DEFAULT 'after',
  action           TEXT NOT NULL DEFAULT 'task',
  task_title       TEXT NOT NULL DEFAULT '',
  task_description TEXT NOT NULL DEFAULT '',
  task_priority    TEXT NOT NULL DEFAULT 'normal',
  assignee         TEXT NOT NULL DEFAULT 'assigned_broker',
  email_template_key TEXT,
  created_by       INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id    INTEGER NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  file_id    INTEGER NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  due_date   TEXT NOT NULL,
  result     TEXT NOT NULL DEFAULT 'fired',
  detail     TEXT NOT NULL DEFAULT '',
  fired_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_unique ON workflow_runs(rule_id, file_id, due_date);
