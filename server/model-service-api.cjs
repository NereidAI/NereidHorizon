// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// Narrow service-to-service model distribution API. It owns only API-key
// authentication and the HTTP contract; forge.cjs remains the sole Forge/ESS
// transport owner and db.cjs remains the API-key/audit owner.

const express = require('express');
const { PACKAGE_PRECISIONS } = require('./forge.cjs');
const { createServiceKeyAuth, authorizeOrg } = require('./service-auth.cjs');
const {
  TERMINAL_DELIVERY_STATUSES,
  READY_DELIVERY_STATUSES,
} = require('./distribution-tasks.cjs');

/**
 * Create the authenticated model-service router.
 * @param {object} deps Runtime dependencies.
 * @param {import('./db.cjs')} deps.db PostgreSQL data layer.
 * @param {import('./forge.cjs')} deps.forge Forge/ESS transport owner.
 * @param {() => object} deps.getExchangeConfig Singleton Exchange config getter.
 * @param {() => Promise<Record<string,string>>} deps.loadSettings Settings loader.
 * @returns {import('express').Router} Express router mounted under /api/service/v1.
 */
function createModelServiceRouter({ db, forge, getExchangeConfig, loadSettings }) {
  const router = express.Router();
  const serviceKeyAuth = createServiceKeyAuth(db);

  router.post('/orgs/:org/model-publications', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    const body = req.body || {};
    try {
      forge.validatePublishEnvelope({
        org,
        objectType: body.objectType,
        objectID: body.objectID,
        destinations: body.destinations,
      });
    } catch (error) {
      return res.status(400).json({ msg: error.message });
    }
    if (typeof body.modelName !== 'string' || !body.modelName.trim()) {
      return res.status(400).json({ msg: 'modelName is required' });
    }
    if (typeof body.version !== 'string' || !body.version.trim()) {
      return res.status(400).json({ msg: 'version is required' });
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      return res.status(400).json({ msg: 'description must be a string' });
    }
    const precision = String(body.precision || '').toLowerCase();
    if (!PACKAGE_PRECISIONS.includes(precision)) {
      return res.status(400).json({ msg: `precision must be one of: ${PACKAGE_PRECISIONS.join(', ')}` });
    }

    const exchangeConfig = getExchangeConfig();
    if (!exchangeConfig.configured) return res.status(503).json({ msg: 'Exchange not configured' });
    const settings = await loadSettings();
    if (!forge.forgeConfigured(settings)) {
      return res.status(409).json({ msg: 'NereidForge integration is not configured' });
    }

    try {
      const packages = await forge.forgeListPackages(
        forge.forgeConfig(settings), body.modelName, body.version,
      );
      const pkg = packages.find((item) => String(item.precision || '').toLowerCase() === precision);
      if (!pkg) {
        return res.status(409).json({ msg: `no ready ${precision} package exists for this model version` });
      }
      const packageSHA256 = String(pkg.package_sha256 || '');
      const packageBytes = Number(pkg.package_bytes || 0);
      if (!/^[0-9a-f]{64}$/.test(packageSHA256) || !Number.isSafeInteger(packageBytes) || packageBytes <= 0) {
        return res.status(502).json({ msg: 'Forge package record is missing a valid package SHA-256 or byte count' });
      }

      const essBaseUrl = forge.essBaseUrl(settings, exchangeConfig.baseURL);
      const existingObjects = await forge.listObjects(
        essBaseUrl, exchangeConfig.auth, org,
      );
      const objectAlreadyExists = existingObjects.some((object) =>
        object.objectType === body.objectType && object.objectID === body.objectID);
      if (objectAlreadyExists) {
        return res.status(409).json({ msg: 'An ESS object with this type and id already exists' });
      }

      const result = await forge.publishModel({
        settings,
        exchangeBaseUrl: exchangeConfig.baseURL,
        auth: exchangeConfig.auth,
        org,
        modelName: body.modelName,
        version: body.version,
        precision,
        objectType: body.objectType,
        objectID: body.objectID,
        destinations: body.destinations,
        description: body.description,
      });
      let stored;
      try {
        stored = await forge.hashObjectData(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        );
      } catch (error) {
        return res.status(502).json({ msg: `ESS accepted the object but verification failed: ${error.message}` });
      }
      if (stored.sha256 !== packageSHA256 || stored.bytes !== packageBytes) {
        await forge.deleteObject(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        ).catch(() => {});
        return res.status(502).json({
          msg: 'ESS stored bytes do not match the Forge package SHA-256 or byte count',
          expected: { packageSHA256, packageBytes },
          received: stored,
        });
      }

      const publication = {
        objectType: result.objectType,
        objectID: result.objectID,
        source: 'forge',
        modelID: body.modelName,
        modelVersion: body.version,
        precision: result.precision,
        packageSHA256,
        bytes: packageBytes,
        destinationCount: result.destinationCount,
      };
      await db.insertAudit({
        actorType: 'service',
        actor: `service:${req.serviceAuth.label}`,
        org,
        method: 'EVENT',
        path: 'mms.publication',
        status: 200,
        detail: {
          service: {
            keyId: req.serviceAuth.keyId,
            label: req.serviceAuth.label,
            scopes: req.serviceAuth.scopes,
          },
          publication,
        },
      });

      return res.json({
        ...result,
        bytes: packageBytes,
        packageSHA256,
        modelName: body.modelName,
        version: body.version,
        storedObject: stored,
        byteIntegrity: 'match',
        acceptance: 'ess_received',
        edgeReady: false,
      });
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  router.get('/orgs/:org/objects/:type/:id/destinations', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    if (!forge.isSafeObjectToken(req.params.type) || !forge.isSafeObjectToken(req.params.id)) {
      return res.status(400).json({ msg: 'invalid object type or id' });
    }
    try {
      const settings = await loadSettings();
      const exchangeConfig = getExchangeConfig();
      if (!exchangeConfig.configured) return res.status(503).json({ msg: 'Exchange not configured' });
      const base = forge.essBaseUrl(settings, exchangeConfig.baseURL);
      const destinations = await forge.objectDestinations(
        base, exchangeConfig.auth, org, req.params.type, req.params.id,
      );
      const list = Array.isArray(destinations) ? destinations : [];
      const statuses = list.map((item) => String(item.status || '')).filter(Boolean);
      const allTerminal = statuses.length > 0 && statuses.every((status) => TERMINAL_DELIVERY_STATUSES.has(status));
      const edgeReady = statuses.length > 0 && statuses.every((status) => READY_DELIVERY_STATUSES.has(status));
      const deliveryState = !allTerminal ? 'in_progress' : (edgeReady ? 'delivered' : 'error');
      return res.json({
        org,
        objectType: req.params.type,
        objectID: req.params.id,
        deliveryState,
        edgeReady,
        destinations: list,
      });
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  return router;
}

module.exports = {
  createModelServiceRouter,
  TERMINAL_DELIVERY_STATUSES,
  READY_DELIVERY_STATUSES,
};
