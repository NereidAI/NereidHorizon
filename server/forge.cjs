// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// NereidForge Model Registry + Open Horizon Edge Sync Service (ESS/CSS)
// integration client.
//
// Architectural role: this module is the only place that knows the wire
// contracts of two external systems:
//
//   1. NereidForge (the model factory). Its business API is served under
//      /api/v1 and authenticated with a local HS256 JWT. There is no
//      headless/service-account login: the password grant is protected by a
//      trivial arithmetic captcha whose expression is returned in clear text
//      by GET /api/v1/auth/captcha. A trusted server-side caller solves that
//      expression, exchanges it together with a configured service account
//      for an access token, and caches the token until shortly before expiry.
//      The deployable unit is a "production edge package" built automatically
//      by Forge at the end of an optimization job (a gzip tar containing the
//      nereid-model.json descriptor, labels, OVMS layout and verified
//      artifacts). Packages are keyed by precision (fp32/fp16/int8, one IR
//      serves every device at runtime): GET .../packages lists ready ones and
//      bytes stream from GET .../package?precision=. There is deliberately no
//      build-trigger route; per-precision status is carried in the version's
//      metadata.packages[].
//
//   2. The Edge Sync Service Cloud Sync Service (CSS), the Open Horizon MMS
//      data plane. One MMS object carries exactly one opaque data blob, so a
//      multi-file model can only be delivered as the single archive the Forge
//      packager produced; the BFF never repackages anything. The hub's
//      Exchange REST route /orgs/{org}/objects is not enabled on this
//      deployment (EXCHANGE_FSS unset), so model objects are published
//      directly against ESS's native REST API on port 9443. ESS authenticates
//      with the same Exchange Basic credentials already held in the console
//      session, so no extra credential is required. A model is published in
//      two steps: create metadata (noData:false plus a destinationsList) with
//      PUT /objects/{org}/{type}/{id}, then stream the package bytes through
//      unchanged to PUT /objects/{org}/{type}/{id}/data. Setting noData:true
//      would instead declare a permanently data-less object and make the
//      subsequent data upload fail with 400.
//
// Design constraints:
//   - Package bytes never touch disk or memory in full: the Forge web
//     ReadableStream is piped straight into the ESS request (fetch duplex).
//   - The module is transport-only and stateless apart from the Forge token
//     cache; Express routes in index.cjs own auth, CSRF and the HTTP response.
//   - All ESS object identifiers are restricted to the ESS-safe character set
//     because they are interpolated into the request path (no '/', ':', '<',
//     '>', space).

const crypto = require('crypto');
const { Readable } = require('stream');

// Package precisions the Forge optimization pipeline produces (mirrors
// PRECISIONS in NereidForge model_packages service). Ordered full precision
// first, then half precision and the quantized variant.
const PACKAGE_PRECISIONS = Object.freeze(['fp32', 'fp16', 'int8']);

const ESS_DEFAULT_PORT = '9443';

// settings keys (stored in the PostgreSQL settings table, configured on the
// Settings page):
//   forge_base_url   e.g. http://forge.example.com:8000 (no trailing /api/v1)
//   forge_username   service-account username
//   forge_password   service-account password
//   forge_namespace  login namespace ("" = default-tenant super admin)
//   forge_tenant     X-Tenant-Id header value for model listing (default)
//   ess_base_url     optional explicit CSS base; default derived from Exchange

/**
 * Normalize the Forge-related settings into a config object.
 * @param {Record<string,string>} settings Raw settings map from the database.
 * @returns {{baseUrl:string,username:string,password:string,namespace:string,tenant:string}}
 */
function forgeConfig(settings) {
  const m = settings || {};
  return {
    baseUrl: String(m.forge_base_url || '').replace(/\/+$/, ''),
    username: String(m.forge_username || ''),
    password: String(m.forge_password || ''),
    namespace: String(m.forge_namespace || ''),
    tenant: String(m.forge_tenant || 'default'),
  };
}

/**
 * Report whether Forge integration is fully configured (base URL + account).
 * @param {Record<string,string>} settings Raw settings map.
 * @returns {boolean} true when a Forge login can be attempted.
 */
function forgeConfigured(settings) {
  const c = forgeConfig(settings);
  return Boolean(c.baseUrl && c.username && c.password);
}

/**
 * Extract a human-readable message from a Forge (FastAPI/Go-envelope) body.
 * @param {any} body Parsed JSON body or raw text.
 * @param {number} status HTTP status.
 * @returns {string} Best-effort error message.
 */
function forgeErrorText(body, status) {
  if (body && typeof body === 'object') {
    return body.detail || body.message || body.code || `Forge request failed (${status})`;
  }
  return String(body || `Forge request failed (${status})`);
}

/**
 * Solve the Forge login captcha expression (e.g. "7 x 2 = ?", "9 - 3 = ?").
 * The expression is delivered in clear text and only uses +, -, x on integers
 * 0..10, so a trusted server-side caller can evaluate it directly.
 * @param {string} expression Captcha expression as returned by the API.
 * @returns {number} The integer answer.
 * @throws {Error} When the expression uses an unsupported shape/operator.
 */
function solveCaptcha(expression) {
  const m = String(expression || '').replace(/\s/g, '').match(/^(-?\d+)([+\-x])(-?\d+)=\?$/);
  if (!m) throw new Error(`unsupported Forge captcha expression: ${expression}`);
  const a = parseInt(m[1], 10);
  const b = parseInt(m[3], 10);
  if (m[2] === '+') return a + b;
  if (m[2] === '-') return a - b;
  return a * b; // 'x'
}

// In-memory access-token cache keyed by base URL + username. Entries carry an
// absolute expiry timestamp; a miss/expiry triggers a fresh captcha+login.
const tokenCache = new Map();

function tokenCacheKey(cfg) {
  return `${cfg.baseUrl}|${cfg.username}`;
}

/**
 * Perform a captcha+password login against Forge and cache the access token.
 * @param {ReturnType<typeof forgeConfig>} cfg Forge config.
 * @returns {Promise<string>} The Bearer access token.
 * @throws {Error} When the captcha or credentials are rejected.
 */
async function forgeLogin(cfg) {
  const capRes = await fetch(`${cfg.baseUrl}/api/v1/auth/captcha`, { method: 'GET' });
  if (!capRes.ok) throw new Error(`Forge captcha failed (${capRes.status})`);
  const captcha = await capRes.json();

  const loginRes = await fetch(`${cfg.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      username: cfg.username,
      password: cfg.password,
      namespace: cfg.namespace,
      captcha_id: captcha.captcha_id,
      captcha_answer: solveCaptcha(captcha.expression),
    }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginRes.ok || !loginBody?.access_token) {
    throw new Error(forgeErrorText(loginBody, loginRes.status) || 'Forge login failed');
  }
  // Refresh two minutes early so an in-flight call never uses an expired token.
  const ttlMs = Math.max(60, (loginBody.expires_in || 3600) - 120) * 1000;
  const entry = { token: loginBody.access_token, expiresAt: Date.now() + ttlMs };
  tokenCache.set(tokenCacheKey(cfg), entry);
  return entry.token;
}

/**
 * Return a valid Forge access token, logging in when the cache is cold/stale.
 * @param {ReturnType<typeof forgeConfig>} cfg Forge config.
 * @returns {Promise<string>} A Bearer-ready JWT.
 */
async function forgeToken(cfg) {
  const cached = tokenCache.get(tokenCacheKey(cfg));
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  return forgeLogin(cfg);
}

/**
 * GET JSON from Forge with a cached Bearer token, retrying once after a
 * re-login on a 401 (a restarted Forge invalidates previously issued tokens).
 * @param {ReturnType<typeof forgeConfig>} cfg Forge config.
 * @param {string} pathname Path beginning with /api/v1.
 * @param {boolean} [retried] Internal: true on the second attempt.
 * @returns {Promise<any>} Parsed JSON response.
 */
async function forgeGetJson(cfg, pathname, retried = false) {
  const token = await forgeToken(cfg);
  const res = await fetch(`${cfg.baseUrl}${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Tenant-Id': cfg.tenant },
  });
  if (res.status === 401 && !retried) {
    tokenCache.delete(tokenCacheKey(cfg));
    return forgeGetJson(cfg, pathname, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(forgeErrorText(body, res.status));
  return body;
}

/**
 * List the version's ready precision packages ("OH passthrough" endpoint).
 * Forge only returns ready packages, keyed by precision (fp32/fp16/int8), with
 * quality-gate and per-device verification data. Packaging is automatic at
 * optimization-job end; this call never triggers a build.
 * @param {ReturnType<typeof forgeConfig>} cfg Forge config.
 * @param {string} modelName Model name.
 * @param {string} version Model version.
 * @returns {Promise<Array<Record<string,any>>>} Ready precision package records.
 */
async function forgeListPackages(cfg, modelName, version) {
  const body = await forgeGetJson(
    cfg,
    `/api/v1/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/packages`,
  );
  const list = Array.isArray(body?.packages) ? body.packages : [];
  return list.filter((r) => r && PACKAGE_PRECISIONS.includes(String(r.precision || '').toLowerCase()));
}

/**
 * Open a streaming download of a ready precision package (the gzip tar Forge
 * built automatically at optimization-job end). Fails with Forge's own
 * message when the package does not exist (404) or is not ready yet (409).
 * The caller owns the returned web stream and must consume/abort it.
 * @param {ReturnType<typeof forgeConfig>} cfg Forge config.
 * @param {string} modelName Model name.
 * @param {string} version Model version.
 * @param {string} precision Package precision ('fp32', 'fp16' or 'int8').
 * @returns {Promise<Response>} A successful Fetch Response whose body is the package stream.
 */
async function forgeOpenPackage(cfg, modelName, version, precision) {
  const token = await forgeToken(cfg);
  const url = `${cfg.baseUrl}/api/v1/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/package?precision=${encodeURIComponent(precision)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': cfg.tenant },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(forgeErrorText(body, res.status) || `package download failed (${res.status})`);
  }
  return res;
}

/**
 * Derive the ESS (CSS) base URL from settings or, by default, from the
 * Exchange base URL: same host and scheme, ESS standard port 9443.
 * @param {Record<string,string>} settings Raw settings map.
 * @param {string} exchangeBaseUrl Configured Exchange base URL (no /v1 suffix).
 * @returns {string} ESS base URL without trailing slash, or '' when undeterminable.
 */
function essBaseUrl(settings, exchangeBaseUrl) {
  const override = String(settings?.ess_base_url || '').replace(/\/+$/, '');
  if (override) return override;
  try {
    const u = new URL(exchangeBaseUrl);
    u.port = ESS_DEFAULT_PORT;
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Issue a request against the ESS native REST API using Exchange Basic auth.
 * @param {string} base ESS base URL.
 * @param {string} auth Base64 Exchange Basic credential from the session.
 * @param {string} method HTTP method.
 * @param {string} apiPath Path beginning with /objects or /destinations (/api/v1 prepended).
 * @param {{json?:unknown,body?:any,headers?:Record<string,string>,duplex?:string}} [opts] Body/headers.
 * @returns {Promise<Response>} The raw Fetch Response (caller checks status).
 */
async function essFetch(base, auth, method, apiPath, opts = {}) {
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const init = {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  };
  // undici requires duplex:'half' on a streaming ReadableStream request body.
  if (opts.duplex) init.duplex = opts.duplex;
  return fetch(`${base}/api/v1${apiPath}`, init);
}

/**
 * Read an ESS error body into an Error.
 * @param {Response} res Failed ESS response.
 * @param {string} action Human action for the message.
 * @returns {Promise<Error>}
 */
async function essError(res, action) {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed.error || parsed.message || parsed.detail || text;
  } catch { /* keep raw text */ }
  return new Error(`ESS ${action} failed (${res.status}): ${detail || res.statusText}`);
}

/**
 * Parse an ESS JSON response, treating 404 as the supplied empty value (ESS
 * returns 404 for "no objects/types/destinations" rather than an empty list).
 * @param {Response} res ESS response.
 * @param {any} empty Value to return on 404.
 * @returns {Promise<any>} Parsed body or the empty value.
 */
async function essJsonOrEmpty(res, empty) {
  if (res.status === 404) return empty;
  const text = await res.text();
  if (!text) return empty;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * List the ESS destinations (registered edge nodes/Ess instances) of an org.
 * @param {string} base ESS base URL.
 * @param {string} auth Session Exchange Basic credential.
 * @param {string} org Organization id.
 * @returns {Promise<Array<{destinationType:string,destinationID:string,destinationOrgID:string,communication:string}>>}
 */
async function listDestinations(base, auth, org) {
  const res = await essFetch(base, auth, 'GET', `/destinations/${encodeURIComponent(org)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw await essError(res, 'list destinations');
  return essJsonOrEmpty(res, []);
}

/**
 * List every MMS object of an org across all object types. ESS exposes types
 * and per-type objects separately, so this fans out one list call per type.
 * @param {string} base ESS base URL.
 * @param {string} auth Session Exchange Basic credential.
 * @param {string} org Organization id.
 * @returns {Promise<Array<Record<string,any>>>} Object metadata list with an injected objectType field.
 */
async function listObjects(base, auth, org) {
  const typesRes = await essFetch(base, auth, 'GET', `/objects/${encodeURIComponent(org)}?list_object_type=true`);
  const types = await essJsonOrEmpty(typesRes, []);
  const typeList = Array.isArray(types) ? types : [];
  const lists = await Promise.all(typeList.map(async (type) => {
    const r = await essFetch(
      base, auth, 'GET',
      `/objects/${encodeURIComponent(org)}/${encodeURIComponent(type)}?all_objects=true`,
    );
    const items = await essJsonOrEmpty(r, []);
    const arr = Array.isArray(items) ? items : [];
    // all_objects=true also returns deletion tombstones; hide them from the UI.
    return arr
      .filter((meta) => meta.deleted !== true)
      .map((meta) => ({ ...meta, objectType: meta.objectType || type }));
  }));
  return lists.flat();
}

/**
 * Fetch the per-destination delivery status of an object.
 * @param {string} base ESS base URL.
 * @param {string} auth Session Exchange Basic credential.
 * @param {string} org Organization id.
 * @param {string} type Object type.
 * @param {string} id Object id.
 * @returns {Promise<any>} Parsed destinations/status payload (or [] when none).
 */
async function objectDestinations(base, auth, org, type, id) {
  const res = await essFetch(
    base, auth, 'GET',
    `/objects/${encodeURIComponent(org)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}/destinations`,
  );
  return essJsonOrEmpty(res, []);
}

/**
 * Hash the bytes ESS currently stores for an object. This is an independent
 * verification read; publication itself remains a byte-transparent stream and
 * never spools or re-encodes the package.
 * @param {string} base ESS base URL.
 * @param {string} auth Exchange Basic credential.
 * @param {string} org Organization id.
 * @param {string} type Object type.
 * @param {string} id Object id.
 * @returns {Promise<{sha256:string,bytes:number}>} Stored object digest and byte count.
 */
async function hashObjectData(base, auth, org, type, id) {
  const res = await essFetch(
    base, auth, 'GET',
    `/objects/${encodeURIComponent(org)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}/data`,
  );
  if (!res.ok || !res.body) throw await essError(res, 'read object data');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Delete an object (metadata + data) from ESS.
 * @param {string} base ESS base URL.
 * @param {string} auth Session Exchange Basic credential.
 * @param {string} org Organization id.
 * @param {string} type Object type.
 * @param {string} id Object id.
 * @returns {Promise<void>}
 */
async function deleteObject(base, auth, org, type, id) {
  const path = `/objects/${encodeURIComponent(org)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const res = await essFetch(base, auth, 'DELETE', path);
  if (res.ok || res.status === 404) return;

  // ESS (mongo backend) 500s on DELETE when the object still has destinations
  // but no data file (e.g. a data-less object, or metadata left behind after a
  // failed data upload): "File ... not found in mongo db". Recover by detaching
  // every destination first (POST .../destinations action=remove), which makes
  // ESS take its metadata-only delete branch, then retry.
  const destRes = await essFetch(base, auth, 'GET', `${path}/destinations`);
  if (destRes.ok) {
    const dests = await destRes.json().catch(() => []);
    if (Array.isArray(dests) && dests.length > 0) {
      const list = dests.map((d) => `${d.destinationType}:${d.destinationID}`);
      const rm = await essFetch(base, auth, 'POST', `${path}/destinations`, {
        json: { action: 'remove', destinations: list },
      });
      if (!rm.ok && rm.status !== 404) throw await essError(rm, 'remove object destinations');
    }
  }
  const retry = await essFetch(base, auth, 'DELETE', path);
  if (!retry.ok && retry.status !== 404) throw await essError(retry, 'delete object');
}

// ESS object identifiers accept [A-Za-z0-9!@#$^*\-_.~] plus unicode letters;
// reject path/separator characters to keep the interpolated URL unambiguous.
const SAFE_ID = /^[\w.\-~!@#$^*]+$/u;

/**
 * Validate an ESS object type/id token.
 * @param {string} value Candidate token.
 * @returns {boolean} true when safe to embed in the ESS path.
 */
function isSafeObjectToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && SAFE_ID.test(value);
}

/**
 * Validate the common ESS publication envelope shared by Forge downloads and
 * operator-uploaded packages.
 * @param {object} args Publication arguments.
 * @returns {void}
 */
function validatePublishEnvelope(args) {
  const { org, objectType, objectID, destinations } = args;
  if (!org) throw new Error('organization is required');
  if (!isSafeObjectToken(objectType)) throw new Error('invalid object type');
  if (!isSafeObjectToken(objectID)) throw new Error('invalid object id');
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error('at least one destination is required');
  }
  for (const d of destinations) {
    if (typeof d !== 'string' || !d.includes(':') || /[<>]/.test(d)) {
      throw new Error(`invalid destination: ${d}`);
    }
  }
}

/**
 * Publish one already-packaged byte stream through ESS without inspecting or
 * modifying its payload. Both Forge downloads and validated custom uploads
 * use this owner for metadata creation, data transfer and failure cleanup.
 * Note: noData:true declares a permanently data-less object; data-carrying
 * objects must be created with noData:false before the data PUT.
 *
 * @param {object} args
 * @param {Record<string,string>} args.settings Raw settings map.
 * @param {string} args.exchangeBaseUrl Configured Exchange base URL.
 * @param {string} args.auth Session Exchange Basic credential.
 * @param {string} args.org Target organization id.
 * @param {string} args.objectType ESS object type.
 * @param {string} args.objectID ESS object id.
 * @param {string[]} args.destinations ESS "destinationType:destinationID" strings.
 * @param {string} args.description Object description.
 * @param {string} args.version Object version.
 * @param {any} args.body Node or web ReadableStream containing the package.
 * @param {number} [args.bytes] Package size in bytes, when known.
 * @param {string} [args.contentType] ESS data content type.
 * @returns {Promise<{objectType:string,objectID:string,bytes:number,destinationCount:number}>}
 */
async function publishPackageStream(args) {
  const {
    settings, exchangeBaseUrl, auth, org, objectType, objectID, destinations,
    description, version, body, bytes = 0, contentType = 'application/gzip',
  } = args;
  validatePublishEnvelope(args);
  if (!body) throw new Error('package stream is required');
  const base = essBaseUrl(settings, exchangeBaseUrl);
  if (!base) throw new Error('ESS base URL cannot be determined');
  const objectPath = `/objects/${encodeURIComponent(org)}/${encodeURIComponent(objectType)}/${encodeURIComponent(objectID)}`;
  const cancelSource = async () => {
    if (typeof body.cancel === 'function') await body.cancel().catch(() => {});
    else if (typeof body.destroy === 'function') body.destroy();
  };

  let metaCreated = false;
  try {
    const meta = {
      objectID,
      objectType,
      description: description || objectID,
      version: String(version || ''),
      noData: false,
      destinationsList: destinations,
    };
    const metaRes = await essFetch(base, auth, 'PUT', objectPath, { json: { meta } });
    if (!metaRes.ok && metaRes.status !== 204 && metaRes.status !== 201) {
      throw await essError(metaRes, 'create object metadata');
    }
    metaCreated = true;

    // undici requires duplex:'half' for both Node and web request streams.
    const dataRes = await essFetch(base, auth, 'PUT', `${objectPath}/data`, {
      body,
      duplex: 'half',
      headers: { 'Content-Type': contentType },
    });
    if (!dataRes.ok) throw await essError(dataRes, 'upload object data');
    await dataRes.text().catch(() => {});
  } catch (err) {
    await cancelSource();
    if (metaCreated) await deleteObject(base, auth, org, objectType, objectID).catch(() => {});
    throw err;
  }

  return { objectType, objectID, bytes, destinationCount: destinations.length };
}

/**
 * Open a ready Forge precision package and publish its bytes unchanged. Forge
 * errors fail before ESS metadata exists; transport failures use the common
 * cleanup path in publishPackageStream.
 * @param {object} args Forge reference plus the common publication envelope.
 * @returns {Promise<{objectType:string,objectID:string,bytes:number,destinationCount:number,precision:string}>}
 */
async function publishModel(args) {
  const {
    settings, exchangeBaseUrl, auth, org, modelName, version, precision,
    objectType, objectID, destinations, description,
  } = args;
  if (!forgeConfigured(settings)) throw new Error('NereidForge integration is not configured');
  if (!PACKAGE_PRECISIONS.includes(precision)) {
    throw new Error(`invalid package precision: ${precision}`);
  }
  validatePublishEnvelope(args);

  const pkg = await forgeOpenPackage(forgeConfig(settings), modelName, version, precision);
  const result = await publishPackageStream({
    settings, exchangeBaseUrl, auth, org, objectType, objectID, destinations,
    description: description || `${modelName} ${version} (${precision})`,
    version: String(version || ''),
    body: pkg.body,
    bytes: Number(pkg.headers?.get('content-length')) || 0,
    contentType: pkg.headers.get('content-type') || 'application/gzip',
  });
  return { ...result, precision };
}

module.exports = {
  ESS_DEFAULT_PORT,
  PACKAGE_PRECISIONS,
  forgeConfig,
  forgeConfigured,
  forgeLogin,
  forgeToken,
  forgeGetJson,
  forgeListPackages,
  forgeOpenPackage,
  essBaseUrl,
  essFetch,
  essJsonOrEmpty,
  listDestinations,
  listObjects,
  objectDestinations,
  hashObjectData,
  deleteObject,
  isSafeObjectToken,
  validatePublishEnvelope,
  publishPackageStream,
  publishModel,
};
