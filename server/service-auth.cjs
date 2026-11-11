// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// Shared authentication for the narrow service-to-service API mounted under
// /api/service/v1. Every service router authenticates with an org-bound API
// key carrying the model:distribute scope; console sessions and CSRF never
// apply to these routes.

const { MODEL_DISTRIBUTE_SCOPE } = require('./api-key-scopes.cjs');

/**
 * Build the scoped API-key authentication middleware.
 * @param {import('./db.cjs')} db PostgreSQL data layer providing findApiKeyByPlain.
 * @returns {import('express').RequestHandler} Express middleware.
 */
function createServiceKeyAuth(db) {
  return async function serviceKeyAuth(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ msg: 'Missing X-Api-Key header' });
    const rec = await db.findApiKeyByPlain(key);
    if (!rec) return res.status(401).json({ msg: 'Invalid API Key' });
    if (rec.revoked) return res.status(403).json({ msg: 'API Key revoked' });
    if (rec.expires_at && new Date(rec.expires_at) < new Date()) {
      return res.status(403).json({ msg: 'API Key expired' });
    }
    const scopes = Array.isArray(rec.scopes) ? rec.scopes : [];
    if (!scopes.includes(MODEL_DISTRIBUTE_SCOPE)) {
      return res.status(403).json({ msg: 'API Key lacks model-distribution scope' });
    }
    req.serviceAuth = { keyId: rec.id, org: rec.org, label: rec.label, scopes };
    next();
  };
}

/**
 * Validate the org path parameter against the key binding.
 * @returns {string|null} The authorized org, or null after sending an error.
 */
function authorizeOrg(req, res) {
  const org = String(req.params.org || '');
  if (!org || org === 'root') {
    res.status(400).json({ msg: 'a non-root organization is required' });
    return null;
  }
  if (org !== req.serviceAuth.org) {
    res.status(403).json({ msg: 'Access denied' });
    return null;
  }
  return org;
}

module.exports = {
  createServiceKeyAuth,
  authorizeOrg,
};
