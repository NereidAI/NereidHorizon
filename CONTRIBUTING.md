# Contributing to NereidHorizon

Thank you for your interest in contributing! This document describes how to
get started and the conventions we follow.

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

Prerequisite: Node.js 24 or newer (see `engines` in `package.json`).

1. Fork and clone the repository.
2. Install dependencies: `npm ci` (use `npm install` only when updating
   `package-lock.json`).
3. Start the dev servers:
   - Backend BFF: `npm run dev:backend` (listens on `:3001`)
   - Frontend: `npm run dev` (Vite, proxies `/api` to `:3001`)
4. A PostgreSQL database is required; the Docker stack
   (`docker compose -f docker-compose.dev.yaml up -d`) provides one for local
   development.

## Development Workflow

- Create a feature branch off `main`: `git checkout -b feat/short-description`.
- Keep changes focused; one logical change per PR.
- Before pushing, run the full local gate:
  - `npm test` — backend unit tests (Node's built-in test runner)
  - `npm run typecheck` — TypeScript check (`tsc --noEmit`)
  - `npm run build` — production frontend build
- There is no ESLint or Prettier configuration in this repository; match the
  surrounding code style.

## Coding Conventions

- **Language**: TypeScript (frontend) and plain CommonJS (`.cjs`, backend).
- **Comments and documentation are written in English only.**
- **License header**: every hand-written source file begins with the SPDX
  header in the language's comment form:
  ```ts
  // Copyright (C) 2026 YIQISOFT
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Security**: never log secrets or full credentials, and never commit
  environment files, key files, or operator value files. Exchange passwords
  are encrypted server-side (AES-256-GCM), not stored in the browser.
- **i18n**: user-facing strings go through the `t()` translation helper with
  keys in both locale files; do not hardcode display text.
- **REST changes** update the OpenAPI documents in `docs/` in the same
  change.

## Developer Certificate of Origin

Every commit must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <you@example.com>
```

Create signed commits with `git commit -s`. A CI check rejects pull requests
that contain commits without a valid `Signed-off-by` trailer.

## Pull Requests

- Reference any related issue (e.g. `Closes #123`).
- Describe what changed and why.
- Ensure CI passes (typecheck, build, backend tests, image cache warm-up).
- Do not force-push to `main`; tags are protected and cut by maintainers only.

## Reporting Bugs

Open a GitHub issue using the bug template, including:

- Steps to reproduce
- Expected vs actual behavior
- Environment (Exchange version, browser, deployment mode)

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
