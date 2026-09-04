'use strict';

/**
 * Backup and restore (audit finding C2).
 *
 * A backup nobody has restored is not a backup, so this is deliberately a
 * complete, self-contained round trip that the test suite actually exercises:
 * back up → wipe → restore → verify.
 *
 * Layout of a backup directory:
 *
 *   manifest.json          table list, row counts, document count, checksum
 *   data.jsonl.gz          one JSON line per row: {"t":"<table>","r":{...}}
 *   documents/<stored>     the stored document blobs, byte-for-byte
 *
 * Document blobs are already encrypted at rest (see crypto-store.js), so the
 * archive carries no plaintext client documents. `data.jsonl.gz` does contain
 * client PII, so `createBackup` encrypts it with the same envelope scheme
 * whenever encryption keys are configured — which, in production, is always.
 *
 * This is a portable, provider-independent copy. It complements, and does not
 * replace, the managed provider's own point-in-time recovery (see
 * docs/DEPLOYMENT.md).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const db = require('./db');
const cryptoStore = require('./crypto-store');
const storage = require('./storage');

/**
 * Restore order matters: a row cannot reference a parent that is not there
 * yet. This is the schema's dependency order, and the reverse is a safe
 * delete order.
 */
const TABLES = [
  'settings',
  'counters',
  'schema_migrations',
  'users',
  'mfa_recovery_codes',
  'sessions',
  'auth_tokens',
  'login_attempts',
  'rate_limits',
  'application_types',
  'employment_statuses',
  'stages',
  'client_files',
  'applicants',
  'document_types',
  'document_rules',
  'document_rule_items',
  'checklist_exclusions',
  'document_requests',
  'document_versions',
  'ai_reviews',
  'messages',
  'tasks',
  'notes',
  'stage_history',
  'activity_log',
  'audit_log',
  'notifications',
  'email_templates',
  'email_log',
  'consent_forms',
  'consents',
];

/** Tables whose rows are transient; excluded by default to keep backups small. */
const TRANSIENT = new Set(['sessions', 'auth_tokens', 'login_attempts', 'rate_limits']);

const gzip = (buf) => new Promise((res, rej) => zlib.gzip(buf, (e, r) => (e ? rej(e) : res(r))));
const gunzip = (buf) => new Promise((res, rej) => zlib.gunzip(buf, (e, r) => (e ? rej(e) : res(r))));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Write a full backup.
 * @param {string} destRoot directory to create the backup directory inside
 * @param {{includeTransient?: boolean, includeDocuments?: boolean}} opts
 */
/**
 * Serialize every row the backup covers into one compressed, encrypted blob.
 *
 * Split out from createBackup so the scheduled pass produces a byte-identical
 * payload to the one the restore path is tested against — a backup written by
 * a different code path is a backup nobody has restored.
 */
async function databaseSnapshot({ includeTransient = false } = {}) {
  const tables = TABLES.filter((t) => includeTransient || !TRANSIENT.has(t));
  const counts = {};
  const lines = [];

  for (const table of tables) {
    const rows = await db.all(`SELECT * FROM ${table}`);
    counts[table] = rows.length;
    for (const row of rows) lines.push(JSON.stringify({ t: table, r: row }));
  }

  const plaintext = Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  const compressed = await gzip(plaintext);

  let bytes = compressed;
  let envelope = null;
  if (cryptoStore.isConfigured()) {
    const enc = cryptoStore.encryptBuffer(compressed);
    bytes = enc.ciphertext;
    envelope = enc.envelope;
  }
  return { bytes, tables, counts, rows: lines.length, checksum, envelope };
}

async function createBackup(destRoot, opts = {}) {
  const includeTransient = opts.includeTransient === true;
  const includeDocuments = opts.includeDocuments !== false;

  const dir = path.join(destRoot, `backup-${stamp()}`);
  await fsp.mkdir(path.join(dir, 'documents'), { recursive: true, mode: 0o700 });

  const snapshot = await databaseSnapshot({ includeTransient });
  const { tables, counts, checksum, envelope } = snapshot;
  await fsp.writeFile(path.join(dir, 'data.jsonl.gz'), snapshot.bytes, { mode: 0o600 });

  // Documents are copied verbatim: they are already encrypted on disk and
  // their envelopes travel with the document_versions rows.
  let documents = 0;
  let documentBytes = 0;
  const missing = [];
  if (includeDocuments) {
    const versions = await db.all('SELECT stored_name FROM document_versions');
    for (const v of versions) {
      // Read through the storage layer, so a backup works the same whether
      // documents live on a volume or in an object store.
      const bytes = await storage.readRaw(v.stored_name).catch(() => null);
      if (!bytes) {
        missing.push(v.stored_name);
        continue;
      }
      await fsp.writeFile(path.join(dir, 'documents', v.stored_name), bytes, { mode: 0o600 });
      documents += 1;
      documentBytes += bytes.length;
    }
  }

  const manifest = {
    format: 1,
    created_at: new Date().toISOString(),
    app: 'mortgage-client-platform',
    tables,
    counts,
    rows: snapshot.rows,
    checksum,
    encrypted: !!envelope,
    envelope,
    documents,
    document_bytes: documentBytes,
    missing_documents: missing,
  };
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { dir, manifest };
}

/**
 * Table and column names cannot be parameterized, so anything that reaches a
 * statement as an identifier is checked against the schema this build knows
 * about. A backup archive is a file an operator can be handed by someone
 * else; it must not be able to name an arbitrary identifier.
 */
const KNOWN_TABLES = new Set(TABLES);

function assertKnownTable(table) {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`Backup names a table this application does not have: ${JSON.stringify(String(table).slice(0, 60))}.`);
  }
  return table;
}

async function columnsOf(table) {
  const rows = await db.all(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
    table
  );
  return new Set(rows.map((r) => r.column_name));
}

async function readManifest(dir) {
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1) {
    throw new Error(`Unsupported backup format ${manifest.format}.`);
  }
  if (!Array.isArray(manifest.tables)) {
    throw new Error('Backup manifest has no table list.');
  }
  manifest.tables.forEach(assertKnownTable);
  return manifest;
}

/** Decrypt + decompress + verify the data file. Throws on any mismatch. */
async function readRows(dir, manifest) {
  let bytes = await fsp.readFile(path.join(dir, 'data.jsonl.gz'));
  if (manifest.encrypted) {
    if (!manifest.envelope) throw new Error('Backup is marked encrypted but carries no key envelope.');
    bytes = cryptoStore.decryptBuffer(bytes, manifest.envelope);
  }
  const plaintext = await gunzip(bytes);
  const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (checksum !== manifest.checksum) {
    throw new Error('Backup checksum mismatch — the archive is corrupt or truncated. Refusing to restore.');
  }
  const rows = [];
  for (const line of plaintext.toString('utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

/** Verify an archive without touching the live database. */
async function verifyBackup(dir) {
  const manifest = await readManifest(dir);
  const rows = await readRows(dir, manifest);
  const counts = {};
  for (const { t } of rows) counts[t] = (counts[t] || 0) + 1;
  const mismatches = [];
  for (const table of manifest.tables) {
    if ((counts[table] || 0) !== (manifest.counts[table] || 0)) {
      mismatches.push({ table, expected: manifest.counts[table] || 0, found: counts[table] || 0 });
    }
  }
  let documentsPresent = 0;
  const docDir = path.join(dir, 'documents');
  if (fs.existsSync(docDir)) documentsPresent = (await fsp.readdir(docDir)).length;
  return {
    ok: mismatches.length === 0 && documentsPresent === manifest.documents,
    manifest,
    rows: rows.length,
    mismatches,
    documents_present: documentsPresent,
  };
}

/**
 * Restore a backup over the current database.
 *
 * DESTRUCTIVE: every table in the archive is emptied first. Requires an
 * explicit confirm flag so a mistyped command cannot wipe production.
 */
async function restoreBackup(dir, { confirm = false, restoreDocuments = true } = {}) {
  if (!confirm) {
    throw new Error('restoreBackup requires { confirm: true } — it deletes all current data.');
  }
  const manifest = await readManifest(dir);
  const rows = await readRows(dir, manifest);

  const byTable = new Map(manifest.tables.map((t) => [t, []]));
  for (const { t, r } of rows) {
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(r);
  }

  await db.tx(async () => {
    // Delete children first.
    for (const table of [...manifest.tables].reverse()) {
      await db.run(`DELETE FROM ${table}`);
    }
    for (const table of manifest.tables) {
      const list = byTable.get(table) || [];
      const known = await columnsOf(table);
      for (const row of list) {
        const cols = Object.keys(row).filter((c) => known.has(c));
        if (!cols.length) continue;
        const placeholders = cols.map(() => '?').join(', ');
        await db.run(
          `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')})
           OVERRIDING SYSTEM VALUE VALUES (${placeholders})`,
          ...cols.map((c) => row[c])
        );
      }
      // Identity columns were fed explicit ids, so the sequence must be moved
      // past them or the next insert collides with restored data.
      if ((byTable.get(table) || []).some((r) => r.id !== undefined)) {
        await db.run(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1),
                         (SELECT COUNT(*) FROM ${table}) > 0)`
        );
      }
    }
  });

  let documents = 0;
  if (restoreDocuments) {
    const docDir = path.join(dir, 'documents');
    if (fs.existsSync(docDir)) {
      for (const name of await fsp.readdir(docDir)) {
        const bytes = await fsp.readFile(path.join(docDir, name));
        // Overwrite whatever is there: a restore is authoritative.
        await storage.removeStored(name);
        await storage.writeRaw(name, bytes);
        documents += 1;
      }
    }
  }

  return { tables: manifest.tables.length, rows: rows.length, documents };
}

/** Delete backup directories older than `days`, keeping at least `keep`. */
async function pruneBackups(destRoot, { days = 30, keep = 7 } = {}) {
  let entries;
  try {
    entries = (await fsp.readdir(destRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => e.name)
      .sort();
  } catch {
    return { removed: 0 };
  }
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    const stat = await fsp.stat(path.join(destRoot, name)).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(path.join(destRoot, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return { removed };
}


// ---------------------------------------------------------------------------
// Scheduled backups

const BACKUP_PREFIX = 'backups';

/**
 * Take a scheduled database backup and put it somewhere that outlives the
 * process.
 *
 * The manual `npm run backup` writes a directory on local disk, which is the
 * right answer on a server with a volume and useless on Vercel: the
 * filesystem there is per-invocation, so a backup written to it is gone
 * before anyone could fetch it. So this pass writes to the object store,
 * and when there is no object store it fails loudly rather than producing a
 * file nobody can ever read.
 *
 * Documents are not re-copied. When an object store is configured the
 * document blobs already live in it, so a second copy in the same bucket
 * doubles the storage bill without surviving anything the first copy would
 * not. What has no other copy under this application's control is the
 * database, and that is what this saves.
 */
async function runBackupPass({ force = false, asOf = new Date() } = {}) {
  const cfg = await db.getSetting('backups', {});
  if (cfg.enabled === false) return { skipped: 'disabled' };

  const day = asOf.toISOString().slice(0, 10);
  const state = await db.getSetting('backup_state', {});
  if (!force && state.last_day === day) return { skipped: 'already_ran_today', last_key: state.last_key };

  const objectstore = require('./objectstore');
  if (!objectstore.isConfigured()) {
    // Deliberately an error: a "successful" backup that went nowhere is the
    // failure mode this whole pass exists to prevent.
    throw new Error(
      'Scheduled backups need an object store (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). '
      + 'Without one there is nowhere durable to write to, and a backup on this filesystem would not survive the request.'
    );
  }

  const snapshot = await databaseSnapshot();
  const name = `backup-${stamp()}`;
  const manifest = {
    format: 1,
    created_at: asOf.toISOString(),
    app: 'mortgage-client-platform',
    scheduled: true,
    tables: snapshot.tables,
    counts: snapshot.counts,
    rows: snapshot.rows,
    checksum: snapshot.checksum,
    encrypted: !!snapshot.envelope,
    envelope: snapshot.envelope,
    // Documents are not duplicated here; they are already in this bucket.
    documents: 0,
    document_bytes: 0,
    missing_documents: [],
    documents_note: 'Database only. Document blobs already live in this object store.',
  };

  await objectstore.putObject(`${BACKUP_PREFIX}/${name}/data.jsonl.gz`, snapshot.bytes, 'application/gzip');
  await objectstore.putObject(
    `${BACKUP_PREFIX}/${name}/manifest.json`,
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    'application/json'
  );

  const pruned = await pruneStoredBackups(cfg.retain_days ?? 30, asOf);
  await db.setSetting('backup_state', {
    last_day: day,
    last_at: asOf.toISOString(),
    last_key: `${BACKUP_PREFIX}/${name}`,
    last_rows: snapshot.rows,
    last_bytes: snapshot.bytes.length,
  });

  return { key: `${BACKUP_PREFIX}/${name}`, rows: snapshot.rows, bytes: snapshot.bytes.length, pruned };
}

/**
 * Delete stored backups older than the retention window.
 *
 * The date comes from the key this code wrote, not from the object store's
 * own metadata, so a key that does not parse is left alone rather than
 * deleted on a guess.
 */
async function pruneStoredBackups(retainDays, asOf = new Date()) {
  const days = Number(retainDays);
  if (!Number.isFinite(days) || days <= 0) return [];
  const objectstore = require('./objectstore');
  const cutoff = asOf.getTime() - days * 86400000;

  const removed = [];
  for (const obj of await objectstore.listObjects()) {
    const m = /^backups\/backup-(\d{4}-\d{2}-\d{2})T/.exec(obj.key);
    if (!m) continue;
    const taken = Date.parse(`${m[1]}T00:00:00Z`);
    if (!Number.isFinite(taken) || taken >= cutoff) continue;
    await objectstore.deleteObject(obj.key);
    removed.push(obj.key);
  }
  return removed;
}

/** What the administrator status page reports about backups. */
async function backupStatus() {
  const cfg = await db.getSetting('backups', {});
  const state = await db.getSetting('backup_state', {});
  const objectstore = require('./objectstore');
  return {
    enabled: cfg.enabled !== false,
    destination: objectstore.isConfigured() ? 'object_store' : null,
    retain_days: cfg.retain_days ?? 30,
    last_at: state.last_at || null,
    last_key: state.last_key || null,
    last_rows: state.last_rows ?? null,
  };
}

module.exports = {
  createBackup, restoreBackup, verifyBackup, pruneBackups,
  databaseSnapshot, runBackupPass, pruneStoredBackups, backupStatus,
  TABLES, TRANSIENT,
};
