'use strict';

/**
 * The welcome email carries an invitation link rather than a password.
 *
 * Two things need holding down: the shipped default must not put a credential
 * in an inbox, and a brokerage that wrote its own welcome email must keep it
 * exactly as written — including the placeholder it chose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, signInAdmin, clearRateLimits } = require('./helpers');

let ctx;
let admin;

test.before(async () => {
  ctx = await startTestServer('invite');
  admin = await signInAdmin(ctx.base);
});

test.after(async () => { if (ctx) await ctx.stop(); });

test('a deployment on the old template is upgraded to the link version', async () => {
  const db = require('../server/db');
  const seed = require('../server/seed');

  // Put the deployment back the way it shipped before this change.
  const legacy = 'Hi {{client_first_name}},\n\nWelcome to {{brokerage_name}}.\n\n'
    + 'We have created your secure mortgage client portal. Use it to see exactly where your '
    + 'application stands, upload documents, and message {{broker_name}}.\n\n'
    + 'You can access your account here:\n{{portal_link}}\n\nUsername:\n{{username}}\n\n'
    + 'Temporary Password:\n{{temporary_password}}\n\n'
    + 'Please log in and change your temporary password after your first login.\n\n'
    + 'If you have any questions, please contact {{broker_name}}.\n\nBest,\n{{broker_name}}\n{{brokerage_name}}';
  await db.run("UPDATE email_templates SET body = ? WHERE key = 'welcome'", legacy);
  await db.setSetting('catalog_upgrades', []);

  await seed.upgradeWelcomeTemplate();

  const after = await db.get("SELECT body FROM email_templates WHERE key = 'welcome'");
  assert.ok(after.body.includes('{{activation_link}}'), 'it now sends a link');
  assert.ok(!after.body.includes('{{temporary_password}}'), 'and no longer a password');
});

test("a brokerage's own wording is never overwritten", async () => {
  // Their template is theirs. Silently rewriting it would be worse than the
  // problem the upgrade solves.
  const db = require('../server/db');
  const seed = require('../server/seed');
  const mine = 'Hi {{client_first_name}} — call me. Your password is {{temporary_password}}. — Sam';
  await db.run("UPDATE email_templates SET body = ? WHERE key = 'welcome'", mine);
  await db.setSetting('catalog_upgrades', []);

  await seed.upgradeWelcomeTemplate();

  const after = await db.get("SELECT body FROM email_templates WHERE key = 'welcome'");
  assert.equal(after.body, mine, 'left exactly as written');
});

test('a customised template still resolves the placeholder it uses', async () => {
  // Because their template survives, the variable it depends on must too.
  await clearRateLimits();
  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Sofia', last_name: 'Lindqvist', email: 'sofia.invite@example.com', employment_type: 'employee' },
    ignore_duplicates: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const invite = created.data.invites[0];

  const emails = await admin.get(`/api/broker/files/${created.data.file.id}/emails`);
  const welcome = emails.data.emails.find((e) => e.template_key === 'welcome');
  assert.ok(welcome, 'the welcome email went out');
  const body = (await admin.get(`/api/broker/emails/${welcome.id}`)).data.email.body;

  assert.ok(!body.includes('{{'), 'no unresolved placeholder reaches a client');
  assert.ok(!body.includes(invite.temporary_password), 'the stored copy stays redacted either way');
});

test('the shipped default is what a reset restores', async () => {
  const reset = await admin.post('/api/settings/templates/welcome/reset', {});
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.ok(reset.data.template.body.includes('{{activation_link}}'));
  assert.ok(!reset.data.template.body.includes('{{temporary_password}}'));
});
