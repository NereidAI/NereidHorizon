// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// Versioned, idempotent model-distribution contract
// (nh-model-distribution/v1): ensure semantics keyed on the ESS object
// identity, pollable task handles, cancellation and rollback. forge.cjs stays
// the sole Forge/ESS transport owner and db.cjs owns the task rows; this
// module only implements task lifecycle policy and the HTTP contract.
//
// The legacy one-shot model-publications router remains available for callers
// that publish bytes without keeping a task handle. Both routers share the
// same service-key authentication and the same ESS delivery vocabulary.

const crypto = require('crypto');
const express = require('express');
const { PACKAGE_PRECISIONS } = require('./forge.cjs');
const { createServiceKeyAuth, authorizeOrg } = require('./service-auth.cjs');

// ESS per-destination delivery vocabulary. Terminal means ESS will not change
// the status again; ready means the edge node has received (or already
// consumed) the object.
const TERMINAL_DELIVERY_STATUSES = Object.freeze(new Set(['delivered', 'consumed', 'error', 'deleted']));
const READY_DELIVERY_STATUSES = Object.freeze(new Set(['delivered', 'consumed']));

// Task lifecycle states. in_progress/delivered are "active" and hold the
// ensure idempotency key; failed/cancelled/rolled_back are terminal and
// release it.
const TASK_IN_PROGRESS = 'in_progress';
const TASK_DELIVERED = 'delivered';
const TASK_FAILED = 'failed';
const TASK_CANCELLED = 'cancelled';
const TASK_ROLLED_BACK = 'rolled_back';
const ACTIVE_TASK_STATES = Object.freeze([TASK_IN_PROGRESS, TASK_DELIVERED]);

/**
 * Derive aggregate delivery state from raw ESS destination records.
 * @param {Array<object>} destinations ESS destination records.
 * @returns {{deliveryState:string, edgeReady:boolean, records:Array<object>}}
 */
function deriveDelivery(destinations) {
  const records = Array.isArray(destinations) ? destinations : [];
  const statuses = records.map((item) => String(item.status || '')).filter(Boolean);
  const allTerminal = statuses.length > 0 && statuses.every((status) => TERMINAL_DELIVERY_STATUSES.has(status));
  const edgeReady = statuses.length > 0 && statuses.every((status) => READY_DELIVERY_STATUSES.has(status));
  const deliveryState = !allTerminal ? TASK_IN_PROGRESS : (edgeReady ? TASK_DELIVERED : 'error');
  return { deliveryState, edgeReady, records };
}

// Delivery fields for rows whose state is authoritative and no longer needs
// an ESS round trip.
function staticDelivery(state) {
  switch (state) {
    case TASK_DELIVERED:
      return { deliveryState: TASK_DELIVERED, edgeReady: true };
    case TASK_FAILED:
      return { deliveryState: 'error', edgeReady: false };
    case TASK_CANCELLED:
      return { deliveryState: TASK_CANCELLED, edgeReady: false };
    case TASK_ROLLED_BACK:
      return { deliveryState: TASK_ROLLED_BACK, edgeReady: false };
    default:
      return null;
  }
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

// Map a snake_case row to the camelCase API task shape.
function taskToJSON(row, extra = {}) {
  return {
    taskId: row.id,
    org: row.org,
    objectType: row.object_type,
    objectID: row.object_id,
    modelName: row.model_name,
    version: row.model_version,
    precision: row.precision,
    destinations: row.destinations,
    state: row.state,
    failureReason: row.failure_reason || null,
    packageSHA256: row.package_sha256 || null,
    packageBytes: row.package_bytes == null ? null : Number(row.package_bytes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deliveredAt: iso(row.delivered_at),
    finishedAt: iso(row.finished_at),
    ...extra,
  };
}

function newTaskId() {
  return `dt_${crypto.randomUUID()}`;
}

/**
 * Create the distribution-task router.
 * @param {object} deps Runtime dependencies.
 * @param {import('./db.cjs')} deps.db PostgreSQL data layer.
 * @param {import('./forge.cjs')} deps.forge Forge/ESS transport owner.
 * @param {() => object} deps.getExchangeConfig Singleton Exchange config getter.
 * @param {() => Promise<Record<string,string>>} deps.loadSettings Settings loader.
 * @returns {import('express').Router} Express router mounted under /api/service/v1.
 */
function createDistributionTaskRouter({ db, forge, getExchangeConfig, loadSettings }) {
  const router = express.Router();
  const serviceKeyAuth = createServiceKeyAuth(db);

  // Refresh an active task from live ESS destination state, persisting the
  // in_progress -> delivered transition on the first all-ready observation.
  // Terminal rows are returned without contacting ESS (the object may already
  // be deleted).
  async function refreshTask(task, settings, exchangeConfig) {
    const frozen = staticDelivery(task.state);
    if (frozen) {
      return { task, deliveryState: frozen.deliveryState, edgeReady: frozen.edgeReady, delivery: [] };
    }
    const base = forge.essBaseUrl(settings, exchangeConfig.baseURL);
    const records = await forge.objectDestinations(
      base, exchangeConfig.auth, task.org, task.object_type, task.object_id,
    );
    const derived = deriveDelivery(records);
    let row = task;
    if (derived.edgeReady) {
      row = (await db.markDistributionTaskDelivered(task.org, task.id)) || task;
    }
    return { task: row, deliveryState: derived.deliveryState, edgeReady: derived.edgeReady, delivery: derived.records };
  }

  // Persist a failed attempt without masking the upstream error that triggered
  // it. Failed rows are terminal and release the ensure idempotency key.
  async function recordFailure(fields, reason) {
    try {
      await db.insertDistributionTask({
        ...fields,
        state: TASK_FAILED,
        failureReason: reason,
      });
    } catch {
      // Task bookkeeping must never replace the original upstream response.
    }
  }

  router.post('/orgs/:org/distribution-tasks', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    const body = req.body || {};

    // Local validation first: no Forge/ESS call is made for a bad envelope.
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

    const taskFields = {
      org,
      objectType: body.objectType,
      objectID: body.objectID,
      modelName: body.modelName,
      modelVersion: body.version,
      precision,
      destinations: body.destinations,
      description: body.description,
      createdByKey: req.serviceAuth.keyId,
    };

    try {
      // 1. Idempotent ensure: an active task for this ESS identity is the
      //    answer, no matter how many times the caller retries.
      const active = await db.findActiveDistributionTask(org, body.objectType, body.objectID);
      if (active) {
        const refreshed = await refreshTask(active, settings, exchangeConfig);
        return res.status(200).json(taskToJSON(refreshed.task, {
          idempotentReplay: true,
          deliveryState: refreshed.deliveryState,
          edgeReady: refreshed.edgeReady,
          delivery: refreshed.delivery,
        }));
      }

      // 2. Resolve the hardware-aware Forge package. Precision
      //    (fp32/fp16/int8) is the closed generic selector; one IR serves
      //    every edge device.
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
      const provenance = { ...taskFields, packageSHA256, packageBytes };
      const essBaseUrl = forge.essBaseUrl(settings, exchangeConfig.baseURL);

      // 3. Adopt an ESS object that already exists (legacy publication, manual
      //    preload) when its bytes match the Forge digest, instead of failing
      //    with the legacy duplicate-409.
      const existingObjects = await forge.listObjects(essBaseUrl, exchangeConfig.auth, org);
      const objectAlreadyExists = existingObjects.some((object) =>
        object.objectType === body.objectType && object.objectID === body.objectID);
      if (objectAlreadyExists) {
        let stored;
        try {
          stored = await forge.hashObjectData(
            essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
          );
        } catch (error) {
          return res.status(502).json({ msg: `ESS object exists but verification failed: ${error.message}` });
        }
        if (stored.sha256 !== packageSHA256 || stored.bytes !== packageBytes) {
          return res.status(409).json({
            msg: 'An ESS object with this type and id already exists with different bytes; cancel or roll it back before ensure',
            expected: { packageSHA256, packageBytes },
            received: stored,
          });
        }
        const existingDestinations = await forge.objectDestinations(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        ).catch(() => []);
        const derived = deriveDelivery(existingDestinations);
        const adopted = await db.insertDistributionTask({
          ...provenance,
          id: newTaskId(),
          state: derived.edgeReady ? TASK_DELIVERED : TASK_IN_PROGRESS,
          deliveredAt: derived.edgeReady ? new Date().toISOString() : null,
        });
        await db.insertAudit({
          actorType: 'service',
          actor: `service:${req.serviceAuth.label}`,
          org,
          method: 'EVENT',
          path: 'mms.task.adopt',
          status: 200,
          detail: {
            service: { keyId: req.serviceAuth.keyId, label: req.serviceAuth.label, scopes: req.serviceAuth.scopes },
            taskId: adopted.id,
            publication: {
              objectType: body.objectType, objectID: body.objectID, source: 'ess-adopt',
              modelID: body.modelName, modelVersion: body.version, precision,
              packageSHA256, bytes: packageBytes,
            },
          },
        });
        return res.status(201).json(taskToJSON(adopted, {
          adopted: true,
          deliveryState: derived.deliveryState,
          edgeReady: derived.edgeReady,
          delivery: derived.records,
        }));
      }

      // 4. Publish fresh through the shared transport owner, then verify the
      //    stored bytes exactly as the legacy router does.
      let result;
      try {
        result = await forge.publishModel({
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
      } catch (error) {
        await recordFailure({ ...provenance, id: newTaskId() }, error.message);
        return res.status(502).json({ msg: error.message });
      }

      let stored;
      try {
        stored = await forge.hashObjectData(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        );
      } catch (error) {
        await forge.deleteObject(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        ).catch(() => {});
        await recordFailure(
          { ...provenance, id: newTaskId() },
          `ESS accepted the object but verification failed: ${error.message}`,
        );
        return res.status(502).json({ msg: `ESS accepted the object but verification failed: ${error.message}` });
      }
      if (stored.sha256 !== packageSHA256 || stored.bytes !== packageBytes) {
        await forge.deleteObject(
          essBaseUrl, exchangeConfig.auth, org, body.objectType, body.objectID,
        ).catch(() => {});
        await recordFailure({ ...provenance, id: newTaskId() }, 'ESS stored bytes do not match the Forge package SHA-256 or byte count');
        return res.status(502).json({
          msg: 'ESS stored bytes do not match the Forge package SHA-256 or byte count',
          expected: { packageSHA256, packageBytes },
          received: stored,
        });
      }

      const task = await db.insertDistributionTask({
        ...provenance,
        id: newTaskId(),
        state: TASK_IN_PROGRESS,
      });
      await db.insertAudit({
        actorType: 'service',
        actor: `service:${req.serviceAuth.label}`,
        org,
        method: 'EVENT',
        path: 'mms.publication',
        status: 200,
        detail: {
          service: { keyId: req.serviceAuth.keyId, label: req.serviceAuth.label, scopes: req.serviceAuth.scopes },
          taskId: task.id,
          publication: {
            objectType: result.objectType,
            objectID: result.objectID,
            source: 'forge',
            modelID: body.modelName,
            modelVersion: body.version,
            precision: result.precision,
            packageSHA256,
            bytes: packageBytes,
            destinationCount: result.destinationCount,
          },
        },
      });

      const refreshed = await refreshTask(task, settings, exchangeConfig).catch(() => null);
      return res.status(201).json(taskToJSON(task, {
        deliveryState: refreshed ? refreshed.deliveryState : TASK_IN_PROGRESS,
        edgeReady: refreshed ? refreshed.edgeReady : false,
        delivery: refreshed ? refreshed.delivery : [],
      }));
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  router.get('/orgs/:org/distribution-tasks/:taskId', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    if (!forge.isSafeObjectToken(req.params.taskId)) {
      return res.status(400).json({ msg: 'invalid task id' });
    }
    try {
      const task = await db.getDistributionTask(org, req.params.taskId);
      if (!task) return res.status(404).json({ msg: 'Distribution task not found' });
      const settings = await loadSettings();
      const exchangeConfig = getExchangeConfig();
      if (!exchangeConfig.configured) return res.status(503).json({ msg: 'Exchange not configured' });
      const refreshed = await refreshTask(task, settings, exchangeConfig);
      return res.json(taskToJSON(refreshed.task, {
        deliveryState: refreshed.deliveryState,
        edgeReady: refreshed.edgeReady,
        delivery: refreshed.delivery,
      }));
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  // Remove an in-flight object from ESS before every edge consumed it.
  router.post('/orgs/:org/distribution-tasks/:taskId/cancel', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    if (!forge.isSafeObjectToken(req.params.taskId)) {
      return res.status(400).json({ msg: 'invalid task id' });
    }
    try {
      const task = await db.getDistributionTask(org, req.params.taskId);
      if (!task) return res.status(404).json({ msg: 'Distribution task not found' });
      if (task.state === TASK_DELIVERED) {
        return res.status(409).json({ msg: 'Task is already delivered; use rollback instead' });
      }
      if (task.state !== TASK_IN_PROGRESS) {
        return res.status(409).json({ msg: `Cannot cancel a task in state ${task.state}` });
      }

      const settings = await loadSettings();
      const exchangeConfig = getExchangeConfig();
      if (!exchangeConfig.configured) return res.status(503).json({ msg: 'Exchange not configured' });
      const essBaseUrl = forge.essBaseUrl(settings, exchangeConfig.baseURL);

      // Reality check: ESS may have finished delivery since the last poll.
      // Cancelling a fully delivered object would hide that edges already hold
      // the bytes, so the caller must switch to the rollback verb.
      const derived = deriveDelivery(await forge.objectDestinations(
        essBaseUrl, exchangeConfig.auth, org, task.object_type, task.object_id,
      ));
      if (derived.edgeReady) {
        await db.markDistributionTaskDelivered(org, task.id);
        return res.status(409).json({ msg: 'All destinations already delivered; use rollback instead' });
      }

      await forge.deleteObject(
        essBaseUrl, exchangeConfig.auth, org, task.object_type, task.object_id,
      );
      const updated = await db.transitionDistributionTask(
        org, task.id, [TASK_IN_PROGRESS], TASK_CANCELLED, new Date().toISOString(),
      );
      if (!updated) return res.status(409).json({ msg: 'Task state changed concurrently; retry the action' });

      await db.insertAudit({
        actorType: 'service',
        actor: `service:${req.serviceAuth.label}`,
        org,
        method: 'EVENT',
        path: 'mms.task.cancel',
        status: 200,
        detail: {
          service: { keyId: req.serviceAuth.keyId, label: req.serviceAuth.label, scopes: req.serviceAuth.scopes },
          taskId: task.id,
          objectType: task.object_type,
          objectID: task.object_id,
        },
      });
      return res.json(taskToJSON(updated, { deliveryState: TASK_CANCELLED, edgeReady: false, delivery: [] }));
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  // Undo a completed distribution: delete the object from ESS so edges drop it.
  router.post('/orgs/:org/distribution-tasks/:taskId/rollback', serviceKeyAuth, async (req, res) => {
    const org = authorizeOrg(req, res);
    if (!org) return;
    if (!forge.isSafeObjectToken(req.params.taskId)) {
      return res.status(400).json({ msg: 'invalid task id' });
    }
    try {
      const task = await db.getDistributionTask(org, req.params.taskId);
      if (!task) return res.status(404).json({ msg: 'Distribution task not found' });
      if (task.state === TASK_IN_PROGRESS) {
        return res.status(409).json({ msg: 'Task is still in progress; use cancel instead' });
      }
      if (task.state !== TASK_DELIVERED) {
        return res.status(409).json({ msg: `Cannot roll back a task in state ${task.state}` });
      }

      const settings = await loadSettings();
      const exchangeConfig = getExchangeConfig();
      if (!exchangeConfig.configured) return res.status(503).json({ msg: 'Exchange not configured' });
      const essBaseUrl = forge.essBaseUrl(settings, exchangeConfig.baseURL);

      // deleteObject treats an already-gone object (404) as success, so
      // rollback stays idempotent against out-of-band deletions.
      await forge.deleteObject(
        essBaseUrl, exchangeConfig.auth, org, task.object_type, task.object_id,
      );
      const updated = await db.transitionDistributionTask(
        org, task.id, [TASK_DELIVERED], TASK_ROLLED_BACK, new Date().toISOString(),
      );
      if (!updated) return res.status(409).json({ msg: 'Task state changed concurrently; retry the action' });

      await db.insertAudit({
        actorType: 'service',
        actor: `service:${req.serviceAuth.label}`,
        org,
        method: 'EVENT',
        path: 'mms.task.rollback',
        status: 200,
        detail: {
          service: { keyId: req.serviceAuth.keyId, label: req.serviceAuth.label, scopes: req.serviceAuth.scopes },
          taskId: task.id,
          objectType: task.object_type,
          objectID: task.object_id,
        },
      });
      return res.json(taskToJSON(updated, { deliveryState: TASK_ROLLED_BACK, edgeReady: false, delivery: [] }));
    } catch (error) {
      return res.status(502).json({ msg: error.message });
    }
  });

  return router;
}

module.exports = {
  createDistributionTaskRouter,
  deriveDelivery,
  staticDelivery,
  TERMINAL_DELIVERY_STATUSES,
  READY_DELIVERY_STATUSES,
  ACTIVE_TASK_STATES,
};
