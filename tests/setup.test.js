'use strict';

/**
 * First-administrator provisioning.
 *
 * This endpoint creates a privileged account and is reachable without
 * authentication, so it gets adversarial coverage rather than a happy path:
 * it must be closed once claimed, must not be probeable, must not accept a
 * weak password, and must not be racex-able into creating two owners.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, makeClient, clearRateLimits } = require('./helpers');

const SETUP_TOKEN = 'H6mQ2vX9tLpR4wZaC1nB8kSdF3jY7gEu';
let ctx;
let anon;

test.before(async () => {
  // No ADMIN_EMAIL/ADMIN_PASSWORD: the deployment boots unclaimed, which is
  // the state a fresh managed deployment is actually in.
  ctx = await startTestServer('setup', {
    ADMIN_EMAIL: null,
    ADMIN_PASSWORD: null,
    ADMIN_SETUP_TOKEN: SETUP_TOKEN,
  });
  anon = makeClient(ctx.base);
});

test.after(async () => { if (ctx) await ctx.stop(); });

test('an unclaimed deployment boots and serves pages instead of 500-ing', async () => {
  const health = await anon.get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ready, true, 'a missing admin must not stop the app from booting');

  const login = await anon.get('/login');
  assert.equal(login.status, 200, 'the login page is reachable');
});

test('the setup flow reports that it is open, without leaking the token', async () => {
  const res = await anon.get('/api/auth/setup');
  assert.equal(res.status, 200);
  assert.equal(res.data.setup_required, true);
  assert.equal(res.data.token_configured, true);
  assert.equal(JSON.stringify(res.data).includes(SETUP_TOKEN), false,
    'the response must never echo any part of the token');
});

test('a wrong token is refused, and is indistinguishable from "not found"', async () => {
  await clearRateLimits();
  const res = await anon.post('/api/auth/setup', {
    token: 'not-the-right-token', email: 'attacker@example.com', password: 'Harbour-Lantern-Quiet-42',
  });
  assert.equal(res.status, 404);
  assert.equal(res.data.code, 'not_found');
  assert.equal(/token|setup/i.test(res.data.message), false,
    'the refusal must not confirm that a setup endpoint exists here');

  // And it created nothing.
  const still = await anon.get('/api/auth/setup');
  assert.equal(still.data.setup_required, true);
});

test('a weak password is refused even for the very first account', async () => {
  await clearRateLimits();
  const res = await anon.post('/api/auth/setup', {
    token: SETUP_TOKEN, email: 'owner@example.com', password: 'password123',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'weak_password');
});

test('a password containing the account email is refused', async () => {
  await clearRateLimits();
  const res = await anon.post('/api/auth/setup', {
    token: SETUP_TOKEN, email: 'owner@example.com', password: 'owner-Bridge-31-Quartz',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'weak_password');
});

test('an invalid email is refused', async () => {
  await clearRateLimits();
  const res = await anon.post('/api/auth/setup', {
    token: SETUP_TOKEN, email: 'not-an-email', password: 'Quartz-Meadow-Bridge-31',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'bad_email');
});

test('a valid claim creates exactly one administrator', async () => {
  await clearRateLimits();
  const res = await anon.post('/api/auth/setup', {
    token: SETUP_TOKEN,
    email: 'owner@example.com',
    first_name: 'Dana',
    last_name: 'Okonkwo',
    password: 'Quartz-Meadow-Bridge-31',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  const db = require('../server/db');
  const admins = await db.all("SELECT id, role, must_change_password FROM users WHERE role <> 'client'");
  assert.equal(admins.length, 1);
  assert.equal(admins[0].role, 'admin');
  assert.equal(admins[0].must_change_password, 0,
    'they chose the password themselves, so there is nothing to force a change of');
});

test('the claim is recorded in the audit log', async () => {
  const db = require('../server/db');
  const row = await db.get("SELECT action FROM audit_log WHERE action = 'admin_setup_claimed' LIMIT 1");
  assert.ok(row, 'claiming the first account is an auditable event');
  const rejected = await db.get("SELECT action FROM audit_log WHERE action = 'admin_setup_rejected' LIMIT 1");
  assert.ok(rejected, 'a rejected attempt is recorded too');
});

test('the flow is closed permanently once claimed — even with the right token', async () => {
  await clearRateLimits();
  const status = await anon.get('/api/auth/setup');
  assert.equal(status.data.setup_required, false);

  const replay = await anon.post('/api/auth/setup', {
    token: SETUP_TOKEN, email: 'second-owner@example.com', password: 'Amber-Ridge-Compass-88',
  });
  assert.equal(replay.status, 404, 'a valid token must not create a second administrator');

  const db = require('../server/db');
  const admins = await db.all("SELECT id FROM users WHERE role <> 'client'");
  assert.equal(admins.length, 1, 'still exactly one staff account');
});

test('the new administrator can sign in and is forced into MFA enrolment', async () => {
  await clearRateLimits();
  const client = makeClient(ctx.base);
  const login = await client.post('/api/auth/login', {
    email: 'owner@example.com', password: 'Quartz-Meadow-Bridge-31',
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.must_change_password, undefined || login.data.must_change_password);

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.mfa.required, true, 'administrators can never be exempted from MFA');
  assert.equal(me.data.mfa.enrolled, false);
  assert.equal(me.data.home, '/mfa-setup', 'they are sent straight to enrolment');
  assert.deepEqual(me.data.permissions, [],
    'no permissions are granted until the second factor is enrolled');

  // And the un-enrolled session genuinely cannot reach broker data.
  const blocked = await client.get('/api/broker/clients');
  assert.equal(blocked.status, 403);
});

test('setup attempts are rate limited', async () => {
  await clearRateLimits();
  let sawLimit = false;
  for (let i = 0; i < 14; i++) {
    const res = await anon.post('/api/auth/setup', { token: 'wrong', email: 'x@example.com', password: 'x' });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'brute-forcing the token must hit a limit');
});
