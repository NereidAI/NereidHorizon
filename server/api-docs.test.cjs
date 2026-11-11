// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Tests for the public, offline API documentation router. Run with:
//   node --test server/api-docs.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const express = require('express');
const apiDocs = require('./api-docs.cjs');
const { partnerDocsRouter, PARTNER_SPEC_FILE } = apiDocs;

let server;
let baseURL;

before(async () => {
  const app = express();
  app.use('/api/docs', apiDocs);
  app.use('/api/docs-partner', partnerDocsRouter);
  // Prove the documentation mounts do not inherit the business API guard.
  app.use('/api', (_req, res) => res.status(401).json({ msg: 'Not logged in' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
});

test('both documentation roots serve the self-contained Swagger shell', async () => {
  for (const route of ['/api/docs', '/api/docs/']) {
    const response = await fetch(baseURL + route);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(body, /NereidHorizon API Docs/);
    assert.match(body, /\/api\/docs\/swagger-ui-bundle\.js/);
    assert.match(body, /\/api\/docs\/swagger-initializer\.js/);
    assert.match(body, /\/api\/docs\/swagger-ui\.css/);
    assert.doesNotMatch(body, /window\.onload/);
    assert.doesNotMatch(body, /https?:\/\//);

    const head = await fetch(baseURL + route, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type'), /^text\/html/);
    assert.equal(await head.text(), '');
  }
});

test('the specification matches the source contract and supports HEAD', async () => {
  const response = await fetch(baseURL + '/api/docs/openapi.yaml');
  const body = await response.text();
  const source = await fs.readFile(path.join(__dirname, '..', 'docs', 'openapi-console.yaml'), 'utf8');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /yaml/);
  assert.equal(body, source);
  assert.match(body, /openapi: 3\.0\.3/);
  assert.match(body, /servers:\n  - url: \//);

  const head = await fetch(baseURL + '/api/docs/openapi.yaml', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /yaml/);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(source));
  assert.equal(await head.text(), '');
});

test('Swagger UI assets are local and support HEAD', async () => {
  for (const [asset, minimumBytes] of [
    ['swagger-ui.css', 1000],
    ['swagger-ui-bundle.js', 1000],
    ['swagger-initializer.js', 100],
    ['favicon-32x32.png', 1],
  ]) {
    const response = await fetch(`${baseURL}/api/docs/${asset}`);
    const body = await response.arrayBuffer();
    assert.equal(response.status, 200, asset);
    assert.ok(body.byteLength >= minimumBytes, asset);
  }
  const initializer = await fetch(baseURL + '/api/docs/swagger-initializer.js');
  assert.match(initializer.headers.get('content-type'), /javascript/);
  const initializerBody = await initializer.text();
  assert.match(initializerBody, /window\.onload/);
  assert.match(initializerBody, /\/api\/docs\/openapi\.yaml/);

  const head = await fetch(baseURL + '/api/docs/swagger-ui.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/css/);
  assert.equal(await head.text(), '');
});

test('unknown assets return 404 rather than the SPA', async () => {
  const response = await fetch(baseURL + '/api/docs/does-not-exist.js');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.equal(await response.text(), 'Not found\n');
});

test('documentation rejects mutations without invoking CSRF or authentication', async () => {
  for (const route of ['/api/docs', '/api/docs/openapi.yaml', '/api/docs/swagger-ui.css']) {
    const response = await fetch(baseURL + route, { method: 'POST' });
    assert.equal(response.status, 405, route);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  const business = await fetch(baseURL + '/api/mms/objects');
  assert.equal(business.status, 401);
});

test('the partner documentation mount serves its own offline Swagger shell', async () => {
  for (const route of ['/api/docs-partner', '/api/docs-partner/']) {
    const response = await fetch(baseURL + route);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(body, /NereidHorizon Partner API Docs/);
    assert.match(body, /\/api\/docs-partner\/swagger-ui-bundle\.js/);
    assert.match(body, /\/api\/docs-partner\/swagger-initializer\.js/);
    assert.match(body, /\/api\/docs-partner\/swagger-ui\.css/);
    assert.doesNotMatch(body, /https?:\/\//);

    const head = await fetch(baseURL + route, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }

  const initializer = await fetch(baseURL + '/api/docs-partner/swagger-initializer.js');
  const initializerBody = await initializer.text();
  assert.match(initializerBody, /\/api\/docs-partner\/openapi\.yaml/);
  assert.doesNotMatch(initializerBody, /\/api\/docs\/openapi\.yaml/);
});

test('the partner specification matches its source contract and stays public', async () => {
  const response = await fetch(baseURL + '/api/docs-partner/openapi.yaml');
  const body = await response.text();
  const source = await fs.readFile(PARTNER_SPEC_FILE, 'utf8');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /yaml/);
  assert.equal(body, source);
  assert.match(body, /title: NereidHorizon Partner API/);
  assert.match(body, /partner:read/);

  const head = await fetch(baseURL + '/api/docs-partner/openapi.yaml', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(source));
  assert.equal(await head.text(), '');

  // The mount terminates on its own 404 instead of the business guard's 401.
  const missing = await fetch(baseURL + '/api/docs-partner/does-not-exist.js');
  assert.equal(missing.status, 404);
  const mutation = await fetch(baseURL + '/api/docs-partner/openapi.yaml', { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
});
