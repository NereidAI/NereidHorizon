// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Tests for the versioned distribution-task contract
// (nh-model-distribution/v1): idempotent ensure, task handle polling,
// cancellation and rollback. Run with:
//   node --test server/distribution-tasks.test.cjs
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');
const realForge = require('./forge.cjs');
const { createDistributionTaskRouter } = require('./distribution-tasks.cjs');
const { PARTNER_READ_SCOPE, MODEL_DISTRIBUTE_SCOPE } = require('./api-key-scopes.cjs');

let server;
let baseURL;
let fakes;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/service/v1', createDistributionTaskRouter({
    db: {
      findApiKeyByPlain: (key) => fakes.db.findApiKeyByPlain(key),
      insertAudit: (record) => fakes.db.insertAudit(record),
      insertDistributionTask: (row) => fakes.db.insertDistributionTask(row),
      getDistributionTask: (...args) => fakes.db.getDistributionTask(...args),
      findActiveDistributionTask: (...args) => fakes.db.findActiveDistributionTask(...args),
      markDistributionTaskDelivered: (...args) => fakes.db.markDistributionTaskDelivered(...args),
      transitionDistributionTask: (...args) => fakes.db.transitionDistributionTask(...args),
    },
    forge: {
      validatePublishEnvelope: (...args) => fakes.forge.validatePublishEnvelope(...args),
      isSafeObjectToken: (...args) => fakes.forge.isSafeObjectToken(...args),
      forgeConfig: (...args) => fakes.forge.forgeConfig(...args),
      forgeConfigured: (...args) => fakes.forge.forgeConfigured(...args),
      essBaseUrl: (...args) => fakes.forge.essBaseUrl(...args),
      listObjects: (...args) => fakes.forge.listObjects(...args),
      forgeListPackages: (...args) => fakes.forge.forgeListPackages(...args),
      publishModel: (...args) => fakes.forge.publishModel(...args),
      hashObjectData: (...args) => fakes.forge.hashObjectData(...args),
      deleteObject: (...args) => fakes.forge.deleteObject(...args),
      objectDestinations: (...args) => fakes.forge.objectDestinations(...args),
    },
    getExchangeConfig: () => fakes.exchangeConfig,
    loadSettings: async () => fakes.settings,
  }));
  // Mirror index.cjs: one shared JSON 404 for unknown service paths.
  app.use('/api/service/v1', (req, res) => {
    res.status(404).json({ msg: 'Service API path not found' });
  });
  return app;
}

before(async () => {
  fakes = createFakes();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
});

// In-memory implementation of the db.cjs distribution-task surface.
function createTaskStore() {
  const rows = new Map();
  const stamp = () => new Date().toISOString();
  const toRow = (row) => ({
    id: row.id,
    org: row.org,
    object_type: row.objectType,
    object_id: row.objectID,
    model_name: row.modelName,
    model_version: row.modelVersion,
    precision: row.precision,
    destinations: row.destinations,
    description: row.description || null,
    state: row.state,
    failure_reason: row.failureReason || null,
    package_sha256: row.packageSHA256 || null,
    package_bytes: row.packageBytes == null ? null : row.packageBytes,
    created_by_key: row.createdByKey,
    created_at: stamp(),
    updated_at: stamp(),
    delivered_at: row.deliveredAt || null,
    finished_at: row.finishedAt || null,
  });
  return {
    rows,
    async insertDistributionTask(row) {
      const dbRow = toRow(row);
      rows.set(dbRow.id, dbRow);
      return dbRow;
    },
    async getDistributionTask(org, id) {
      const row = rows.get(id);
      return row && row.org === org ? row : null;
    },
    async findActiveDistributionTask(org, objectType, objectID) {
      const matches = [...rows.values()].filter((row) =>
        row.org === org && row.object_type === objectType && row.object_id === objectID
        && ['in_progress', 'delivered'].includes(row.state));
      matches.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return matches[0] || null;
    },
    async markDistributionTaskDelivered(org, id) {
      const row = rows.get(id);
      if (!row || row.org !== org || row.state !== 'in_progress') return null;
      row.state = 'delivered';
      row.delivered_at = row.delivered_at || stamp();
      row.updated_at = stamp();
      return row;
    },
    async transitionDistributionTask(org, id, fromStates, state, finishedAt) {
      const row = rows.get(id);
      if (!row || row.org !== org || !fromStates.includes(row.state)) return null;
      row.state = state;
      row.finished_at = finishedAt;
      row.updated_at = stamp();
      return row;
    },
  };
}

function createFakes() {
  const store = createTaskStore();
  const fakes = {
    audits: [],
    key: {
      id: 'key-1',
      org: 'myorg',
      label: 'nereidlink-prod',
      revoked: false,
      expires_at: null,
      scopes: [MODEL_DISTRIBUTE_SCOPE],
    },
    settings: {
      forge_base_url: 'https://forge.example',
      forge_username: 'nereidlink',
      forge_password: 'service-secret',
    },
    exchangeConfig: { configured: true, baseURL: 'http://exchange.example', auth: 'cm9vdDpyb290' },
    packages: [{
      precision: 'FP16',
      status: 'ready',
      package_bytes: 1234,
      package_sha256: 'a'.repeat(64),
    }],
    existingObjects: [],
    storedObject: { sha256: 'a'.repeat(64), bytes: 1234 },
    destinations: [],
    publishedArgs: null,
    publishCount: 0,
    publishError: null,
    deleted: [],
    destinationCalls: 0,
  };
  fakes.db = {
    findApiKeyByPlain: async () => fakes.key,
    insertAudit: async (record) => fakes.audits.push(record),
    ...wrapStore(store),
  };
  fakes.forge = {
    validatePublishEnvelope: realForge.validatePublishEnvelope,
    isSafeObjectToken: realForge.isSafeObjectToken,
    forgeConfig: realForge.forgeConfig,
    forgeConfigured: realForge.forgeConfigured,
    essBaseUrl: () => 'https://ess.example',
    listObjects: async () => fakes.existingObjects,
    forgeListPackages: async () => fakes.packages,
    publishModel: async (args) => {
      if (fakes.publishError) throw fakes.publishError;
      fakes.publishedArgs = args;
      fakes.publishCount += 1;
      return {
        objectType: args.objectType,
        objectID: args.objectID,
        bytes: 1234,
        destinationCount: args.destinations.length,
        precision: args.precision,
      };
    },
    hashObjectData: async () => fakes.storedObject,
    deleteObject: async (...args) => fakes.deleted.push(args),
    objectDestinations: async () => {
      fakes.destinationCalls += 1;
      return fakes.destinations;
    },
  };
  fakes.store = store;
  return fakes;
}

// Keep the fake db methods bound to the store even after fakes is reassigned.
function wrapStore(store) {
  return {
    insertDistributionTask: (row) => store.insertDistributionTask(row),
    getDistributionTask: (...args) => store.getDistributionTask(...args),
    findActiveDistributionTask: (...args) => store.findActiveDistributionTask(...args),
    markDistributionTaskDelivered: (...args) => store.markDistributionTaskDelivered(...args),
    transitionDistributionTask: (...args) => store.transitionDistributionTask(...args),
  };
}

beforeEach(() => {
  fakes = createFakes();
});

async function call(method, path, { key = 'nk_test_service', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (key !== null) headers['X-Api-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseURL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  const text = await response.text();
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

const validBody = {
  modelName: 'yunet',
  version: '0.0.1',
  precision: 'fp16',
  objectType: 'face-detection',
  objectID: 'yunet-fp16',
  destinations: ['openhorizon.edgenode:node1'],
};

const TASKS = '/api/service/v1/orgs/myorg/distribution-tasks';

async function ensure(body = validBody) {
  return call('POST', TASKS, { body });
}

test('service key must be present, scoped, org-bound and non-root', async () => {
  assert.equal((await call('POST', TASKS, { key: null, body: validBody })).status, 401);

  fakes.key.scopes = [PARTNER_READ_SCOPE];
  const scoped = await ensure();
  assert.equal(scoped.status, 403);
  assert.match(scoped.payload.msg, /model-distribution/);

  fakes.key.scopes = [MODEL_DISTRIBUTE_SCOPE];
  assert.equal((await call('POST', '/api/service/v1/orgs/root/distribution-tasks', { body: validBody })).status, 400);
  assert.equal((await call('POST', '/api/service/v1/orgs/other/distribution-tasks', { body: validBody })).status, 403);
});

test('unknown service paths terminate with the shared JSON 404', async () => {
  const response = await call('GET', '/api/service/v1/unknown');
  assert.equal(response.status, 404);
  assert.equal(response.payload.msg, 'Service API path not found');
});

test('ensure publishes once and returns an in-progress task handle', async () => {
  const response = await ensure();
  assert.equal(response.status, 201, response.payload);
  assert.match(response.payload.taskId, /^dt_[0-9a-f-]{36}$/);
  assert.equal(response.payload.state, 'in_progress');
  assert.equal(response.payload.deliveryState, 'in_progress');
  assert.equal(response.payload.edgeReady, false);
  assert.equal(response.payload.packageSHA256, 'a'.repeat(64));
  assert.equal(response.payload.packageBytes, 1234);
  assert.equal(fakes.publishedArgs.objectID, validBody.objectID);
  assert.equal(fakes.publishedArgs.precision, 'fp16');
  assert.equal(fakes.deleted.length, 0);

  const audit = fakes.audits.find((item) => item.path === 'mms.publication');
  assert.ok(audit, 'publication must be audited');
  assert.equal(audit.detail.taskId, response.payload.taskId);
  assert.equal(audit.actor, 'service:nereidlink-prod');

  const stored = await fakes.db.getDistributionTask('myorg', response.payload.taskId);
  assert.equal(stored.state, 'in_progress');
  assert.equal(stored.created_by_key, 'key-1');
});

test('ensure accepts an fp32 Forge package and normalizes the precision selector', async () => {
  fakes.packages = [{
    precision: 'FP32',
    status: 'ready',
    package_bytes: 1234,
    package_sha256: 'a'.repeat(64),
  }];
  const body = { ...validBody, precision: 'fp32', objectID: 'yunet-fp32' };
  const response = await ensure(body);
  assert.equal(response.status, 201, response.payload);
  assert.equal(fakes.publishedArgs.precision, 'fp32');
  assert.equal(fakes.publishedArgs.objectID, 'yunet-fp32');
  assert.equal(response.payload.packageSHA256, 'a'.repeat(64));
});

test('same-key retry is idempotent: it returns the existing task instead of 409 and never republishes', async () => {
  const first = await ensure();
  assert.equal(first.status, 201);
  assert.equal(fakes.publishCount, 1);
  const second = await ensure();
  assert.equal(second.status, 200);
  assert.equal(second.payload.idempotentReplay, true);
  assert.equal(second.payload.taskId, first.payload.taskId);
  assert.equal(fakes.publishCount, 1);
  const third = await ensure({ ...validBody, description: 'retry with another description' });
  assert.equal(third.status, 200);
  assert.equal(third.payload.taskId, first.payload.taskId);
  assert.equal(fakes.publishCount, 1);
});

test('replay observes ESS delivery and flips the task to delivered', async () => {
  const first = await ensure();
  assert.equal(first.payload.state, 'in_progress');

  fakes.destinations = [{ destinationID: 'node1', status: 'delivered' }];
  const replay = await ensure();
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.state, 'delivered');
  assert.equal(replay.payload.edgeReady, true);
  assert.equal(replay.payload.deliveryState, 'delivered');
  assert.ok(replay.payload.deliveredAt);

  // A delivered task stays active and keeps answering replays.
  const again = await ensure();
  assert.equal(again.status, 200);
  assert.equal(again.payload.taskId, first.payload.taskId);
});

test('ensure adopts an existing verified ESS object instead of returning the legacy 409', async () => {
  fakes.existingObjects = [{ objectType: validBody.objectType, objectID: validBody.objectID }];
  fakes.destinations = [{ destinationID: 'node1', status: 'consumed' }];
  const response = await ensure();
  assert.equal(response.status, 201, response.payload);
  assert.equal(response.payload.adopted, true);
  assert.equal(response.payload.state, 'delivered');
  assert.equal(response.payload.edgeReady, true);
  assert.equal(fakes.publishedArgs, null);
  assert.ok(fakes.audits.some((item) => item.path === 'mms.task.adopt'));
});

test('adoption refuses an existing object whose bytes do not match the Forge digest', async () => {
  fakes.existingObjects = [{ objectType: validBody.objectType, objectID: validBody.objectID }];
  fakes.storedObject = { sha256: 'b'.repeat(64), bytes: 1234 };
  const response = await ensure();
  assert.equal(response.status, 409);
  assert.equal(fakes.publishedArgs, null);
  assert.equal([...fakes.store.rows.values()].length, 0);
});

test('validation and configuration errors happen before any ESS mutation', async () => {
  const badEnvelope = await ensure({ ...validBody, destinations: [] });
  assert.equal(badEnvelope.status, 400);
  const badPrecision = await ensure({ ...validBody, precision: 'int4' });
  assert.equal(badPrecision.status, 400);
  const missingModel = await ensure({ ...validBody, modelName: '  ' });
  assert.equal(missingModel.status, 400);
  assert.equal(fakes.publishedArgs, null);

  fakes.exchangeConfig.configured = false;
  assert.equal((await ensure()).status, 503);
  fakes.exchangeConfig.configured = true;

  fakes.settings = {};
  assert.equal((await ensure()).status, 409);
  fakes.settings = {
    forge_base_url: 'https://forge.example',
    forge_username: 'nereidlink',
    forge_password: 'service-secret',
  };

  fakes.packages = [];
  assert.equal((await ensure()).status, 409);
  assert.equal(fakes.publishedArgs, null);
});

test('a publish failure is recorded as a failed task and releases the idempotency key', async () => {
  fakes.publishError = new Error('forge stream reset');
  const failed = await ensure();
  assert.equal(failed.status, 502);
  const failedRows = [...fakes.store.rows.values()].filter((row) => row.state === 'failed');
  assert.equal(failedRows.length, 1);
  assert.match(failedRows[0].failure_reason, /forge stream reset/);

  fakes.publishError = null;
  const retry = await ensure();
  assert.equal(retry.status, 201);
  assert.equal(retry.payload.state, 'in_progress');
});

test('a post-publish byte mismatch deletes the ESS object and fails the task', async () => {
  const first = await ensure();
  assert.equal(first.status, 201);
  fakes.storedObject = { sha256: 'c'.repeat(64), bytes: 9999 };
  const mismatch = await ensure({ ...validBody, objectID: 'yunet-fp16-b' });
  assert.equal(mismatch.status, 502);
  assert.equal(fakes.deleted.length, 1);
  const failedRows = [...fakes.store.rows.values()].filter((row) => row.state === 'failed');
  assert.equal(failedRows.length, 1);
});

test('task handle polling refreshes delivery state and 404s unknown or foreign tasks', async () => {
  const created = await ensure();
  const path = `${TASKS}/${created.payload.taskId}`;

  fakes.destinations = [{ destinationID: 'node1', status: 'pending' }];
  const pending = await call('GET', path);
  assert.equal(pending.status, 200);
  assert.equal(pending.payload.deliveryState, 'in_progress');
  assert.equal(pending.payload.edgeReady, false);

  fakes.destinations = [
    { destinationID: 'node1', status: 'delivered' },
    { destinationID: 'node2', status: 'consumed' },
  ];
  const ready = await call('GET', path);
  assert.equal(ready.status, 200);
  assert.equal(ready.payload.state, 'delivered');
  assert.equal(ready.payload.edgeReady, true);
  assert.equal(ready.payload.delivery.length, 2);

  const callsBefore = fakes.destinationCalls;
  await call('GET', path);
  assert.equal(fakes.destinationCalls, callsBefore, 'delivered rows must not contact ESS again');

  assert.equal((await call('GET', `${TASKS}/dt_does-not-exist`)).status, 404);
});

test('cancel deletes the in-flight object and is terminal', async () => {
  const created = await ensure();
  const cancelPath = `${TASKS}/${created.payload.taskId}/cancel`;

  const cancelled = await call('POST', cancelPath);
  assert.equal(cancelled.status, 200, cancelled.payload);
  assert.equal(cancelled.payload.state, 'cancelled');
  assert.equal(cancelled.payload.deliveryState, 'cancelled');
  assert.equal(fakes.deleted.length, 1);
  assert.ok(fakes.audits.some((item) => item.path === 'mms.task.cancel'));
  assert.ok(cancelled.payload.finishedAt);

  assert.equal((await call('POST', cancelPath)).status, 409);
  // Cancellation released the ensure key: a new task can be created.
  const recreated = await ensure();
  assert.equal(recreated.status, 201);
  assert.notEqual(recreated.payload.taskId, created.payload.taskId);
});

test('cancel is rejected when ESS already delivered every destination', async () => {
  const created = await ensure();
  fakes.destinations = [{ destinationID: 'node1', status: 'delivered' }];
  const response = await call('POST', `${TASKS}/${created.payload.taskId}/cancel`);
  assert.equal(response.status, 409);
  assert.match(response.payload.msg, /rollback/);
  assert.equal(fakes.deleted.length, 0);
  const row = await fakes.db.getDistributionTask('myorg', created.payload.taskId);
  assert.equal(row.state, 'delivered');
});

test('rollback undoes a delivered distribution and is terminal', async () => {
  const created = await ensure();
  fakes.destinations = [{ destinationID: 'node1', status: 'delivered' }];
  await call('GET', `${TASKS}/${created.payload.taskId}`); // flip to delivered

  const rollbackPath = `${TASKS}/${created.payload.taskId}/rollback`;
  const rolledBack = await call('POST', rollbackPath);
  assert.equal(rolledBack.status, 200, rolledBack.payload);
  assert.equal(rolledBack.payload.state, 'rolled_back');
  assert.equal(rolledBack.payload.edgeReady, false);
  assert.equal(fakes.deleted.length, 1);
  assert.ok(fakes.audits.some((item) => item.path === 'mms.task.rollback'));

  assert.equal((await call('POST', rollbackPath)).status, 409);
});

test('cancel and rollback guard their lifecycle states both ways', async () => {
  const created = await ensure();
  const id = created.payload.taskId;

  // Still in progress: rollback is the wrong verb.
  const earlyRollback = await call('POST', `${TASKS}/${id}/rollback`);
  assert.equal(earlyRollback.status, 409);
  assert.match(earlyRollback.payload.msg, /cancel/);

  await call('POST', `${TASKS}/${id}/cancel`);
  // Terminal rows cannot be rolled back either.
  const lateRollback = await call('POST', `${TASKS}/${id}/rollback`);
  assert.equal(lateRollback.status, 409);
  assert.equal((await call('POST', `${TASKS}/${id}/cancel`)).status, 409);
});

test('actions on unknown tasks return 404 and malformed task ids return 400', async () => {
  assert.equal((await call('POST', `${TASKS}/dt_missing/cancel`)).status, 404);
  assert.equal((await call('POST', `${TASKS}/dt_missing/rollback`)).status, 404);
  // "(" is outside the safe ESS token character set.
  assert.equal((await call('GET', `${TASKS}/dt_bad%28id`)).status, 400);
});
