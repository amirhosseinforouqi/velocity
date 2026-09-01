# Deal module and interface redesign — September 2026

A record of what changed, what was deliberately left alone, and what is still
missing. Written for whoever picks this up next, not as a release note.

The work was informed by a structural and UX audit of an existing Canadian
mortgage platform (Velocity, by Newton). **No code, branding, copy or visual
asset was carried over** — only functional patterns and a data model that
reflects real regulatory requirements (FINTRAC, provincial disclosure, CASL)
rather than any one vendor's implementation. Several of that platform's
strongest ideas were adopted; several were deliberately not.

---

## 1. What was already here

The platform was a well-built **document collection and client communication
system**: PostgreSQL, one runtime dependency, a plain request handler that runs
identically under `npm start` and Vercel, two vanilla-JS SPAs. Security was
genuinely strong — scrypt, mandatory TOTP for staff, database-backed rate
limiting, AES-256-GCM envelope encryption for documents, ClamAV scanning, a
hash-chained audit log, and client isolation derived server-side from
applicant links rather than from anything the browser sends.

The three-layer document engine (catalog → rules → per-client checklist, with
per-file exclusions so one client's edit never changes another's defaults) is
better than the flat 105-item taxonomy in the audited product, and was kept
as-is.

None of that was rewritten.

## 2. What it could not do

It could track documents for a mortgage but it could not model a mortgage.
There was no income, no assets, no liabilities, no property carrying costs, no
rate, no term, no amortization — and therefore no GDS, no TDS, no LTV, no
payment. A broker had to leave the platform to answer the first question every
client asks. There was also no FINTRAC record at all, which for a Canadian
brokerage is a legal exposure rather than a missing feature.

## 3. What was added

**Qualification engine** (`server/metrics.js`) — GDS, TDS, LTV, net worth and
payment, computed on demand from the underlying records. Nothing is stored as
an editable figure, so a ratio cannot drift from the data behind it.

Three pieces of Canadian specificity that are easy to get wrong, and are
spelled out in the code rather than folded into a constant:

- Fixed rates compound **semi-annually**, not monthly. On a $600k mortgage the
  naive `annual/12` rate is about $18/month wrong — enough to move a file
  across a guideline.
- The stress test qualifies at the greater of contract + buffer and a floor.
  Both are brokerage settings, because the published figures have changed
  before and will again.
- GDS counts heat and **half** the condo fees; hydro and water are real money
  but stay out of the ratio, because that is what a lender computes.

**FINTRAC/AML module** (`server/aml.js`) — a structured risk assessment per
deal, plus identity verification, PEP declaration and sanction screening per
borrower. Two decisions worth keeping:

- The risk level is **derived** from the answers on every read. There is no
  editable risk field, because a rating that can be typed over is not a rating.
- With no screening provider configured, the platform records what a human
  actually checked. A stubbed "cleared" would look like a check that happened,
  which is worse than no check.

**Mortgage requests, lender panel and in-context matching** — a file can carry
several requests; only the primary drives its headline ratios. Products are
screened against the file's own province, LTV, purpose, occupancy and lowest
credit score, and the ruled-out list says why each one failed. Choosing a
product snapshots the lender and product names so a later catalog change never
rewrites what was chosen on the day.

**Lifecycle dates and date-driven automation** (`server/workflows.js`) —
fifteen canonical dates as trigger points. A rule fires once per file per date,
enforced by a unique index on `workflow_runs` rather than by remembering in
process, so a restart mid-pass cannot duplicate a follow-up.

**Interface** — a redesigned token-driven design system, a drag-to-move
pipeline board, a sticky deal header carrying six live qualification numbers,
and a real phone layout: bottom tab bar, off-canvas drawer, and tables that
collapse into labelled cards via `data-label` rather than a second markup path.

## 4. Adopted from the audit

| Pattern | Why it was worth taking |
|---|---|
| Two-level tabs + quick-nav + entity-switcher chips on the record page | Materially better than a long accordion on a data-dense record — the audited product's own redesign proves it |
| Contract rate and qualifying rate as parallel calculations | The regulatory calculation must be independently auditable |
| AML as a top-level destination, not buried inside documents | It is a parallel obligation, not a document category |
| Event-driven automation: stage + lifecycle date + day offset | A genuinely general model, cheap to build once the dates exist |
| Auto-generated system notes on state transitions | Cheap, and materially improves trust |
| Pre-filtering rate shopping from the deal's own data | Re-keying what is on file is the friction that pushes this into a spreadsheet |
| Friendly, CTA-driven empty states everywhere | Applied universally — there is no bare "no records" anywhere in the product |
| Multi-flag document status | Adopted **in part** — see below |

## 5. Deliberately not copied

**The nine-flag document matrix replacing the linear status.** The audit rates
this the single most reusable pattern, and the underlying insight is right: a
document genuinely occupies several states at once. But several of the nine
flags (Requested / Received / Confirmed / Approved) are stages of one
lifecycle, and that lifecycle already drives the client portal, the reminder
engine and the next-step computation here. Replacing it would have meant
rebuilding three working subsystems to express the same fact differently, and
leaving all 2⁹ combinations technically reachable.

What was taken instead: the *orthogonal* dimensions the linear status cannot
express — is this a lender condition, is it a compliance form, does it need an
e-signature, has it been sent to the lender — added **beside** the status and
rendered as a row of independent lights. "Received but not yet sent to the
lender" and "approved but still an outstanding condition" are now both
expressible, which was the actual gap.

**The 105-item flat document taxonomy.** The rules engine already generates a
per-client checklist from service + employment + FTHB status, which is a
better answer than a long list a broker picks from. The taxonomy stayed a
catalog the rules draw on.

**Separate apps for rate shopping and marketing.** Presented in context — the
product matcher is a panel over the deal, not an app switch into a different
visual language.

**Automation that emails clients by default.** Rules create tasks for a person.
Client email is a separate switch that a brokerage turns on knowingly, and a
rule that would have sent while it is off records *why* it did nothing. An
engine that can email a real client about a real mortgage unsupervised is a
liability, not a feature.

**An automated sanction-screening result with no provider behind it.** See
above.

## 6. Backward compatibility

Every schema change is additive: new tables, and `ALTER TABLE … ADD COLUMN IF
NOT EXISTS` on existing ones. No column was dropped, renamed or retyped, so an
existing database migrates by running `schema.sql` again — which is what
`db.migrate()` already does on every boot.

New permissions (`financials.*`, `aml.*`, `lenders.*`) needed care: an existing
brokerage has its role→permission map stored in settings, so a new key would
have been granted to nobody, including the administrator, and the feature would
have looked broken rather than new. `applyPermissionUpgrades()` in `seed.js`
grants each role only what the defaults say it should have, once, recorded by
name — and never removes anything, so a brokerage that deliberately tightened a
role keeps its choice.

All 139 pre-existing tests still pass, untouched.

## 7. Two bugs found and fixed on the way

- `route()` split the hash on `/` without stripping the query first, so
  `#/clients?filter=awaiting_review` matched no route and silently landed on
  the dashboard. Every filtered link from a dashboard tile was dead.
- `Element.append(null)` inserts the literal text `null`. The `el()` helper
  filtered nulls but top-level appends did not, so a conditional card left a
  stray "null" on the page. Added `mount()` and used it where conditionals
  reach an append.

## 8. Known gaps

- **Sanction screening has no provider.** The integration point is
  `aml.screeningMode()`; until one is wired in, results are human-recorded.
- **No bilingual (EN/FR) content.** A real Canadian-market requirement. The
  right shape is `{locale: string}` maps on email templates, stage client
  wording and generated documents — a schema change plus a rendering pass,
  not a rewrite.
- **No generated AML risk-assessment PDF.** The data is structured and ready;
  it needs a document-generation path, and it must be regenerated rather than
  hand-edited.
- **No commission tracking.** Modelled in the audit as line-item lists on the
  mortgage request (volume bonuses, fees, deductions, splits). Worth building
  at the same level, not as a single number on the deal.
- **No provincial compliance-form set.** The `province` field and the
  jurisdiction plumbing are in place; the ~38 provincial forms are not seeded.
- **No client-facing self-serve intake.** The client portal covers post-intake
  document upload; a branded intake link is the third surface the audit
  recommends and is not built.
- **Marketing/broadcast module.** Out of scope. CASL consent is captured and
  filterable, so the gate it would need already exists.

## 9. Suggested next phase

1. **Commission tracking** on the mortgage request — it closes the loop from
   lead to paid, and every input it needs is now on file.
2. **Bilingual content**, because it is a market requirement rather than a
   differentiator, and it gets harder the more templates exist.
3. **The generated AML risk-assessment artifact**, which turns the compliance
   module from a record into a deliverable.
4. **Provincial compliance forms**, seeded and jurisdiction-filtered.
5. **Client intake surface** — the largest piece, and the one that most
   changes how a brokerage acquires clients.
