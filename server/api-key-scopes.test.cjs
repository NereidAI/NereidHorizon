// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Tests for the explicit API-key scope contract. Run with:
//   node --test server/api-key-scopes.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PARTNER_READ_SCOPE,
  MODEL_DISTRIBUTE_SCOPE,
  normalizeApiKeyScopes,
} = require('./api-key-scopes.cjs');

test('missing scopes preserve the historical partner-read default', () => {
  assert.deepEqual(normalizeApiKeyScopes(), [PARTNER_READ_SCOPE]);
  assert.deepEqual(normalizeApiKeyScopes(null), [PARTNER_READ_SCOPE]);
  assert.deepEqual(normalizeApiKeyScopes(''), [PARTNER_READ_SCOPE]);
  assert.deepEqual(normalizeApiKeyScopes([]), [PARTNER_READ_SCOPE]);
});

test('scopes are validated, trimmed, de-duplicated and sorted', () => {
  assert.deepEqual(
    normalizeApiKeyScopes([` ${MODEL_DISTRIBUTE_SCOPE} `, PARTNER_READ_SCOPE, MODEL_DISTRIBUTE_SCOPE]),
    [MODEL_DISTRIBUTE_SCOPE, PARTNER_READ_SCOPE],
  );
});

test('unknown scopes cannot be introduced through the API', () => {
  assert.throws(() => normalizeApiKeyScopes(['admin:all']), /invalid API key scope/);
});
