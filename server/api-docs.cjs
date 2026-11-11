// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0

// Serves OpenAPI contracts and an offline Swagger UI. Mount these routers
// before the console authentication guard: documentation is read-only, while
// every business API keeps its existing session and CSRF requirements.
const path = require('path');
const express = require('express');
const { getAbsoluteFSPath } = require('swagger-ui-dist');

const CONSOLE_SPEC_FILE = path.join(__dirname, '..', 'docs', 'openapi-console.yaml');
const PARTNER_SPEC_FILE = path.join(__dirname, '..', 'docs', 'openapi-partner.yaml');

/**
 * Build a self-contained, read-only documentation router for one spec file.
 * Absolute asset URLs let the same shell work at both the mount path and its
 * trailing-slash form.
 * @param {object} options
 * @param {string} options.specFile Absolute path of the OpenAPI YAML to serve.
 * @param {string} options.mountPath Public mount path, e.g. /api/docs.
 * @param {string} options.pageTitle Browser tab title.
 * @returns {import('express').Router}
 */
function createDocsRouter({ specFile, mountPath, pageTitle }) {
  const swaggerInitializerJs = `window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: "${mountPath}/openapi.yaml",
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout"
  });
};
`;
  const swaggerUiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="${mountPath}/favicon-32x32.png" type="image/png">
  <link rel="stylesheet" href="${mountPath}/swagger-ui.css">
  <title>${pageTitle}</title>
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${mountPath}/swagger-ui-bundle.js" charset="utf-8"></script>
  <script src="${mountPath}/swagger-initializer.js" charset="utf-8"></script>
</body>
</html>`;

  const router = express.Router();

  // Absolute asset URLs make the same shell work at both /mount and /mount/.
  router.get('/', (_req, res) => {
    res.type('html').send(swaggerUiHtml);
  });

  router.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml; charset=utf-8').sendFile(specFile);
  });

  // Keep initialization in a same-origin script so the UI works with the
  // production Content-Security-Policy, which deliberately forbids inline JS.
  // This route also overrides the petstore initializer shipped by the package.
  router.get('/swagger-initializer.js', (_req, res) => {
    res.type('application/javascript; charset=utf-8').send(swaggerInitializerJs);
  });

  // swagger-ui-dist ships with the backend, so documentation works without a CDN.
  // Disable directory indexes and redirects; misses terminate below instead of
  // falling through to the SPA or the authenticated business API handlers.
  router.use(express.static(getAbsoluteFSPath(), {
    dotfiles: 'deny',
    fallthrough: true,
    index: false,
    redirect: false,
  }));

  router.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return res.status(405).end();
    }
    return res.status(404).type('text/plain').send('Not found\n');
  });

  return router;
}

// Default export stays the console documentation router so existing
// `require('./api-docs.cjs')` call sites keep mounting a Router directly.
const consoleDocsRouter = createDocsRouter({
  specFile: CONSOLE_SPEC_FILE,
  mountPath: '/api/docs',
  pageTitle: 'NereidHorizon API Docs',
});

const partnerDocsRouter = createDocsRouter({
  specFile: PARTNER_SPEC_FILE,
  mountPath: '/api/docs-partner',
  pageTitle: 'NereidHorizon Partner API Docs',
});

module.exports = consoleDocsRouter;
module.exports.createDocsRouter = createDocsRouter;
module.exports.consoleDocsRouter = consoleDocsRouter;
module.exports.partnerDocsRouter = partnerDocsRouter;
module.exports.CONSOLE_SPEC_FILE = CONSOLE_SPEC_FILE;
module.exports.PARTNER_SPEC_FILE = PARTNER_SPEC_FILE;
