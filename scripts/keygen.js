'use strict';

/**
 * Generate secrets for a deployment.
 *
 *   npm run keygen                     → a document encryption key (v1)
 *   npm run keygen -- --rotate         → the next key id, given the current set
 *   npm run keygen -- --setup-token    → a one-time first-administrator token
 *   npm run keygen -- --cron-secret    → a shared secret for the cron endpoint
 *
 * Rotation keeps every old key in DOCUMENT_ENCRYPTION_KEYS so existing
 * documents stay readable; only DOCUMENT_ENCRYPTION_ACTIVE_KEY changes, and
 * new documents are wrapped with the new key.
 */

const { generateMasterKey } = require('../server/crypto-store');
const crypto = require('node:crypto');

const args = process.argv.slice(2);

// A single-use, high-entropy token the operator places in their host's
// encrypted environment and spends once at /setup. Printed here — on the
// operator's own machine — rather than by the server, so it never reaches a
// deployment log.
if (args.includes('--setup-token')) {
  console.log('Set this in your hosting provider, deploy, then open /setup:\n');
  console.log(`ADMIN_SETUP_TOKEN=${crypto.randomBytes(32).toString('base64url')}`);
  console.log('\nDelete the variable once you have created the account. Never commit it.');
  process.exit(0);
}

if (args.includes('--cron-secret')) {
  console.log('Set this in your hosting provider so only your scheduler can run background jobs:\n');
  console.log(`CRON_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
  console.log('\nNever commit this value.');
  process.exit(0);
}

const existing = String(process.env.DOCUMENT_ENCRYPTION_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const usedIds = existing
  .map((entry) => entry.split(':')[0])
  .filter((id) => /^v\d+$/.test(id))
  .map((id) => Number(id.slice(1)));

const nextId = `v${(usedIds.length ? Math.max(...usedIds) : 0) + 1}`;
const key = generateMasterKey();
const entry = `${nextId}:${key}`;
const all = [...existing, entry].join(',');

console.log('New key generated. Set these two variables in your hosting provider:\n');
console.log(`DOCUMENT_ENCRYPTION_KEYS=${all}`);
console.log(`DOCUMENT_ENCRYPTION_ACTIVE_KEY=${nextId}`);
console.log('\nKeep every previous key in DOCUMENT_ENCRYPTION_KEYS — removing one makes the');
console.log('documents wrapped with it permanently unreadable. Never commit these values.');
