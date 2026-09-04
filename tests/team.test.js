'use strict';

/**
 * Staff account administration.
 *
 * Two things here are worth holding down with tests: an administrator must
 * never be able to lock the brokerage out of its own settings, and deleting a
 * staff account must not quietly take client history with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, clearRateLimits, signInAdmin } = require('./helpers');

let ctx;
let admin;

test.before(async () => {
  ctx = await startTestServer('team');
  admin = await signInAdmin(ctx.base);
});

test.after(async () => { if (ctx) await ctx.stop(); });

async function invite(email, role = 'assistant') {
  await clearRateLimits();
  const res = await admin.post('/api/settings/users', {
    email, first_name: 'Test', last_name: 'Person', role,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.user ? res.data.user.id : res.data.id;
}

test('an administrator keeps settings access even if the stored map drops it', async () => {
  // The validator refuses a save like this, but a hand-edited settings row or
  // a restored backup can still produce one. The floor is enforced on read,
  // so the brokerage can always get back into its own configuration.
  const db = require('../server/db');
  await db.setSetting('role_permissions', { admin: ['clients.view'] });

  const { permissionsForRole } = require('../server/auth');
  const perms = await permissionsForRole('admin');
  assert.ok(perms.includes('settings.manage'), 'settings.manage is restored');
  assert.ok(perms.includes('users.manage'), 'users.manage is restored');

  // And the API agrees — this is the request that was failing.
  const res = await admin.get('/api/settings/config/role_permissions');
  assert.equal(res.status, 200, JSON.stringify(res.data));
});

test('a save that would strip the administrator is still refused outright', async () => {
  const res = await admin.put('/api/settings/config/role_permissions', {
    value: { admin: ['clients.view'], assistant: ['clients.view'] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'admin_lockout');
});

test('permissions granted to the assistant role actually take effect', async () => {
  const { ALL_PERMISSIONS } = require('../server/seed');
  const res = await admin.put('/api/settings/config/role_permissions', {
    value: {
      admin: ALL_PERMISSIONS,
      assistant: ['clients.view', 'clients.edit', 'documents.view'],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  const { permissionsForRole } = require('../server/auth');
  assert.deepEqual(await permissionsForRole('assistant'), ['clients.view', 'clients.edit', 'documents.view']);
});

test('a stale role map cannot lock the administrator out of the permission grid', async () => {
  // Exactly the failure an administrator hit in production: every save of the
  // permission grid answered "You do not have permission to do that", because
  // the stored map for admin no longer listed settings.manage.
  const db = require('../server/db');
  const { ALL_PERMISSIONS } = require('../server/seed');
  await db.setSetting('role_permissions', {
    admin: ALL_PERMISSIONS.filter((p) => p !== 'settings.manage'),
    assistant: ['clients.view'],
  });

  const save = await admin.put('/api/settings/config/role_permissions', {
    value: { admin: ALL_PERMISSIONS, assistant: ['clients.view', 'clients.edit'] },
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));

  const { permissionsForRole } = require('../server/auth');
  assert.deepEqual(await permissionsForRole('assistant'), ['clients.view', 'clients.edit'],
    'and the change the administrator was trying to make actually landed');
});

test('broker and processor are no longer offered', async () => {
  const meta = await admin.get('/api/settings/meta');
  assert.deepEqual(meta.data.staff_roles, ['admin', 'manager', 'assistant']);

  await clearRateLimits();
  const invited = await admin.post('/api/settings/users', {
    email: 'retired.role@test.local', first_name: 'Kai', last_name: 'Sorensen', role: 'broker',
  });
  assert.equal(invited.status, 400);
  assert.equal(invited.data.code, 'bad_role');
});

test('an account already holding a retired role keeps working', async () => {
  // Retiring a role is about what can be assigned next. Someone who is already
  // a broker still signs in, still resolves permissions, and still owns their
  // files — otherwise a settings change would silently strand a colleague.
  const db = require('../server/db');
  const id = await invite('still.a.broker@test.local', 'manager');
  await db.run("UPDATE users SET role = 'broker' WHERE id = ?", id);

  const { permissionsForRole } = require('../server/auth');
  const perms = await permissionsForRole('broker');
  assert.ok(perms.includes('clients.view'), 'their permissions still resolve');

  // And while they hold it, the role stays visible so their row is not blank
  // and their column does not vanish from the permission grid.
  const meta = await admin.get('/api/settings/meta');
  assert.ok(meta.data.staff_roles.includes('broker'), meta.data.staff_roles.join(', '));

  // They can be moved to a current role, but nobody can be moved into theirs.
  const other = await invite('moved.in@test.local', 'assistant');
  const backwards = await admin.patch(`/api/settings/users/${other}`, { role: 'processor' });
  assert.equal(backwards.status, 400);
  assert.equal(backwards.data.code, 'bad_role');

  assert.equal((await admin.patch(`/api/settings/users/${id}`, { role: 'manager' })).status, 200,
    'moving out of a retired role is exactly what should be possible');

  const after = await admin.get('/api/settings/meta');
  assert.ok(!after.data.staff_roles.includes('broker'), 'and once nobody holds it, it is gone');
});

test('an unused staff account can be deleted outright', async () => {
  const id = await invite('unused@test.local');
  const res = await admin.del(`/api/settings/users/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));

  const db = require('../server/db');
  assert.equal(await db.get('SELECT id FROM users WHERE id = ?', id), undefined);

  const row = await db.get("SELECT meta FROM audit_log WHERE action = 'staff_account_deleted' LIMIT 1");
  assert.ok(row, 'the deletion is recorded');
  assert.match(row.meta, /unused@test\.local/, 'and records who it was, since the account is gone');
});

test('a staff account holding client work is refused, and told to disable instead', async () => {
  const id = await invite('busy@test.local', 'manager');
  await clearRateLimits();
  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Ola', last_name: 'Bergstrom', email: 'ola.b@example.com', employment_type: 'employee' },
    application: { assigned_broker_id: id },
    send_welcome: false, ignore_duplicates: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const res = await admin.del(`/api/settings/users/${id}`);
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'account_in_use');
  assert.match(res.data.message, /client files/);
  assert.match(res.data.message, /Disable them instead/);

  const db = require('../server/db');
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', id), 'the account survives a refused delete');
  assert.ok(await db.get('SELECT id FROM client_files WHERE assigned_broker_id = ?', id), 'so does their file');
});

test('you cannot delete yourself, or the last administrator', async () => {
  const db = require('../server/db');
  const me = await db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const self = await admin.del(`/api/settings/users/${me.id}`);
  assert.equal(self.status, 400);
  assert.equal(self.data.code, 'self_change');

  // A second admin who has done nothing: deleting them is fine, and leaves
  // the original in place.
  const spare = await invite('spare.admin@test.local', 'admin');
  assert.equal((await admin.del(`/api/settings/users/${spare}`)).status, 200);
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', me.id));
});

test('deleting a staff account requires users.manage', async () => {
  const id = await invite('protected@test.local');
  const { makeClient } = require('./helpers');
  const anon = makeClient(ctx.base);
  const res = await anon.del(`/api/settings/users/${id}`);
  assert.equal(res.status, 401);

  const db = require('../server/db');
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', id), 'nothing was deleted');
});

test('any staff member can change their own password, whatever their role', async () => {
  // The assistant role has no settings permission at all, which is exactly
  // why this endpoint must not be gated on one.
  const db = require('../server/db');
  const id = await invite('assistant.pw@test.local');
  const password = 'Harbour-Lantern-Quiet-42';
  const { hashPassword } = require('../server/auth');
  await db.run(
    "UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0 WHERE id = ?",
    await hashPassword(password), id
  );

  await clearRateLimits();
  const { makeClient } = require('./helpers');
  const client = makeClient(ctx.base);
  const login = await client.post('/api/auth/login', { email: 'assistant.pw@test.local', password });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  const changed = await client.post('/api/auth/change-password', {
    current_password: password, new_password: 'Quartz-Meadow-Bridge-31',
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));

  await clearRateLimits();
  const again = makeClient(ctx.base);
  assert.equal((await again.post('/api/auth/login', {
    email: 'assistant.pw@test.local', password: 'Quartz-Meadow-Bridge-31',
  })).status, 200, 'the new password works');
});
