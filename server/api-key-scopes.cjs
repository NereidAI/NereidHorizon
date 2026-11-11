// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// API key capability contract. A key is bound to one org and carries one or
// more explicit scopes so partner read access cannot be widened implicitly by
// adding another service-to-service route.

const PARTNER_READ_SCOPE = 'partner:read';
const MODEL_DISTRIBUTE_SCOPE = 'model:distribute';
const API_KEY_SCOPES = Object.freeze([PARTNER_READ_SCOPE, MODEL_DISTRIBUTE_SCOPE]);

/**
 * Normalize and validate caller-provided API key scopes.
 * @param {string[]|string|undefined|null} value Raw scope value.
 * @returns {string[]} A de-duplicated, sorted allowlist of scopes.
 */
function normalizeApiKeyScopes(value) {
  if (value === undefined || value === null || value === '') return [PARTNER_READ_SCOPE];
  const rawScopes = Array.isArray(value) ? value : [value];
  const scopes = [...new Set(rawScopes.map((scope) => String(scope).trim()).filter(Boolean))].sort();
  if (scopes.length === 0) return [PARTNER_READ_SCOPE];
  for (const scope of scopes) {
    if (!API_KEY_SCOPES.includes(scope)) throw new Error(`invalid API key scope: ${scope}`);
  }
  return scopes;
}

module.exports = {
  PARTNER_READ_SCOPE,
  MODEL_DISTRIBUTE_SCOPE,
  API_KEY_SCOPES,
  normalizeApiKeyScopes,
};
