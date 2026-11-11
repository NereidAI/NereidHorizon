// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// API client for the NereidForge Model Registry browser and the ESS/MMS model
// distribution workflow. All calls terminate at the BFF (/api), which holds
// the Forge service-account token and the session's Exchange credentials;
// the browser never sees either secret.

import { get, post, del } from './client';
import { clearSession, getConfig } from './config';

// ---- NereidForge shapes (only the fields the UI consumes) ----

export interface ForgeModel {
  id?: string;
  name: string;
  description?: string;
  framework?: string;
  task_type?: string;
  created_at?: string | null;
  updated_at?: string | null;
  versions?: ForgeVersion[];
}

export interface ForgeVersion {
  version: string;
  description?: string;
  file_path?: string;
  size_bytes?: number;
  status?: string;
  metadata?: Record<string, any>;
  created_at?: string | null;
}

// Precisions the Forge optimization pipeline packages automatically. One IR
// per precision serves CPU/iGPU/dGPU/NPU at runtime; there is no per-device
// package and no build-trigger API. Order is full precision, half precision,
// quantized.
export type PackagePrecision = 'fp32' | 'fp16' | 'int8';

// One ready precision package (GET .../packages shape). Forge returns ready
// packages only, with quality-gate and per-device verification data.
export interface ForgePackageRecord {
  precision: PackagePrecision | string;
  status: 'ready' | string;
  package_uri?: string;
  package_bytes?: number;
  package_sha256?: string;
  detection_count?: number;
  devices?: Array<Record<string, any>>;
  quality_gate_passed?: boolean;
  map50_baseline?: number;
  map50_candidate?: number;
}

// One entry of version.metadata.packages[]; may carry non-ready states.
export interface ForgePackageMetaRecord {
  precision?: PackagePrecision | string;
  target?: string; // legacy records (older NF builds) were keyed by target
  status?: string;
  package_bytes?: number;
  error?: string;
  updated_at?: string;
}

export interface PageEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// ---- ESS/MMS shapes ----

export interface MmsDestination {
  destinationOrgID?: string;
  destinationType: string;
  destinationID: string;
  communication?: string;
  codeVersion?: string;
}

export interface MmsObject {
  objectID: string;
  objectType: string;
  description?: string;
  version?: string;
  noData?: boolean;
  inactive?: boolean;
  public?: boolean;
  destinationType?: string;
  destinationID?: string;
  destinationsList?: string[];
  objectSize?: number;
  activationTime?: string;
  expiration?: string;
  // Latest successful NH publication audit for this object identity. ESS
  // itself does not expose a creation or publication timestamp.
  publishedAt?: string;
  publishedBy?: string;
  publicationSource?: 'forge' | 'custom-upload' | 'url' | string;
  operationID?: string;
  packageSHA256?: string;
}

export interface MmsDestStatus {
  destinationType: string;
  destinationID: string;
  status: 'pending' | 'delivering' | 'delivered' | 'consumed' | 'deleted' | 'error' | string;
  message?: string;
}

export interface ForgeIntegrationStatus {
  forge: { configured: boolean; baseUrl: string; authenticated: boolean; error: string };
  ess: { baseUrl: string; reachable: boolean; error: string };
}

// CustomPackageFields is the operator-confirmed ESS envelope shared by local
// and URL sources; package bytes never supply these values implicitly.
export interface CustomPackageFields {
  objectType: string;
  objectID: string;
  destinations: string[];
  description?: string;
}

// CustomPackageResult carries integrity and non-sensitive provenance used for
// operation correlation; URL paths and signed queries are deliberately absent.
export interface CustomPackageResult {
  operationID: string;
  objectType: string;
  objectID: string;
  bytes: number;
  destinationCount: number;
  packageSHA256: string;
  expandedBytes: number;
  fileCount: number;
  modelID: string;
  modelVersion: string;
  originalFilename: string;
  source: 'custom-upload' | 'url';
  sourceOrigin?: string;
}

// UploadProgressOptions exposes browser upload progress and cancellation only
// for the local transfer; server-side validation/ESS publication is not abortable.
export interface UploadProgressOptions {
  onProgress?: (percent: number) => void;
  onUploadSent?: () => void;
  signal?: AbortSignal;
}

export const ForgeRegistryAPI = {
  status() {
    return get<ForgeIntegrationStatus>('/forge/status');
  },

  testConnection(body: { base_url: string; username: string; password: string; namespace?: string; tenant?: string }) {
    return post<{ ok: boolean }>('/forge/test', body);
  },

  listModels(page = 1, pageSize = 50, search = '') {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (search) params.set('search', search);
    return get<PageEnvelope<ForgeModel>>(`/forge/models?${params}`);
  },

  listVersions(modelName: string) {
    return get<PageEnvelope<ForgeVersion>>(
      `/forge/models/${encodeURIComponent(modelName)}/versions`,
    );
  },

  // Ready precision packages of a version. Forge builds these automatically
  // at the end of an optimization job — there is no trigger endpoint.
  listPackages(modelName: string, version: string) {
    return get<{ packages: ForgePackageRecord[] }>(
      `/forge/models/${encodeURIComponent(modelName)}/versions/${encodeURIComponent(version)}/packages`,
    );
  },

  listDestinations(org: string) {
    return get<MmsDestination[]>(`/mms/destinations?org=${encodeURIComponent(org)}`);
  },

  listObjects(org: string) {
    return get<MmsObject[]>(`/mms/objects?org=${encodeURIComponent(org)}`);
  },

  objectDestinations(org: string, type: string, id: string) {
    const params = new URLSearchParams({ org });
    return get<MmsDestStatus[]>(
      `/mms/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/destinations?${params}`,
    );
  },

  deleteObject(org: string, type: string, id: string) {
    return del<{ ok: boolean }>(
      `/mms/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}?org=${encodeURIComponent(org)}`,
    );
  },

  publish(org: string, body: {
    modelName: string;
    version: string;
    precision: PackagePrecision;
    objectType: string;
    objectID: string;
    destinations: string[];
    description?: string;
  }) {
    return post<{ objectType: string; objectID: string; bytes: number; destinationCount: number; precision: string }>(
      `/mms/publish?org=${encodeURIComponent(org)}`,
      body,
    );
  },

  publishCustomUrl(org: string, url: string, body: CustomPackageFields) {
    return post<CustomPackageResult>(`/mms/from-url?org=${encodeURIComponent(org)}`, { url, ...body });
  },

  // XMLHttpRequest is intentional: fetch does not expose browser upload
  // progress. The BFF still owns validation and the subsequent ESS transfer.
  uploadCustomPackage(
    org: string,
    file: File,
    fields: CustomPackageFields,
    options: UploadProgressOptions = {},
  ) {
    return new Promise<CustomPackageResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('objectType', fields.objectType);
      form.append('objectID', fields.objectID);
      form.append('destinations', JSON.stringify(fields.destinations));
      form.append('description', fields.description || '');
      form.append('package', file, file.name);
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const abort = () => xhr.abort();
      options.signal?.addEventListener('abort', abort, { once: true });

      xhr.open('POST', `/api/mms/upload?org=${encodeURIComponent(org)}`);
      xhr.setRequestHeader('Accept', 'application/json');
      const csrfToken = getConfig().csrfToken;
      if (csrfToken) xhr.setRequestHeader('X-Csrf-Token', csrfToken);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.upload.onload = () => options.onUploadSent?.();
      xhr.onerror = () => {
        cleanup();
        reject(new Error('Cannot connect to server, please check if backend is running'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('Upload cancelled', 'AbortError'));
      };
      xhr.onload = () => {
        cleanup();
        let data: any = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = { msg: xhr.responseText }; }
        if (xhr.status === 401) {
          clearSession();
          window.location.href = '/login';
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data?.msg || data?.message || `Request failed (${xhr.status})`));
          return;
        }
        resolve(data as CustomPackageResult);
      };
      xhr.send(form);
    });
  },
};
