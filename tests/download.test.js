'use strict';

/**
 * Bundled document download.
 *
 * A ZIP written by hand is worth testing against a real unzip, not just
 * against the code that wrote it — a byte wrong in the central directory
 * produces an archive that this codebase reads back perfectly and no operating
 * system will open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startTestServer, signInAdmin, clearRateLimits, makeClient, PDF } = require('./helpers');
const { createZip } = require('../server/zip');

let ctx;
let admin;
let fileId;

test.before(async () => {
  ctx = await startTestServer('download');
  admin = await signInAdmin(ctx.base);

  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Mira', last_name: 'Halvorsen', email: 'mira.dl@example.com', employment_type: 'employee' },
    send_welcome: false, ignore_duplicates: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  fileId = created.data.file.id;

  // Two documents, so the archive has something to get wrong.
  const docs = await admin.get(`/api/broker/files/${fileId}/documents`);
  for (const r of docs.data.requests.slice(0, 2)) {
    const up = await admin.upload(`/api/broker/requests/${r.id}/upload`, PDF, 'statement.pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
  }
});

test.after(async () => { if (ctx) await ctx.stop(); });

test('a real unzip can open what we write', () => {
  const zip = createZip([
    { name: 'first.pdf', data: Buffer.from('one') },
    { name: 'second.txt', data: Buffer.from('two') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, zip);

  // -t verifies every CRC, which is what catches a malformed header.
  const verified = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.match(verified, /No errors detected/);

  execFileSync('unzip', ['-o', '-q', file, '-d', dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'first.pdf'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(dir, 'second.txt'), 'utf8'), 'two');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a crafted filename cannot escape the folder it is extracted into', () => {
  const zip = createZip([
    { name: '../../../etc/passwd', data: Buffer.from('nope') },
    { name: '/absolute/path.txt', data: Buffer.from('also nope') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-evil-'));
  const file = path.join(dir, 'evil.zip');
  fs.writeFileSync(file, zip);

  // The property that matters is that no entry name is a path at all: with no
  // separator in it, "../.." cannot be a directory to climb out through.
  execFileSync('unzip', ['-o', '-q', file, '-d', dir]);
  const written = fs.readdirSync(dir).filter((f) => f !== 'evil.zip');
  assert.equal(written.length, 2, written.join(', '));
  for (const name of written) {
    // No separator means the name cannot be a path, so "../.." in it is just
    // text. A leading dot or dash is stripped too: one hides the file, the
    // other is read as a flag by some tools people extract with.
    assert.ok(!name.includes('/') && !name.includes('\\'), `${name} still carries a separator`);
    assert.ok(!/^[.\-]/.test(name), `${name} starts with a dot or dash`);
  }
  // And nothing landed outside the extraction directory.
  assert.equal(fs.existsSync(path.join(dir, '..', 'etc')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two documents with the same name both survive', () => {
  const zip = createZip([
    { name: 'scan.pdf', data: Buffer.from('applicant one') },
    { name: 'scan.pdf', data: Buffer.from('applicant two') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-dup-'));
  fs.writeFileSync(path.join(dir, 'd.zip'), zip);
  execFileSync('unzip', ['-o', '-q', path.join(dir, 'd.zip'), '-d', dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'scan.pdf'), 'utf8'), 'applicant one');
  assert.equal(fs.readFileSync(path.join(dir, 'scan (2).pdf'), 'utf8'), 'applicant two');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloading a whole file returns an archive of its documents', async () => {
  const res = await admin.get(`/api/broker/files/${fileId}/documents/download-all`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="MTG-\d{4}-\d{5}-documents\.zip"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-api-'));
  const file = path.join(dir, 'docs.zip');
  fs.writeFileSync(file, res.bytes);
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);

  const listed = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
  assert.match(listed, /2 files/);
  assert.match(listed, /Mira Halvorsen/, 'entries say whose document it is');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every document in the bundle is logged, not just the bundle', async () => {
  const db = require('../server/db');
  const bulk = await db.get("SELECT meta FROM audit_log WHERE action = 'documents_bulk_downloaded' ORDER BY id DESC LIMIT 1");
  assert.ok(bulk, 'the bundle itself is recorded');
  assert.match(bulk.meta, /"documents":2/);

  const each = await db.all("SELECT id FROM audit_log WHERE action = 'document_downloaded' AND meta LIKE '%\"bulk\":true%'");
  assert.equal(each.length, 2, 'and so is each document inside it');
});

test('it needs documents.download, like downloading them one at a time', async () => {
  // The bundle is the same disclosure as the individual downloads, so it must
  // not be a way around the permission that governs them.
  await clearRateLimits();
  const db = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const invited = await admin.post('/api/settings/users', {
    email: 'no.download@test.local', first_name: 'Tomas', last_name: 'Nyberg', role: 'assistant',
  });
  assert.equal(invited.status, 200, JSON.stringify(invited.data));
  const password = 'Harbour-Lantern-Quiet-42';
  await db.run(
    "UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0 WHERE lower(email) = ?",
    await hashPassword(password), 'no.download@test.local'
  );
  await db.setSetting('role_permissions', {
    assistant: ['clients.view', 'documents.view'],
  });

  await clearRateLimits();
  const helper = makeClient(ctx.base);
  assert.equal((await helper.post('/api/auth/login', { email: 'no.download@test.local', password })).status, 200);
  assert.equal((await helper.get(`/api/broker/files/${fileId}/documents`)).status, 200, 'they can see the checklist');

  const blocked = await helper.get(`/api/broker/files/${fileId}/documents/download-all`);
  assert.equal(blocked.status, 403, 'but not walk off with the files');
  assert.equal(blocked.data.code, 'forbidden');
});

test('a file with nothing uploaded says so rather than sending an empty archive', async () => {
  await clearRateLimits();
  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Bo', last_name: 'Kristiansen', email: 'bo.empty@example.com', employment_type: 'employee' },
    send_welcome: false, ignore_duplicates: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const res = await admin.get(`/api/broker/files/${created.data.file.id}/documents/download-all`);
  assert.equal(res.status, 404);
  assert.equal(res.data.code, 'nothing_to_download');
});
