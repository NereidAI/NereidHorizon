// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Tests for the scoped service-to-service model distribution router. Run with:
//   node --test server/model-service-api.test.cjs
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');
const realForge = require('./forge.cjs');
const { createModelServiceRouter } = require('./model-service-api.cjs');
const { PARTNER_READ_SCOPE, MODEL_DISTRIBUTE_SCOPE } = require('./api-key-scopes.cjs');

let server;
let baseURL;
let fakes;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/service/v1', createModelServiceRouter({
    db: {
      findApiKeyByPlain: (key) => fakes.db.findApiKeyByPlain(key),
      insertAudit: (record) => fakes.db.insertAudit(record),
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
  // Mirror index.cjs: unknown service paths get one shared JSON 404 after the
  // service routers.
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

function createFakes() {
  return {
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
    db: {
      findApiKeyByPlain: async () => fakes.key,
      insertAudit: async (record) => fakes.audits.push(record),
    },
    forge: {
      validatePublishEnvelope: realForge.validatePublishEnvelope,
      isSafeObjectToken: realForge.isSafeObjectToken,
      forgeConfig: realForge.forgeConfig,
      forgeConfigured: realForge.forgeConfigured,
      essBaseUrl: () => 'https://ess.example',
      listObjects: async () => fakes.existingObjects,
      forgeListPackages: async () => fakes.packages,
      publishModel: async (args) => {
        fakes.publishedArgs = args;
        return {
          objectType: args.objectType,
          objectID: args.objectID,
          bytes: 1234,
          destinationCount: args.destinations.length,
          precision: args.precision,
        };
      },
      hashObjectData: async () => fakes.storedObject,
      deleteObject: async () => fakes.deleted.push(true),
      objectDestinations: async () => fakes.destinations,
    },
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
    deleted: [],
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

test('service API rejects missing, invalid, revoked, expired and read-only keys', async () => {
  const path = '/api/service/v1/orgs/myorg/objects/face-detection/yunet-fp16/destinations';
  assert.equal((await call('GET', path, { key: null })).status, 401);

  fakes.db.findApiKeyByPlain = async () => null;
  assert.equal((await call('GET', path)).status, 401);

  fakes.db.findApiKeyByPlain = async () => fakes.key;
  fakes.key.revoked = true;
  assert.equal((await call('GET', path)).status, 403);

  fakes.key.revoked = false;
  fakes.key.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('GET', path)).status, 403);

  fakes.key.expires_at = null;
  fakes.key.scopes = [PARTNER_READ_SCOPE];
  const response = await call('GET', path);
  assert.equal(response.status, 403);
  assert.match(response.payload.msg, /model-distribution/);
});

test('service key is org-bound and cannot target root or another org', async () => {
  assert.equal((await call('GET', '/api/service/v1/orgs/root/objects/face-detection/yunet/destinations')).status, 400);
  assert.equal((await call('GET', '/api/service/v1/orgs/other/objects/face-detection/yunet/destinations')).status, 403);
});

test('unknown service API paths terminate inside the service router', async () => {
  const response = await call('GET', '/api/service/v1/unknown');
  assert.equal(response.status, 404);
  assert.equal(response.payload.msg, 'Service API path not found');
});

test('publishes a ready Forge package through the shared transport owner and verifies ESS bytes', async () => {
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', { body: validBody });
  assert.equal(response.status, 200, response.payload);
  assert.equal(response.payload.byteIntegrity, 'match');
  assert.equal(response.payload.acceptance, 'ess_received');
  assert.equal(response.payload.edgeReady, false);
  assert.equal(response.payload.packageSHA256, 'a'.repeat(64));
  assert.equal(fakes.publishedArgs.auth, fakes.exchangeConfig.auth);
  assert.equal(fakes.publishedArgs.objectID, validBody.objectID);
  assert.equal(fakes.deleted.length, 0);
  assert.equal(fakes.audits.length, 1);
  assert.equal(fakes.audits[0].actorType, 'service');
  assert.equal(fakes.audits[0].actor, 'service:nereidlink-prod');
  assert.equal(fakes.audits[0].detail.service.keyId, 'key-1');
  assert.equal(fakes.audits[0].detail.publication.packageSHA256, 'a'.repeat(64));
});

test('publishes an fp32 Forge package when Forge returns an FP32 ready record', async () => {
  fakes.packages = [{
    precision: 'FP32',
    status: 'ready',
    package_bytes: 1234,
    package_sha256: 'a'.repeat(64),
  }];
  const body = { ...validBody, precision: 'fp32', objectID: 'yunet-fp32' };
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', { body });
  assert.equal(response.status, 200, response.payload);
  assert.equal(fakes.publishedArgs.precision, 'fp32');
  assert.equal(fakes.publishedArgs.objectID, 'yunet-fp32');
  assert.equal(response.payload.precision, 'fp32');
  assert.equal(response.payload.byteIntegrity, 'match');
  assert.equal(response.payload.edgeReady, false);
});

test('rejects an invalid publication envelope before calling Forge or ESS', async () => {
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', {
    body: { ...validBody, destinations: [] },
  });
  assert.equal(response.status, 400);
  assert.equal(fakes.publishedArgs, null);
  assert.equal(fakes.audits.length, 0);
});

test('rejects missing model identity or invalid precision before Forge or ESS calls', async () => {
  const missingModel = await call('POST', '/api/service/v1/orgs/myorg/model-publications', {
    body: { ...validBody, modelName: '' },
  });
  assert.equal(missingModel.status, 400);
  assert.equal(fakes.publishedArgs, null);

  const invalidPrecision = await call('POST', '/api/service/v1/orgs/myorg/model-publications', {
    body: { ...validBody, precision: 'int4' },
  });
  assert.equal(invalidPrecision.status, 400);
  const invalidDescription = await call('POST', '/api/service/v1/orgs/myorg/model-publications', {
    body: { ...validBody, description: 123 },
  });
  assert.equal(invalidDescription.status, 400);
  assert.equal(fakes.publishedArgs, null);
  assert.equal(fakes.audits.length, 0);
});

test('refuses to overwrite an existing ESS object identity', async () => {
  fakes.existingObjects = [{ objectType: validBody.objectType, objectID: validBody.objectID }];
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', { body: validBody });
  assert.equal(response.status, 409);
  assert.equal(fakes.publishedArgs, null);
  assert.equal(fakes.deleted.length, 0);
});

test('returns 409 when the requested precision package is not ready', async () => {
  fakes.packages = [];
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', { body: validBody });
  assert.equal(response.status, 409);
  assert.equal(fakes.publishedArgs, null);
});

test('deletes the new ESS object when its stored bytes differ from the Forge digest', async () => {
  fakes.storedObject = { sha256: 'b'.repeat(64), bytes: 1234 };
  const response = await call('POST', '/api/service/v1/orgs/myorg/model-publications', { body: validBody });
  assert.equal(response.status, 502);
  assert.equal(fakes.deleted.length, 1);
  assert.equal(fakes.audits.length, 0);
});

test('reports delivery state without treating ESS acceptance as edge ready', async () => {
  const path = '/api/service/v1/orgs/myorg/objects/face-detection/yunet-fp16/destinations';
  fakes.destinations = [{ destinationID: 'node1', status: 'pending' }];
  let response = await call('GET', path);
  assert.equal(response.status, 200);
  assert.equal(response.payload.edgeReady, false);
  assert.equal(response.payload.deliveryState, 'in_progress');

  fakes.destinations = [{ destinationID: 'node1', status: 'delivered' }];
  response = await call('GET', path);
  assert.equal(response.payload.edgeReady, true);
  assert.equal(response.payload.deliveryState, 'delivered');

  fakes.destinations = [{ destinationID: 'node1', status: 'error', message: 'failed' }];
  response = await call('GET', path);
  assert.equal(response.payload.edgeReady, false);
  assert.equal(response.payload.deliveryState, 'error');

  fakes.destinations = [{ destinationID: 'node1', status: 'deleted' }];
  response = await call('GET', path);
  assert.equal(response.payload.edgeReady, false);
  assert.equal(response.payload.deliveryState, 'error');
});
