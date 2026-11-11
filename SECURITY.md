<!--
  Copyright (C) 2026 YIQISOFT
  SPDX-License-Identifier: Apache-2.0
-->


# Security Policy

## Supported Versions

The project is pre-1.0; versioning follows the tag-sourced model (the rolling
development channel is `0.0.0-dev`).

| Version line | Supported          |
| ------------ | ------------------ |
| 0.0.x        | :white_check_mark: |
| < 0.0.x      | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in NereidHorizon, **please do not open
a public GitHub issue**. Report it privately so we can triage and release a fix
before public disclosure.

- **Email**: jiekechoo@gmail.com
- **Encryption**: PGP is preferred; request the public key by email if needed.
- **Response time**: We aim to acknowledge reports within 72 hours.

Please include:
- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept is helpful).
- Affected version(s) (image tag or git revision) and deployment context
  (e.g. reverse proxy, air-gapped site).

## Security Model (for Reviewers / Auditors)

NereidHorizon is a BFF (Backend-For-Frontend) proxy for the Open Horizon
Exchange API. Key security properties:

- **Credential confidentiality** — Exchange `Basic` credentials are encrypted
  with AES-256-GCM using a server-side master key before being written to
  PostgreSQL; PostgreSQL never stores plaintext credentials. The master key is
  supplied via `SESSION_ENC_KEY` (64 hex chars) or persisted to a key file whose
  location is configurable via `NEREIDHORIZON_SESSION_KEY_FILE`, created with
  `0600` permissions and never committed. A legacy root `.session.key` is
  reused when the configured file is absent, preventing session-key rotation
  during migration.
- **Browser attack surface** — The session identifier is an opaque random
  token in an `HttpOnly; Secure; SameSite=Lax` cookie. It is unreadable by
  JavaScript (XSS-resistant) and every mutation is gated by a CSRF
  double-submit token.
- **Transport security** — All browser traffic is served over HTTPS
  (TLS 1.2/1.3). HTTP is redirected to HTTPS and HSTS is enabled.
- **Session lifetime** — Idle (`SESSION_TTL`) and absolute
  (`SESSION_ABS_TTL`) timeouts, enforced by an in-memory sweeper and
  expired-row cleanup in PostgreSQL. Logout immediately invalidates the
  session and clears the cookie.
- **Service-to-service API** — Programmatic clients authenticate with an
  org-bound API key carrying explicit scopes, outside the console session and
  CSRF machinery; unknown service paths return a JSON 404 and unscoped calls
  are rejected.
- **SSO** — Optional OpenID Connect (authorization code + PKCE) and
  NereidSphere ticket SSO. Logins are fail-closed on missing or ambiguous
  group claims, unknown orgs, unverified email, or disabled accounts.
  Federated identities are keyed by `(issuer, subject)` and are never merged
  by username or email. The BFF stores no IdP refresh/access tokens; an ID
  token is retained only inside the encrypted session to support
  RP-initiated logout.
- **Input safety** — Request bodies are filtered through strict field
  whitelists (`serviceBody`, `patternBody`, `sanitizeBody`) to prevent payload
  pollution.
- **Auditability** — Every API call, Exchange call, and auth event
  (login / logout / node register) is recorded in server-side `system.log` /
  `audit.log` files (directory `0700`, files `0600`).

## Hardening Checklist (Production)

- Set `SESSION_ENC_KEY` (64 hex chars) via environment or secret so the master
  key persists across restarts and is not auto-generated per host.
- Mount a CA-signed TLS certificate at `/etc/nginx/ssl/fullchain.pem` and
  `/etc/nginx/ssl/privkey.pem` instead of the bundled self-signed certificate.
- Keep the PostgreSQL data volume persistent.
- When SSO is enabled, disable the local password form for regular users,
  keeping the bootstrap break-glass entry only.
- Never commit session key files, environment files, or any credentials;
  supply them through environment variables, mounted secrets, or an
  untracked operator values file.
