'use strict';

/**
 * Operator password reset.
 *
 * The tool exists because scrypt is one-way: when an administrator loses the
 * only copy of their password there is nothing to recover, only something to
 * replace. What matters is that the replacement actually works through the
 * real login endpoint, that it evicts whoever held the old one, and that it
 * cannot be used to quietly hand someone a client's account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { startTestServer, makeClient, clearRateLimits, signInAdmin } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'reset-password.js');
let ctx;
let admin;

/** Run the CLI the way an operator would, and return what it printed. */
function runReset(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATABASE_URL: ctx.testUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runResetExpectingFailure(args) {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: ctx.testUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    return String(err.stderr || '') + String(err.stdout || '');
  }
}

/** Pull the generated password out of the tool's own output. */
function passwordFrom(output) {
  const match = output.match(/Password:\s+(\S+)/);
  assert.ok(match, `no password in output:\n${output}`);
  return match[1];
}

test.before(async () => {
  ctx = await startTestServer('resetpw');
  admin = await signInAdmin(ctx.base);
});

test.after(async () => { if (ctx) await ctx.stop(); });

test('it refuses to write without --confirm', async () => {
  const out = runResetExpectingFailure(['admin@test.local']);
  assert.match(out, /Refusing to change a password without --confirm/);
  assert.doesNotMatch(out, /Password:/, 'nothing is generated on a refused run');
});

test('it refuses an account that does not exist', async () => {
  const out = runResetExpectingFailure(['ghost@test.local', '--confirm']);
  assert.match(out, /No account found/);
});

test('it refuses to reset a client portal account', async () => {
  // Clients are re-invited from the broker portal, on their own file — an
  // operator silently taking over a client login is exactly what should not
  // be a one-line command.
  await clearRateLimits();
  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Dana', last_name: 'Okonkwo', email: 'client.reset@example.com', employment_type: 'employee' },
    send_welcome: false, ignore_duplicates: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const out = runResetExpectingFailure(['client.reset@example.com', '--confirm']);
  assert.match(out, /not brokerage staff/);
});

test('the reset password actually signs in through the real API', async () => {
  await clearRateLimits();
  // A second staff account, so the suite's own admin session stays usable.
  const created = await admin.post('/api/settings/users', {
    email: 'locked.out@test.local', first_name: 'Wren', last_name: 'Aoki', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const password = passwordFrom(runReset(['locked.out@test.local', '--confirm']));

  await clearRateLimits();
  const client = makeClient(ctx.base);
  const login = await client.post('/api/auth/login', { email: 'locked.out@test.local', password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.must_change_password, true,
    'an operator-set password is temporary — the account chooses its own');
});

test('resetting evicts every existing session for that account', async () => {
  await clearRateLimits();
  const created = await admin.post('/api/settings/users', {
    email: 'evicted@test.local', first_name: 'Ines', last_name: 'Barros', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const first = passwordFrom(runReset(['evicted@test.local', '--confirm']));
  await clearRateLimits();
  const session = makeClient(ctx.base);
  const login = await session.post('/api/auth/login', { email: 'evicted@test.local', password: first });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal((await session.get('/api/auth/me')).status, 200, 'the session works before the reset');

  // Someone resets it again — the earlier session must stop working, or a
  // reset would not actually remove whoever prompted it.
  runReset(['evicted@test.local', '--confirm']);
  assert.equal((await session.get('/api/auth/me')).status, 401,
    'the old session is gone the moment the password changes');
});

test('a reset unlocks an account that was locked out by failed attempts', async () => {
  await clearRateLimits();
  const created = await admin.post('/api/settings/users', {
    email: 'locked.acct@test.local', first_name: 'Rafe', last_name: 'Molina', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const db = require('../server/db');
  await db.run(
    "UPDATE users SET locked_until = ?, failed_attempts = 9, status = 'disabled' WHERE lower(email) = ?",
    new Date(Date.now() + 3600e3).toISOString(), 'locked.acct@test.local'
  );

  const password = passwordFrom(runReset(['locked.acct@test.local', '--confirm']));
  const row = await db.get("SELECT status, locked_until, failed_attempts FROM users WHERE lower(email) = ?", 'locked.acct@test.local');
  assert.equal(row.status, 'active');
  assert.equal(row.locked_until, null);
  assert.equal(row.failed_attempts, 0);

  await clearRateLimits();
  const client = makeClient(ctx.base);
  assert.equal((await client.post('/api/auth/login', { email: 'locked.acct@test.local', password })).status, 200);
});

test('--reset-mfa clears enrolment and its recovery codes', async () => {
  await clearRateLimits();
  const db = require('../server/db');
  const created = await admin.post('/api/settings/users', {
    email: 'mfa.lost@test.local', first_name: 'Sol', last_name: 'Vance', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const user = await db.get("SELECT id FROM users WHERE lower(email) = ?", 'mfa.lost@test.local');
  await db.run("UPDATE users SET mfa_secret = 'PRETENDSECRET', mfa_enrolled_at = ? WHERE id = ?", new Date().toISOString(), user.id);
  await db.run("INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, 'x', ?)", user.id, new Date().toISOString());

  // Without the flag, enrolment survives a password reset.
  runReset(['mfa.lost@test.local', '--confirm']);
  let row = await db.get('SELECT mfa_secret FROM users WHERE id = ?', user.id);
  assert.ok(row.mfa_secret, 'a plain password reset must not weaken the second factor');

  // With it, both the secret and the recovery codes go.
  runReset(['mfa.lost@test.local', '--confirm', '--reset-mfa']);
  row = await db.get('SELECT mfa_secret, mfa_enrolled_at FROM users WHERE id = ?', user.id);
  assert.equal(row.mfa_secret, null);
  assert.equal(row.mfa_enrolled_at, null);
  const codes = await db.all('SELECT id FROM mfa_recovery_codes WHERE user_id = ?', user.id);
  assert.equal(codes.length, 0, 'stale recovery codes must not survive re-enrolment');
});

test('every reset is written to the append-only audit log', async () => {
  const db = require('../server/db');
  const plain = await db.get("SELECT meta FROM audit_log WHERE action = 'password_reset_by_operator' LIMIT 1");
  assert.ok(plain, 'a password reset is an auditable event');
  assert.match(plain.meta, /reset-password\.js/, 'the audit row records how it was done');

  const withMfa = await db.get("SELECT id FROM audit_log WHERE action = 'password_and_mfa_reset_by_operator' LIMIT 1");
  assert.ok(withMfa, 'clearing MFA is recorded under its own action');

  // The chain must still verify — the resets did not corrupt it.
  const { verifyAuditChain } = require('../server/log');
  const chain = await verifyAuditChain({ limit: 5000 });
  assert.equal(chain.ok, true, JSON.stringify(chain));
});

test('the generated password satisfies the staff policy', async () => {
  await clearRateLimits();
  const created = await admin.post('/api/settings/users', {
    email: 'policy.check@test.local', first_name: 'Nia', last_name: 'Adeyemi', role: 'manager',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const password = passwordFrom(runReset(['policy.check@test.local', '--confirm']));
  const { validatePasswordStrength } = require('../server/auth');
  await validatePasswordStrength(password, {
    role: 'manager', user: { email: 'policy.check@test.local', first_name: 'Nia', last_name: 'Adeyemi' },
  });
  assert.ok(password.length >= 12);
});
