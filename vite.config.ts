// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0


import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'spa',
  plugins: [react()],
  server: {
    port: 8080,
    host: '0.0.0.0',
    proxy: {
      '^/api/': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
