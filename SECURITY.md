# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's **[Security Advisories](https://github.com/fellipedepalma/vckb/security/advisories/new)**
("Report a vulnerability" in the repository's Security tab). Include:

- affected version/commit,
- steps to reproduce or a proof of concept,
- the impact you expect.

You should get a first response within a few days. Once a fix is released, the advisory will be
published with credit to the reporter (unless you prefer otherwise).

## Scope

VCKB is designed as a local, single-user tool bound to `127.0.0.1` with a Bearer token, plus a
session cookie for the web UI (see "Security model" and its threat model in the
[README](README.md#security-model)). Reports are especially welcome for:

- escaping the boards directory (path traversal, symlinks),
- authentication bypass, session forgery or token leakage,
- CSRF, DNS rebinding or `Host`/`Origin` check bypasses,
- code execution through task files or API input (task files are untrusted input: the frontmatter
  parser refuses `---js` engines, YAML tags, anchors/aliases and oversized files; see "File format
  and trust model" in the [README](README.md#file-format-and-trust-model)),
- XSS in the web UI through task content.

Deployments exposed to the internet without TLS and additional authentication are outside the
supported configuration.

## Supported versions

Only the latest release on `main` receives security fixes.
