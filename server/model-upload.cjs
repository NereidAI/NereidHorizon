// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Operator-supplied Nereid model package ingestion. Multipart data is spooled
// to a private, random temporary directory, validated without extraction, and
// then handed to the single ESS transport owner as the original byte stream.
// The validator mirrors NereidInference's nereid-model/1 and artifact.files
// contract: NH never chooses payloads, repairs descriptors or rebuilds tars.

const Busboy = require('busboy');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const tar = require('tar-stream');
const zlib = require('zlib');
const forge = require('./forge.cjs');

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 ** 3,
  maxExpandedBytes: 16 * 1024 ** 3,
  maxFileBytes: 16 * 1024 ** 3,
  maxEntries: 100_000,
  maxDescriptorBytes: 1024 ** 2,
  urlTimeoutMs: 3600 * 1000,
  tempDir: os.tmpdir(),
});
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const LABEL_INDEXED_DECODERS = new Set([
  'detection.anchors', 'detection.rows', 'classification.probs',
  'classification.multilabel', 'segmentation.semantic', 'segmentation.instance',
  'keypoints',
]);
const UPLOAD_FIELDS = new Set(['objectType', 'objectID', 'destinations', 'description']);

// UploadRequestError marks operator input failures separately from local I/O
// and upstream ESS failures so the BFF can return an accurate HTTP status.
class UploadRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'UploadRequestError';
    this.statusCode = statusCode;
  }
}

function positiveLimit(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

// uploadLimits reads limits at request time so isolated tests and runtime
// configuration use the same path. Values are bytes except maxEntries.
function uploadLimits(options = {}) {
  const env = options.env || process.env;
  return {
    maxBytes: positiveLimit(options.maxBytes ?? env.MMS_UPLOAD_MAX_BYTES, DEFAULT_LIMITS.maxBytes, 'MMS_UPLOAD_MAX_BYTES'),
    maxExpandedBytes: positiveLimit(options.maxExpandedBytes ?? env.MMS_UPLOAD_MAX_EXPANDED_BYTES, DEFAULT_LIMITS.maxExpandedBytes, 'MMS_UPLOAD_MAX_EXPANDED_BYTES'),
    maxFileBytes: positiveLimit(options.maxFileBytes ?? env.MMS_UPLOAD_MAX_FILE_BYTES, DEFAULT_LIMITS.maxFileBytes, 'MMS_UPLOAD_MAX_FILE_BYTES'),
    maxEntries: positiveLimit(options.maxEntries ?? env.MMS_UPLOAD_MAX_ENTRIES, DEFAULT_LIMITS.maxEntries, 'MMS_UPLOAD_MAX_ENTRIES'),
    maxDescriptorBytes: positiveLimit(options.maxDescriptorBytes, DEFAULT_LIMITS.maxDescriptorBytes, 'maxDescriptorBytes'),
    urlTimeoutMs: positiveLimit(
      options.urlTimeoutMs ?? (env.MMS_MODEL_URL_TIMEOUT_SECONDS ? Number(env.MMS_MODEL_URL_TIMEOUT_SECONDS) * 1000 : undefined),
      DEFAULT_LIMITS.urlTimeoutMs,
      'MMS_MODEL_URL_TIMEOUT_SECONDS',
    ),
    tempDir: path.resolve(options.tempDir || env.MMS_UPLOAD_TEMP_DIR || DEFAULT_LIMITS.tempDir),
  };
}

// Canonicalize both tar headers and descriptor paths using POSIX rules. Any
// traversal segment is rejected rather than cleaned away, including spellings
// that would happen to remain inside the package after normalization.
function safePackagePath(raw, allowRoot = false) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) {
    throw new UploadRequestError(`unsafe package path: ${String(raw)}`);
  }
  const parts = raw.split('/');
  if (parts.includes('..') || /^[A-Za-z]:$/.test(parts[0])) {
    throw new UploadRequestError(`unsafe package path: ${raw}`);
  }
  const clean = parts.filter((part) => part && part !== '.').join('/');
  if (!clean && !allowRoot) throw new UploadRequestError(`empty package path: ${raw}`);
  return clean;
}

// Create one private spool directory per transaction. A random 0700 directory
// plus an exclusive 0600 file prevents other local users from reading or
// replacing model bytes between validation and ESS publication.
async function createSpool(limits) {
  await fs.promises.mkdir(limits.tempDir, { recursive: true, mode: 0o700 });
  const tempDir = await fs.promises.mkdtemp(path.join(limits.tempDir, 'nereid-mms-'));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  };
  try {
    await fs.promises.chmod(tempDir, 0o700);
    return { filePath: path.join(tempDir, 'package.tar.gz'), cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

// receivePackageUpload receives one multipart package without buffering it in
// memory. Busboy limits are defense in depth; spooled size is checked on disk.
async function receivePackageUpload(req, options = {}) {
  const limits = uploadLimits(options);
  const { filePath, cleanup } = await createSpool(limits);

  try {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > limits.maxBytes + 1024 ** 2) {
      throw new UploadRequestError(`package exceeds the ${limits.maxBytes}-byte upload limit`, 413);
    }

    const fields = Object.create(null);
    let filename = '';
    let fileStarted = false;
    let writeStarted = false;
    let inputError = null;
    let resolveParser;
    let rejectParser;
    let resolveFile;
    let rejectFile;
    const parserDone = new Promise((resolve, reject) => { resolveParser = resolve; rejectParser = reject; });
    const fileDone = new Promise((resolve, reject) => { resolveFile = resolve; rejectFile = reject; });
    const bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: limits.maxBytes,
        // One slot above the valid counts lets us identify the actual extra
        // part; Busboy's *Limit events fire on reaching, not exceeding, a cap.
        files: 2,
        fields: UPLOAD_FIELDS.size + 1,
        parts: UPLOAD_FIELDS.size + 2,
        fieldSize: 64 * 1024,
        fieldNameSize: 100,
      },
    });

    bb.on('field', (name, value, info) => {
      if (!UPLOAD_FIELDS.has(name) || Object.hasOwn(fields, name) || info.nameTruncated || info.valueTruncated) {
        inputError ||= new UploadRequestError(`invalid or duplicate multipart field: ${name}`);
        return;
      }
      fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      fileStarted = true;
      if (name !== 'package' || writeStarted) {
        inputError ||= new UploadRequestError('exactly one file field named package is required');
        stream.resume();
        return;
      }
      writeStarted = true;
      filename = info.filename || '';
      stream.on('limit', () => {
        inputError ||= new UploadRequestError(`package exceeds the ${limits.maxBytes}-byte upload limit`, 413);
      });
      const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
      pipeline(stream, output).then(resolveFile, rejectFile);
    });
    bb.on('error', rejectParser);
    bb.on('close', () => {
      if (!writeStarted) rejectFile(inputError || new UploadRequestError('multipart file field package is required'));
      resolveParser();
    });
    const abort = () => {
      const error = new UploadRequestError('upload was interrupted', 400);
      inputError ||= error;
      rejectParser(error);
      rejectFile(error);
    };
    req.once('aborted', abort);
    req.once('error', abort);

    const completed = Promise.all([parserDone, fileDone]);
    req.pipe(bb);
    await completed;
    req.removeListener('aborted', abort);
    req.removeListener('error', abort);
    if (inputError) throw inputError;
    if (!fileStarted || !writeStarted) throw new UploadRequestError('multipart file field package is required');
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= 0) throw new UploadRequestError('uploaded package is empty');
    if (stat.size > limits.maxBytes) {
      throw new UploadRequestError(`package exceeds the ${limits.maxBytes}-byte upload limit`, 413);
    }
    return { filePath, fields, filename, bytes: stat.size, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

// Parse the explicit server-side URL allowlist. Origins, not URL prefixes, are
// compared so an allowed host cannot be impersonated with userinfo or a look-
// alike hostname. Signed query strings remain part of the fetch but are never
// returned or written to the audit log.
function allowedUrlOrigins(options) {
  const configured = options.allowedUrlOrigins ?? (options.env || process.env).MMS_MODEL_URL_ALLOWED_ORIGINS ?? '';
  const values = Array.isArray(configured) ? configured : String(configured).split(/[\s,]+/);
  const origins = new Set();
  for (const value of values.filter(Boolean)) {
    try {
      const parsed = new URL(String(value));
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      origins.add(parsed.origin);
    } catch {
      throw new Error(`invalid MMS_MODEL_URL_ALLOWED_ORIGINS entry: ${value}`);
    }
  }
  if (origins.size === 0) {
    throw new UploadRequestError('URL model distribution has no allowed origins configured', 503);
  }
  return origins;
}

function checkedSourceUrl(value, origins) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UploadRequestError('a valid absolute HTTP(S) model URL is required');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new UploadRequestError('model URL must use HTTP(S) without embedded credentials');
  }
  if (!origins.has(parsed.origin)) throw new UploadRequestError(`model URL origin is not allowed: ${parsed.origin}`);
  return parsed;
}

// downloadPackageFromUrl downloads an allowlisted HTTP(S) source with manual,
// revalidated redirects. Its byte-counting transform feeds the same private
// spool as multipart uploads; no whole-package buffer is created.
async function downloadPackageFromUrl(sourceUrl, options = {}) {
  const limits = uploadLimits(options);
  const origins = allowedUrlOrigins(options);
  let current = checkedSourceUrl(sourceUrl, origins);
  const spool = await createSpool(limits);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.urlTimeoutMs);
  timeout.unref();
  try {
    let response;
    for (let redirects = 0; ; redirects += 1) {
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/gzip, application/octet-stream;q=0.9, */*;q=0.1' },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new UploadRequestError('model URL download timed out', 504);
        throw new UploadRequestError(`model URL download failed: ${error.message}`, 502);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= 5) {
        await response.body?.cancel().catch(() => {});
        throw new UploadRequestError('model URL exceeded the redirect limit', 502);
      }
      const location = response.headers.get('location');
      if (!location) {
        await response.body?.cancel().catch(() => {});
        throw new UploadRequestError('model URL redirect has no Location header', 502);
      }
      let redirected;
      try {
        redirected = new URL(location, current);
      } catch {
        await response.body?.cancel().catch(() => {});
        throw new UploadRequestError('model URL returned an invalid redirect', 502);
      }
      const next = checkedSourceUrl(redirected.href, origins);
      await response.body?.cancel().catch(() => {});
      current = next;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new UploadRequestError(`model URL returned HTTP ${response.status}`, 502);
    }
    const declaredBytes = Number(response.headers.get('content-length') || 0);
    if (declaredBytes > limits.maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new UploadRequestError(`package exceeds the ${limits.maxBytes}-byte upload limit`, 413);
    }

    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limits.maxBytes) {
          callback(new UploadRequestError(`package exceeds the ${limits.maxBytes}-byte upload limit`, 413));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        fs.createWriteStream(spool.filePath, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      if (error instanceof UploadRequestError) throw error;
      if (controller.signal.aborted) throw new UploadRequestError('model URL download timed out', 504);
      throw new UploadRequestError(`model URL stream failed: ${error.message}`, 502);
    }
    if (bytes <= 0) throw new UploadRequestError('downloaded package is empty');
    return {
      ...spool,
      bytes,
      sourceOrigin: current.origin,
    };
  } catch (error) {
    await spool.cleanup().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function manifestError(message) {
  throw new UploadRequestError(`invalid nereid-model.json: ${message}`);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) manifestError(`${name} must be an object`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) manifestError(`${name} is required`);
  return value;
}

function requireSafeName(value, name) {
  requireString(value, name);
  if (!SAFE_NAME.test(value)) manifestError(`${name} is unsafe`);
}

function validateManifest(manifest) {
  requireObject(manifest, 'descriptor');
  if (manifest.schema !== 'nereid-model/1') manifestError('schema must be nereid-model/1');
  const model = requireObject(manifest.model, 'model');
  const artifact = requireObject(manifest.artifact, 'artifact');
  const runtime = requireObject(manifest.runtime, 'runtime');
  requireSafeName(model.id, 'model.id');
  requireSafeName(model.version, 'model.version');
  requireString(model.task, 'model.task');
  if (model.revision !== undefined && model.revision !== '') requireSafeName(model.revision, 'model.revision');
  requireString(runtime.backend, 'runtime.backend');
  requireSafeName(runtime.model_name, 'runtime.model_name');
  if (!['kserve', 'openai'].includes(runtime.backend)) manifestError('unsupported runtime.backend');

  if (runtime.backend === 'kserve') {
    requireString(artifact.format, 'artifact.format');
    const precision = artifact.precision ?? '';
    if (typeof precision !== 'string' || !['', 'FP32', 'FP16', 'INT8'].includes(precision)) manifestError('unsupported artifact.precision');
    const server = requireObject(runtime.server, 'runtime.server');
    requireString(server.family, 'runtime.server.family');
    const io = requireObject(manifest.io, 'io');
    if (!Array.isArray(io.inputs) || io.inputs.length === 0) manifestError('io.inputs must contain one vision input');
    const input = requireObject(io.inputs[0], 'io.inputs[0]');
    if (!input.name || input.dtype !== 'FP32' || input.layout !== 'NCHW') manifestError('vision input must be named FP32 NCHW');
    if (!Array.isArray(input.shape) || input.shape.length !== 4 || input.shape[0] !== 1 || input.shape[1] !== 3 ||
        !Number.isInteger(input.shape[2]) || !Number.isInteger(input.shape[3]) ||
        input.shape[2] <= 0 || input.shape[3] <= 0 || input.shape[2] > 4096 || input.shape[3] > 4096) {
      manifestError('vision input shape must be [1,3,H,W] with H/W in 1..4096');
    }
    if (input.color_order && !['RGB', 'BGR'].includes(input.color_order)) manifestError('unsupported color_order');
    if (input.preprocess !== undefined) {
      const pp = requireObject(input.preprocess, 'preprocess');
      if (pp.resize && !['stretch', 'letterbox', 'crop'].includes(pp.resize)) manifestError('unsupported preprocess.resize');
      for (const key of ['mean', 'std']) {
        if (pp[key] !== undefined && (!Array.isArray(pp[key]) || ![0, 1, 3].includes(pp[key].length) ||
            pp[key].some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
          manifestError(`preprocess.${key} must have 0, 1, or 3 numeric values`);
        }
      }
      if (pp.pad_value !== undefined && (typeof pp.pad_value !== 'number' || pp.pad_value < 0 || pp.pad_value > 255)) {
        manifestError('preprocess.pad_value must be in 0..255');
      }
    }
    const outputs = io.outputs === undefined ? [] : io.outputs;
    if (!Array.isArray(outputs)) manifestError('io.outputs must be an array');
    for (const output of outputs) {
      requireObject(output, 'io.outputs entry');
      requireString(output.name, 'io.outputs name');
      if (!Array.isArray(output.shape) || output.shape.some((dim) => !Number.isSafeInteger(dim) || dim === 0 || dim < -1)) {
        manifestError(`output ${output.name} has an invalid shape`);
      }
    }
    if (manifest.decoder !== undefined) validateDecoder(manifest, model, outputs);
    if (server.family === 'ovms' && runtime.repository_path !== undefined && runtime.repository_path !== '') {
      safePackagePath(runtime.repository_path);
    }
  }
  if (model.labels_file !== undefined && model.labels_file !== '') safePackagePath(model.labels_file);
  return { model, artifact, runtime };
}

function validateDecoder(manifest, model, outputs) {
  const decoder = requireObject(manifest.decoder, 'decoder');
  const kind = requireString(decoder.kind, 'decoder.kind');
  if (LABEL_INDEXED_DECODERS.has(kind) && !model.labels_file) manifestError(`decoder ${kind} requires model.labels_file`);
  const hasOutput = (name) => outputs.some((out) => out.name === name || out.role === name);
  for (const key of ['output', 'predictions', 'mask_protos']) {
    if (decoder[key] && !hasOutput(decoder[key])) manifestError(`decoder references undeclared output ${decoder[key]}`);
  }
  if (kind === 'detection.anchors') {
    const output = outputs.find((out) => !decoder.output || out.name === decoder.output || out.role === decoder.output);
    if (!output || output.shape.length !== 3 || output.shape[0] !== 1 || output.shape[1] < 5 || output.shape[2] <= 0) {
      manifestError('detection.anchors output must have static shape [1,4+nc,A] with A>0');
    }
  }
}

// validateModelPackage validates a spool sequentially. Only the bounded
// descriptor is held in memory; payload streams are hashed without extraction.
async function validateModelPackage(filePath, options = {}) {
  const limits = uploadLimits(options);
  const packageHash = crypto.createHash('sha256');
  const source = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  const extract = tar.extract();
  // streamx may emit a second, late error after an entry rejects the archive;
  // keep a listener attached for the extractor's whole lifetime. pipeline()
  // still observes and rejects on the original validation error.
  extract.on('error', () => {});
  const files = new Map();
  const seenPaths = new Set();
  const filePaths = new Set();
  const parentPaths = new Set();
  let descriptorChunks = [];
  let descriptorBytes = 0;
  let expandedBytes = 0;
  let entryCount = 0;
  source.on('data', (chunk) => packageHash.update(chunk));

  extract.on('entry', (header, stream, next) => {
    // Attach before validating the header: rejecting an entry also destroys its
    // stream, and streamx reports that destruction asynchronously.
    stream.on('error', (error) => {
      if (!extract.destroyed) extract.destroy(error);
    });
    const fail = (message) => {
      stream.resume();
      extract.destroy(message instanceof Error ? message : new UploadRequestError(message));
    };
    let clean;
    try {
      entryCount += 1;
      if (entryCount > limits.maxEntries) throw new UploadRequestError(`archive exceeds ${limits.maxEntries} entries`);
      clean = safePackagePath(header.name, header.type === 'directory');
      if (seenPaths.has(clean)) throw new UploadRequestError(`duplicate archive entry: ${clean || '.'}`);
      const segments = clean.split('/').filter(Boolean);
      for (let i = 1; i < segments.length; i += 1) {
        const parent = segments.slice(0, i).join('/');
        if (filePaths.has(parent)) {
          throw new UploadRequestError(`archive entry has a regular-file ancestor: ${clean}`);
        }
        parentPaths.add(parent);
      }
      if (header.type === 'file' && parentPaths.has(clean)) {
        throw new UploadRequestError(`archive regular file conflicts with a child entry: ${clean}`);
      }
      seenPaths.add(clean);
      if (header.type === 'file') filePaths.add(clean);
      if (header.type === 'directory') {
        stream.resume();
        stream.on('end', next);
        return;
      }
      if (header.type !== 'file') throw new UploadRequestError(`archive entry must be a regular file or directory: ${clean}`);
      if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > limits.maxFileBytes) {
        throw new UploadRequestError(`archive entry exceeds the per-file limit: ${clean}`);
      }
      expandedBytes += header.size;
      if (expandedBytes > limits.maxExpandedBytes) throw new UploadRequestError(`archive exceeds ${limits.maxExpandedBytes} expanded bytes`);
    } catch (error) {
      fail(error);
      return;
    }

    const hash = crypto.createHash('sha256');
    let actualBytes = 0;
    const chunks = clean === 'nereid-model.json' ? [] : null;
    stream.on('data', (chunk) => {
      actualBytes += chunk.length;
      hash.update(chunk);
      if (chunks) {
        descriptorBytes += chunk.length;
        if (descriptorBytes > limits.maxDescriptorBytes) {
          fail(`nereid-model.json exceeds ${limits.maxDescriptorBytes} bytes`);
          return;
        }
        chunks.push(chunk);
      }
    });
    stream.on('end', () => {
      if (extract.destroyed) return;
      if (actualBytes !== header.size) {
        fail(`archive entry size mismatch: ${clean}`);
        return;
      }
      if (chunks) descriptorChunks = chunks;
      files.set(clean, { bytes: actualBytes, sha256: hash.digest('hex') });
      next();
    });
    stream.resume();
  });

  try {
    await pipeline(source, gunzip, extract);
  } catch (error) {
    if (error instanceof UploadRequestError) throw error;
    throw new UploadRequestError(`invalid gzip tar package: ${error.message}`);
  }
  const descriptor = files.get('nereid-model.json');
  if (!descriptor || descriptorChunks.length === 0) throw new UploadRequestError('root nereid-model.json is required');
  let manifest;
  try {
    manifest = JSON.parse(Buffer.concat(descriptorChunks).toString('utf8'));
  } catch (error) {
    throw new UploadRequestError(`invalid nereid-model.json: ${error.message}`);
  }
  const { model, artifact } = validateManifest(manifest);
  if (!Array.isArray(artifact.files) || artifact.files.length === 0) manifestError('artifact.files must declare at least one payload');
  const declared = new Set();
  for (const entry of artifact.files) {
    requireObject(entry, 'artifact.files entry');
    const clean = safePackagePath(entry.path);
    if (clean === 'nereid-model.json') manifestError('root descriptor must not be listed in artifact.files');
    if (declared.has(clean)) manifestError(`payload ${clean} is listed more than once`);
    declared.add(clean);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > limits.maxFileBytes) {
      manifestError(`payload ${clean} must declare a positive exact byte count within the per-file limit`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      manifestError(`payload ${clean} must declare a lowercase SHA-256 digest`);
    }
    const actual = files.get(clean);
    if (!actual) manifestError(`declared payload is missing: ${clean}`);
    if (actual.bytes !== entry.bytes) manifestError(`payload ${clean} size mismatch: ${actual.bytes} != ${entry.bytes}`);
    if (actual.sha256 !== entry.sha256) manifestError(`payload ${clean} SHA-256 mismatch`);
  }
  for (const name of files.keys()) {
    if (name !== 'nereid-model.json' && !declared.has(name)) manifestError(`package file ${name} is not listed in artifact.files`);
  }
  if (model.labels_file && !declared.has(safePackagePath(model.labels_file))) {
    manifestError('model.labels_file must be listed in artifact.files');
  }

  const stat = await fs.promises.stat(filePath);
  return {
    bytes: stat.size,
    packageSHA256: packageHash.digest('hex'),
    expandedBytes,
    fileCount: files.size,
    modelID: model.id,
    modelVersion: model.version,
  };
}

// Parse and validate the operator-controlled ESS envelope independently of the
// package. Model identity/version come only from the validated descriptor.
function publicationEnvelope(fields, org) {
  let destinations;
  try {
    destinations = Array.isArray(fields.destinations)
      ? fields.destinations
      : JSON.parse(fields.destinations || '');
  } catch {
    throw new UploadRequestError('destinations must be a JSON array');
  }
  const envelope = {
    org,
    objectType: fields.objectType,
    objectID: fields.objectID,
    destinations,
    description: typeof fields.description === 'string' ? fields.description.trim() : '',
  };
  try {
    forge.validatePublishEnvelope(envelope);
  } catch (error) {
    throw new UploadRequestError(error.message);
  }
  return envelope;
}

// Publish a received spool through the common validation and ESS transaction.
// Source-specific metadata is limited to non-sensitive values; in particular a
// signed URL's path and query never enter the response or audit event.
async function publishSpooledPackage(spool, fields, args, source) {
  const { settings, exchangeBaseUrl, auth, org, limits } = args;
  try {
    const envelope = publicationEnvelope(fields, org);
    args.onEvent?.('received', {
      objectType: envelope.objectType,
      objectID: envelope.objectID,
      destinationCount: envelope.destinations.length,
      bytes: spool.bytes,
      originalFilename: spool.sourceOrigin ? '' : spool.filename,
      sourceOrigin: spool.sourceOrigin || null,
    });
    let validation;
    try {
      validation = await validateModelPackage(spool.filePath, limits);
    } catch (error) {
      if (!error.statusCode) error.statusCode = 500;
      throw error;
    }
    args.onEvent?.('validated', {
      modelID: validation.modelID,
      modelVersion: validation.modelVersion,
      packageSHA256: validation.packageSHA256,
      expandedBytes: validation.expandedBytes,
      fileCount: validation.fileCount,
    });
    let published;
    try {
      published = await forge.publishPackageStream({
        settings,
        exchangeBaseUrl,
        auth,
        ...envelope,
        version: validation.modelVersion,
        body: fs.createReadStream(spool.filePath),
        bytes: validation.bytes,
        contentType: 'application/gzip',
      });
    } catch (error) {
      const upstream = new Error(error.message, { cause: error });
      upstream.statusCode = 502;
      throw upstream;
    }
    args.onEvent?.('ess_published', {
      objectType: published.objectType,
      objectID: published.objectID,
      bytes: published.bytes,
      destinationCount: published.destinationCount,
    });
    return {
      ...published,
      ...validation,
      operationID: args.operationID,
      originalFilename: spool.sourceOrigin ? '' : spool.filename,
      source,
      ...(spool.sourceOrigin ? { sourceOrigin: spool.sourceOrigin } : {}),
    };
  } finally {
    try {
      await spool.cleanup();
      args.onEvent?.('spool_cleaned', {});
    } catch (error) {
      args.onEvent?.('spool_cleanup_failed', { error: error.message });
      throw error;
    }
  }
}

// publishCustomUpload owns the complete multipart transaction, including
// guaranteed temporary cleanup and operator-input error mapping.
async function publishCustomUpload(args) {
  const { req, limits } = args;
  let upload;
  try {
    upload = await receivePackageUpload(req, limits);
  } catch (error) {
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
  return publishSpooledPackage(upload, upload.fields, args, 'custom-upload');
}

// publishCustomUrl downloads, validates and publishes a URL package through
// the same spool transaction as a local upload, with no new package semantics.
async function publishCustomUrl(args) {
  const { sourceUrl, fields, limits } = args;
  let download;
  try {
    download = await downloadPackageFromUrl(sourceUrl, limits);
  } catch (error) {
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
  return publishSpooledPackage(download, fields, args, 'url');
}

module.exports = {
  UploadRequestError,
  uploadLimits,
  receivePackageUpload,
  downloadPackageFromUrl,
  validateModelPackage,
  publishCustomUpload,
  publishCustomUrl,
};
