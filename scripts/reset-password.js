'use strict';

/**
 * Reset a staff account's password from the command line.
 *
 * There is deliberately no way to read an existing password: they are stored
 * only as scrypt hashes, which are one-way. When an administrator is locked
 * out — the usual cause is a generated password that went into a deployment
 * log nobody read — the recovery path is to set a new one, not to recover the
 * old one.
 *
 * This is not a backdoor. It requires DATABASE_URL, and anyone holding the
 * database credentials can already write to the users table with plain SQL.
 * What this adds is that the write is done correctly (right scrypt
 * parameters, right hash format), that the account is forced to choose its
 * own password on next sign-in, that every session is dropped, and that the
 * whole thing lands in the append-only audit log instead of happening
 * invisibly.
 *
 * The new password is printed once, here, on the operator's own machine —
 * never by the server, and never into a log.
 *
 * Run:
 *   node scripts/reset-password.js you@yourbrokerage.com --confirm
 *   node scripts/reset-password.js you@yourbrokerage.com --confirm --reset-mfa
 */

const readline = require('node:readline');

const args = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
const confirmed = args.includes('--confirm');
const resetMfa = args.includes('--reset-mfa');

function redactedTarget() {
  return String(process.env.DATABASE_URL || '(DATABASE_URL not set)').replace(/:[^:@/]*@/, ':****@');
}

function usage(message) {
  console.error(`${message}\n`);
  console.error('  node scripts/reset-password.js <email> --confirm [--reset-mfa]\n');
  console.error('  --confirm     required; this writes to the database');
  console.error('  --reset-mfa   ALSO clears two-step verification, so the account can');
  console.error('                enrol a new authenticator. Only use this when the');
  console.error('                authenticator itself is lost — it lowers the account\'s');
  console.error('                protection until enrolment is completed again.');
  process.exit(1);
}

/** Ask for explicit typed confirmation before touching a production database. */
function askToProceed(question) {
  if (!process.stdin.isTTY) return Promise.resolve(true); // non-interactive: --confirm is the gate
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  if (!email) usage('Which account? Pass the email address of the staff member.');
  if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set — point it at the database you want to change.');
  if (!confirmed) usage(`Refusing to change a password without --confirm.\nTarget: ${redactedTarget()}`);

  const db = require('../server/db');
  const { hashPassword, generateTemporaryPassword, destroyAllSessions, STAFF_ROLES } = require('../server/auth');
  const { audit } = require('../server/log');
  const { now } = require('../server/util');

  const user = await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', email);
  if (!user) {
    console.error(`No account found for ${email} in ${redactedTarget()}.`);
    console.error('Check the address in the users table — this script never creates accounts.');
    process.exit(1);
  }
  if (!STAFF_ROLES.includes(user.role)) {
    console.error(`${email} is a "${user.role}" account, not brokerage staff.`);
    console.error('Client portal passwords are re-issued from the broker portal, on the client\'s file.');
    process.exit(1);
  }

  console.log(`\nAccount:  ${user.email}`);
  console.log(`Role:     ${user.role}`);
  console.log(`Status:   ${user.status}`);
  console.log(`MFA:      ${user.mfa_secret ? 'enrolled' : 'not enrolled'}${resetMfa ? ' — will be CLEARED' : ''}`);
  console.log(`Database: ${redactedTarget()}\n`);

  const ok = await askToProceed('Type "yes" to reset this password: ');
  if (!ok) {
    console.log('Cancelled. Nothing was changed.');
    process.exit(0);
  }

  // Six groups → a 29-character password that satisfies the staff policy.
  const password = generateTemporaryPassword(6);
  const passwordHash = await hashPassword(password);

  await db.run(
    `UPDATE users
        SET password_hash = ?, must_change_password = 1, status = 'active',
            failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?`,
    passwordHash, now(), user.id
  );

  // Any session issued under the old password stops working immediately —
  // otherwise a reset would not actually evict whoever prompted it.
  await destroyAllSessions(user.id);

  if (resetMfa) {
    await db.run(
      'UPDATE users SET mfa_secret = NULL, mfa_enrolled_at = NULL, mfa_last_used_step = NULL WHERE id = ?',
      user.id
    );
    await db.run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', user.id);
  }

  await audit(user.id, resetMfa ? 'password_and_mfa_reset_by_operator' : 'password_reset_by_operator',
    'user', user.id, null, { email: user.email, via: 'scripts/reset-password.js' });

  console.log('\n--------------------------------------------------------------');
  console.log('  Password reset.');
  console.log(`  Email:    ${user.email}`);
  console.log(`  Password: ${password}`);
  console.log('');
  console.log('  Shown once, here, on your machine only. Put it in your password');
  console.log('  manager now — it is stored only as a hash and cannot be read back.');
  console.log('  You must choose your own password at first sign-in.');
  if (resetMfa) {
    console.log('');
    console.log('  Two-step verification was cleared. Have an authenticator app ready:');
    console.log('  you will be required to enrol again before reaching any data.');
  }
  console.log('--------------------------------------------------------------\n');

  await db.close();
}

main().catch(async (err) => {
  console.error('\nReset failed:', err.message);
  try { await require('../server/db').close(); } catch { /* already closed */ }
  process.exit(1);
});
