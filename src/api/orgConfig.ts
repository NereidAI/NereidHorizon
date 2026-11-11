// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0


import { put } from './client';

export const OrgConfigAPI = {
  update(orgId: string, data: { description?: string; label?: string; heartbeatIntervals?: any; limits?: any }) {
    return put(`/organizations/${encodeURIComponent(orgId)}/config`, data);
  },
};
