// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// PostgreSQL data layer for NereidAI console.
// Stores: local BFF users, partner API keys (org-scoped, revocable),
// the singleton Exchange connection config, and the append-only audit log.
// Database is mandatory (dev and prod) — the app fails fast if it cannot connect.

const { Pool } = require('pg');
const crypto = require('crypto');
const {
  PARTNER_READ_SCOPE,
  normalizeApiKeyScopes,
} = require('./api-key-scopes.cjs');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL is not set. PostgreSQL is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });

pool.on('error', (e) => console.error('[db] pool error:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username   TEXT NOT NULL,
  hash       TEXT,
  salt       TEXT,
  role       TEXT NOT NULL CHECK (role IN ('platform','partner')),
  org        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email      TEXT,
  issuer     TEXT,
  subject    TEXT,
  disabled   BOOLEAN NOT NULL DEFAULT false,
  bootstrap  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  ciphertext TEXT NOT NULL,
  born_at    BIGINT NOT NULL,
  seen_at    BIGINT NOT NULL,
  expire_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,
  key_plain  TEXT NOT NULL,
  org        TEXT NOT NULL,
  label      TEXT NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  scopes     TEXT[] NOT NULL DEFAULT ARRAY['partner:read']::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys(revoked);

CREATE TABLE IF NOT EXISTS exchange_config (
  id         INT PRIMARY KEY DEFAULT 1,
  base_url   TEXT NOT NULL,
  auth       TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  version    TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  org        TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INT,
  ip         TEXT,
  ms         INT,
  proxied_to TEXT,
  detail     JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent model-distribution task handles (nh-model-distribution/v1). The
-- partial unique index is the ensure idempotency key: one active task per ESS
-- object identity. Terminal rows (failed/cancelled/rolled_back) keep their
-- audit trail but release the key so a later ensure can recreate the object.
CREATE TABLE IF NOT EXISTS distribution_tasks (
  id              TEXT PRIMARY KEY,
  org             TEXT NOT NULL,
  object_type     TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  precision       TEXT NOT NULL,
  destinations    TEXT[] NOT NULL,
  description     TEXT,
  state           TEXT NOT NULL CHECK (state IN ('in_progress','delivered','failed','cancelled','rolled_back')),
  failure_reason  TEXT,
  package_sha256  TEXT,
  package_bytes   BIGINT,
  created_by_key  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_distribution_tasks_active
  ON distribution_tasks(org, object_type, object_id)
  WHERE state IN ('in_progress','delivered');
CREATE INDEX IF NOT EXISTS idx_distribution_tasks_org
  ON distribution_tasks(org, created_at DESC);
`;

async function initSchema() {
  // Retry loop: PG may not be ready when app starts (Docker race), so retry 10x with 3s backoff
  let retries = 10;
  while (retries > 0) {
    try {
      const c = await pool.connect();
      try {
        await c.query(SCHEMA);
        // Migration: add key_plain column for existing tables
        await c.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_plain TEXT');
        // Existing partner keys remain read-only; new service keys must opt
        // into the model-distribution scope explicitly.
        await c.query("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['partner:read']::TEXT[]");
        // Migration: OIDC identity columns + disabled/bootstrap flags. OIDC
        // users have no local password, so hash/salt become nullable.
        await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
        await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS issuer TEXT');
        await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS subject TEXT');
        await c.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false");
        await c.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bootstrap BOOLEAN NOT NULL DEFAULT false");
        await c.query('ALTER TABLE users ALTER COLUMN hash DROP NOT NULL');
        await c.query('ALTER TABLE users ALTER COLUMN salt DROP NOT NULL');
        // Drop the legacy primary key (username) from the original schema.
        await c.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey');
        // Migration: identity-scoped uniqueness. Local accounts keep the old
        // (username[, org]) uniqueness; OIDC accounts are unique per (issuer,
        // subject) and may reuse any username (logins never key on username).
        await c.query('DROP INDEX IF EXISTS idx_users_platform_unique');
        await c.query('DROP INDEX IF EXISTS idx_users_partner_unique');
        await c.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_platform_unique ON users(username) WHERE issuer IS NULL AND org IS NULL');
        await c.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_partner_unique ON users(username, org) WHERE issuer IS NULL AND org IS NOT NULL');
        await c.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_identity ON users(issuer, subject) WHERE issuer IS NOT NULL');
        console.log('[db] schema ready');
        return;
      } finally {
        c.release();
      }
    } catch (e) {
      retries -= 1;
      console.warn(`[db] connect failed (${10 - retries}/10): ${e.message}`);
      if (retries === 0) {
        console.error('[db] FATAL: cannot reach PostgreSQL after retries.');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Wrapper around pool.query for consistency and easier testing
function query(text, params) {
  return pool.query(text, params);
}

// ---------------- Users ----------------
// Row shape shared by every user-facing query.
const USER_COLS = 'username, role, org, created_at, email, issuer, subject, disabled, bootstrap';

// Returns all BFF user accounts (without passwords)
async function loadUsers() {
  const { rows } = await query(`SELECT ${USER_COLS} FROM users ORDER BY created_at`);
  return rows.map((r) => ({
    username: r.username, role: r.role, org: r.org, createdAt: r.created_at,
    email: r.email || null, issuer: r.issuer || null, subject: r.subject || null,
    disabled: r.disabled, bootstrap: r.bootstrap,
    authType: r.issuer ? 'oidc' : 'local',
  }));
}
// Lookup a single LOCAL user by username and optional org.
// When org is provided (partner), scopes the lookup to that org.
// When omitted, only matches local platform users (org IS NULL).
// OIDC users never authenticate with a password and are excluded.
async function getUser(username, org) {
  const { rows } = org
    ? await query('SELECT * FROM users WHERE username = $1 AND org = $2 AND issuer IS NULL', [username, org])
    : await query('SELECT * FROM users WHERE username = $1 AND org IS NULL AND issuer IS NULL', [username]);
  return rows[0] || null;
}
// Look up an OIDC-federated user by its stable (issuer, subject) identity.
async function getOidcUser(issuer, subject) {
  const { rows } = await query('SELECT * FROM users WHERE issuer = $1 AND subject = $2', [issuer, subject]);
  return rows[0] || null;
}
// Sync role/org/email/display name of an OIDC user against the latest claims.
// Group membership is authoritative at the IdP and re-evaluated every login.
async function updateOidcUser(issuer, subject, { username, role, org, email }) {
  await query(
    `UPDATE users SET username=$3, role=$4, org=$5, email=$6 WHERE issuer=$1 AND subject=$2`,
    [issuer, subject, username, role, org || null, email || null],
  );
}
// Create a new BFF user. Local accounts provide hash+salt; OIDC accounts
// provide issuer+subject and leave the password columns NULL.
async function createUser({ username, hash, salt, role, org, createdAt, email, issuer, subject, bootstrap }) {
  await query(
    `INSERT INTO users(username, hash, salt, role, org, created_at, email, issuer, subject, bootstrap)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      username, hash || null, salt || null, role, org || null,
      createdAt || new Date().toISOString(), email || null, issuer || null, subject || null,
      bootstrap || false,
    ],
  );
}
// Delete a LOCAL BFF user account by username and optional org.
// Partner users must provide org to disambiguate cross-org duplicates.
async function deleteUser(username, org) {
  if (org) {
    await query('DELETE FROM users WHERE username = $1 AND org = $2 AND issuer IS NULL', [username, org]);
  } else {
    await query('DELETE FROM users WHERE username = $1 AND org IS NULL AND issuer IS NULL', [username]);
  }
}
// Delete an OIDC-federated user by its stable identity.
async function deleteOidcUser(issuer, subject) {
  await query('DELETE FROM users WHERE issuer = $1 AND subject = $2', [issuer, subject]);
}
// Enable/disable a user. OIDC users are disabled rather than deleted so a
// re-login cannot silently JIT-recreate an access the admin intended to revoke.
async function setUserDisabled(issuer, username, org, disabled) {
  if (issuer) {
    await query('UPDATE users SET disabled=$3 WHERE issuer=$1 AND subject=$2', [issuer, username, disabled]);
  } else if (org) {
    await query('UPDATE users SET disabled=$3 WHERE username=$1 AND org=$2 AND issuer IS NULL', [username, org, disabled]);
  } else {
    await query('UPDATE users SET disabled=$2 WHERE username=$1 AND org IS NULL AND issuer IS NULL', [username, disabled]);
  }
}
// Update a user's password hash+salt (used for password changes)
async function updatePassword(username, hash, salt, org) {
  if (org) {
    await query('UPDATE users SET hash=$2, salt=$3 WHERE username=$1 AND org=$4', [username, hash, salt, org]);
  } else {
    await query('UPDATE users SET hash=$2, salt=$3 WHERE username=$1 AND org IS NULL', [username, hash, salt]);
  }
}
// Update a user's role/org (platform only, for edit modal)
async function updateUser(username, org, updates) {
  const sets = [];
  const params = [username];
  let idx = 2;
  if (updates.role !== undefined) { sets.push(`role=$${idx++}`); params.push(updates.role); }
  if (updates.newOrg !== undefined) { sets.push(`org=$${idx++}`); params.push(updates.newOrg || null); }
  if (updates.hash !== undefined) { sets.push(`hash=$${idx++}`); params.push(updates.hash); }
  if (updates.salt !== undefined) { sets.push(`salt=$${idx++}`); params.push(updates.salt); }
  if (sets.length === 0) return;
  let whereClause;
  if (org) { whereClause = `org=$${idx++}`; params.push(org); }
  else { whereClause = 'org IS NULL'; }
  await query(`UPDATE users SET ${sets.join(', ')} WHERE username=$1 AND ${whereClause}`, params);
}

// ---------------- Exchange config (singleton) ----------------
// Load the persisted Exchange connection config. Returns {configured: false} if no row exists (first-time setup)
async function loadExchangeConfig() {
  const { rows } = await query('SELECT base_url, auth, org_id, version FROM exchange_config WHERE id=1');
  if (!rows[0]) return { configured: false };
  return {
    configured: true,
    baseURL: rows[0].base_url,
    auth: rows[0].auth,
    orgId: rows[0].org_id,
    version: rows[0].version || '',
  };
}
// Upsert the Exchange config (single row, id=1). updatedBy is the BFF username
async function saveExchangeConfig(cfg, updatedBy) {
  await query(
    `INSERT INTO exchange_config(id, base_url, auth, org_id, version, updated_at, updated_by)
     VALUES(1,$1,$2,$3,$4,now(),$5)
     ON CONFLICT (id) DO UPDATE SET base_url=$1, auth=$2, org_id=$3, version=$4, updated_at=now(), updated_by=$5`,
    [cfg.baseURL, cfg.auth, cfg.orgId, cfg.version, updatedBy || null],
  );
}

// ---------------- Scoped API keys ----------------
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
// Generate a secure key: nk_<env>_<~48 random url-safe base64 chars>
function generateApiKey() {
  const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
  const rand = crypto.randomBytes(36).toString('base64url');
  return `nk_${env}_${rand}`;
}
// Create a new API key: returns {id, key} with plaintext visible ONCE.
// The plaintext is stored so it can be retrieved later via getApiKeyPlain().
async function createApiKey({ org, label, expiresAt, createdBy, scopes }) {
  const plain = generateApiKey();
  const id = crypto.randomUUID();
  const keyHash = sha256Hex(plain);
  const normalizedScopes = normalizeApiKeyScopes(scopes);
  await query(
    'INSERT INTO api_keys(id, key_hash, key_plain, org, label, expires_at, scopes, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, keyHash, plain, org, label, expiresAt || null, normalizedScopes, createdBy || null],
  );
  return { id, key: plain, scopes: normalizedScopes }; // plaintext returned ONCE
}
// List keys; if org is specified, filter to that org, otherwise return all keys (platform)
async function listApiKeys(org) {
  const sql = 'SELECT id, org, label, revoked, expires_at, scopes, created_at, created_by FROM api_keys';
  const { rows } = org
    ? await query(`${sql} WHERE org=$1 ORDER BY created_at DESC`, [org])
    : await query(`${sql} ORDER BY created_at DESC`);
  return rows;
}
// Retrieve the plaintext of a key by id. Returns undefined (not found), null (no plaintext stored), or the key string
async function getApiKeyPlain(id) {
  const { rows } = await query('SELECT key_plain FROM api_keys WHERE id=$1', [id]);
  if (rows.length === 0) return undefined; // key not found
  if (rows[0].key_plain === null) return null; // found but no plaintext stored
  return rows[0].key_plain;
}
// Look up a key by its plaintext value (used during partner API auth). Returns full row or null
async function findApiKeyByPlain(plain) {
  const keyHash = sha256Hex(plain);
  const { rows } = await query('SELECT * FROM api_keys WHERE key_hash=$1', [keyHash]);
  return rows[0] || null;
}
// Mark a key as revoked (soft-delete). The record remains in DB for audit trail
async function revokeApiKey(id) {
  await query('UPDATE api_keys SET revoked=true WHERE id=$1', [id]);
}
// Hard-delete a key from the database
async function deleteApiKey(id) {
  await query('DELETE FROM api_keys WHERE id=$1', [id]);
}
// Regenerate a key: new hash+plain, unset revoked+expiry. Returns {key: newPlain}
async function renewApiKey(id) {
  const plain = generateApiKey();
  const keyHash = sha256Hex(plain);
  await query('UPDATE api_keys SET key_hash=$1, key_plain=$2, revoked=false, expires_at=NULL WHERE id=$3', [keyHash, plain, id]);
  return { key: plain };
}

// ---------------- Audit log (append-only) ----------------
// Insert a new audit record. Best-effort: silently catches errors to avoid disrupting the request
async function insertAudit(rec) {
  try {
    await query(
      `INSERT INTO audit_log(actor_type, actor, org, method, path, status, ip, ms, proxied_to, detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        rec.actorType, rec.actor, rec.org || null, rec.method, rec.path,
        rec.status ?? null, rec.ip || null, rec.ms ?? null, rec.proxiedTo || null,
        rec.detail ? JSON.stringify(rec.detail) : null,
      ],
    );
  } catch (e) {
    console.error('[audit] insert failed:', e.message);
  }
}

// Query audit log ordered by newest first. limit/offset for pagination
async function listAudit(limit, offset) {
  const { rows } = await query(
    'SELECT id, ts, actor_type, actor, org, method, path, status, ip, ms, proxied_to, detail FROM audit_log ORDER BY ts DESC LIMIT $1 OFFSET $2',
    [limit || 100, offset || 0],
  );
  return rows;
}

// Return the latest successful NH publication audit for each object identity
// in one org. ESS has no publication timestamp, so the console uses this
// non-sensitive provenance without treating the application version as time.
async function listMmsPublications(org) {
  const { rows } = await query(
    `SELECT DISTINCT ON (detail->'publication'->>'objectType', detail->'publication'->>'objectID')
       ts, actor, detail->'publication' AS publication
     FROM audit_log
     WHERE org=$1 AND method='EVENT' AND path='mms.publication' AND status=200
       AND detail->'publication' IS NOT NULL
     ORDER BY detail->'publication'->>'objectType', detail->'publication'->>'objectID', ts DESC`,
    [org],
  );
  return rows;
}

// ---------------- Distribution tasks (nh-model-distribution/v1) ----------------
// Insert a task row. Callers supply the generated id and the full lifecycle
// field set; RETURNING * gives back defaults such as created_at.
async function insertDistributionTask(row) {
  const { rows } = await query(
    `INSERT INTO distribution_tasks(
       id, org, object_type, object_id, model_name, model_version, precision,
       destinations, description, state, failure_reason, package_sha256,
       package_bytes, created_by_key, delivered_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      row.id, row.org, row.objectType, row.objectID, row.modelName, row.modelVersion,
      row.precision, row.destinations, row.description || null, row.state,
      row.failureReason || null, row.packageSHA256 || null,
      row.packageBytes == null ? null : row.packageBytes, row.createdByKey,
      row.deliveredAt || null, row.finishedAt || null,
    ],
  );
  return rows[0];
}

// Org-scoped task lookup. Returns null when the task does not exist or belongs
// to another org (service keys are org-bound anyway).
async function getDistributionTask(org, id) {
  const { rows } = await query(
    'SELECT * FROM distribution_tasks WHERE org=$1 AND id=$2',
    [org, id],
  );
  return rows[0] || null;
}

// Resolve the ensure idempotency key: the newest active task for an ESS object
// identity. The partial unique index guarantees at most one such row.
async function findActiveDistributionTask(org, objectType, objectID) {
  const { rows } = await query(
    `SELECT * FROM distribution_tasks
     WHERE org=$1 AND object_type=$2 AND object_id=$3 AND state IN ('in_progress','delivered')
     ORDER BY created_at DESC
     LIMIT 1`,
    [org, objectType, objectID],
  );
  return rows[0] || null;
}

// Flip an in_progress task to delivered on the first all-ready ESS observation.
// COALESCE preserves the earliest delivery timestamp; null means another caller
// already transitioned the row.
async function markDistributionTaskDelivered(org, id) {
  const { rows } = await query(
    `UPDATE distribution_tasks
       SET state='delivered',
           delivered_at=COALESCE(delivered_at, now()),
           updated_at=now()
     WHERE org=$1 AND id=$2 AND state='in_progress'
     RETURNING *`,
    [org, id],
  );
  return rows[0] || null;
}

// Guarded lifecycle transition (cancel/rollback). fromStates is the set of
// states in which the action is legal; a null return means the row moved
// concurrently and the caller must answer 409.
async function transitionDistributionTask(org, id, fromStates, state, finishedAt) {
  const { rows } = await query(
    `UPDATE distribution_tasks
       SET state=$3, finished_at=$4, updated_at=now()
     WHERE org=$1 AND id=$2 AND state = ANY($5::TEXT[])
     RETURNING *`,
    [org, id, state, finishedAt || new Date().toISOString(), fromStates],
  );
  return rows[0] || null;
}

// ---------------- System settings (key-value) ----------------
// Load all settings into a {key: value} map. Used on startup to override default TTL/retention
async function loadSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}
// Upsert a single setting key-value pair
async function saveSetting(key, value) {
  await query(
    'INSERT INTO settings(key, value, updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
    [key, value],
  );
}

// ---------------- Server sessions (encrypted) ----------------
// PostgreSQL is the authoritative session store; the process keeps an
// in-memory working set for synchronous handler access. ciphertext is the
// AES-256-GCM blob produced by the server. ttlSec drives idle expiry;
// seenAt/bornAt are epoch milliseconds for local timing decisions.
async function saveSession(id, { userId, ciphertext, bornAt, seenAt, ttlSec }) {
  await query(
    `INSERT INTO sessions(id, user_id, ciphertext, born_at, seen_at, expire_at)
     VALUES($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id, ciphertext=EXCLUDED.ciphertext,
       seen_at=EXCLUDED.seen_at, expire_at=EXCLUDED.expire_at`,
    [id, userId || null, ciphertext, bornAt, seenAt, String(ttlSec)],
  );
}
// Load a session row. Returns null when absent or already expired.
async function loadSession(id) {
  const { rows } = await query(
    'SELECT id, user_id, ciphertext, born_at, seen_at FROM sessions WHERE id=$1 AND expire_at > now()',
    [id],
  );
  return rows[0] || null;
}
// Slide the idle-expiry window forward on activity.
async function touchSessionRow(id, seenAt, ttlSec) {
  await query(
    "UPDATE sessions SET seen_at=$2, expire_at=now() + ($3 || ' seconds')::interval WHERE id=$1",
    [id, seenAt, String(ttlSec)],
  );
}
async function deleteSession(id) {
  await query('DELETE FROM sessions WHERE id=$1', [id]);
}
// Background cleanup of expired rows (called by the server sweeper).
async function deleteExpiredSessions() {
  await query('DELETE FROM sessions WHERE expire_at <= now()');
}

module.exports = {
  pool,
  initSchema,
  query,
  loadUsers,
  getUser,
  getOidcUser,
  updateOidcUser,
  createUser,
  deleteUser,
  deleteOidcUser,
  setUserDisabled,
  updatePassword,
  updateUser,
  loadExchangeConfig,
  saveExchangeConfig,
  PARTNER_READ_SCOPE,
  normalizeApiKeyScopes,
  sha256Hex,
  generateApiKey,
  createApiKey,
  listApiKeys,
  findApiKeyByPlain,
  getApiKeyPlain,
  revokeApiKey,
  deleteApiKey,
  renewApiKey,
  insertAudit,
  listAudit,
  listMmsPublications,
  insertDistributionTask,
  getDistributionTask,
  findActiveDistributionTask,
  markDistributionTaskDelivered,
  transitionDistributionTask,
  loadSettings,
  saveSetting,
  saveSession,
  loadSession,
  touchSessionRow,
  deleteSession,
  deleteExpiredSessions,
};
