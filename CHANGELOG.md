# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will use
[Semantic Versioning](https://semver.org/) from 1.0 on. Until then, minor versions may break things.

## [Unreleased]

### Added

- **Web UI** (first stage), served by the same server at `/` (`npm run build && npm start`): sign-in
  with the token (clear messages for a wrong token, 429 with a countdown and 421 with the
  `VCKB_ALLOWED_HOSTS` hint), sign-out, project tabs, a read-only board with every column and its
  count, task cards (ID, title, priority, labels, checklist progress, warning mark), a banner
  suggesting `vckb doctor` when the board has warnings, and live updates over SSE with a connection
  indicator. Dark theme, bundled fonts, no external resources, strict CSP unchanged.
- `npm run dev` runs the API and the UI (Vite on http://localhost:5173, proxying `/api`).
- `GET /api/projects/:slug/board`: project, tasks and warnings from a single read.
- Optimistic concurrency: tasks have an `etag` (content hash) in listings and an `ETag` header on
  task responses; `PATCH`, `DELETE` and `notes` honor `If-Match` and answer **412** when the file
  changed on disk since it was read. Requests without `If-Match` behave as before.
- Web UI authentication: `POST /api/session` exchanges `VCKB_TOKEN` for a `vckb_session` cookie
  (HttpOnly, SameSite=Strict, Path=/api, 7 days, Secure over HTTPS; HMAC keyed by HKDF of the
  token, so rotating the token revokes all sessions). `GET /api/session`, `POST /api/session/logout`.
- CSRF protection for cookie-authenticated writes: `X-VCKB-CSRF` header plus an `Origin` matching
  the `Host` (or listed in `VCKB_ALLOWED_ORIGINS`). Bearer requests are unaffected.
- `Host` allow-list against DNS rebinding (loopback names, the bind address and
  `VCKB_ALLOWED_HOSTS`); other hosts get **421**.
- Per-client exponential backoff for failed logins and failed Bearer tokens (**429** with
  `Retry-After`). `VCKB_TRUST_PROXY=true` makes X-Forwarded-Proto/For count; the client address is
  then the rightmost X-Forwarded-For entry (the trusted hop), so forged entries are ignored.
  Without it, everyone behind a proxy shares one rate-limit bucket (documented in the threat model).
- Security headers on every response: strict CSP, `nosniff`, `Referrer-Policy: no-referrer`;
  `Cache-Control: no-store` on the API.
- `vckb doctor <project> [--fix] [--json]`: lists problems left by hand edits (duplicate IDs,
  repeated or missing `order`, incomplete frontmatter, status outside the columns, `nextId` behind
  the files, unparsable files). Read-only without `--fix`; with it, persists the defaults, gives
  duplicated IDs a new ID (renaming the file), renumbers the affected columns and fixes `nextId`.
- `warnings` in `GET /api/projects/:slug/summary` and in `vckb list --json`: a list of
  `{ code, message, file?, files?, id?, column?, fields? }`.
- Docker: publish IP configurable with `VCKB_BIND_IP` (default `127.0.0.1`) and host port with
  `VCKB_HOST_PORT`; container user configurable with `VCKB_UID`/`VCKB_GID` (default 1000); read-only
  root filesystem, no Linux capabilities, `no-new-privileges`.
- CI workflow `docker.yml`: hadolint, image build, container smoke test (`scripts/smoke.sh`).
- The server warns when `VCKB_HOST` is not a loopback address outside a container, and refuses an
  invalid `VCKB_PORT`.

### Changed

- **Breaking:** requests with a `Host` header other than `localhost`, `127.0.0.1`, `[::1]` or the
  bind address are refused with 421 unless the name is added to `VCKB_ALLOWED_HOSTS` (matters when
  you open VCKB through a Tailscale/LAN address or a hostname).
- **Breaking:** `vckb list --json` returns `{ "tasks": [...], "warnings": [...] }` instead of a bare
  array. In text mode, warnings are printed to stderr.
- **Breaking:** `invalidFiles` in the summary was replaced by `warnings` (unparsable files have
  `code: "invalid_file"`).
- Hand-edited task files no longer disappear from listings: missing `id` comes from the file name
  (or a provisional ID), missing `title` from the file name, missing `order` puts the task at the
  end of its column, missing dates use the file's modification date, and a status outside the
  columns shows the task in the first column. Files starting with a UTF-8 BOM are accepted.
- Two files with the same ID are both listed; writes through that ID answer **409 Conflict**
  (CLI exit code 1) until `vckb doctor --fix` runs.
- A column with repeated or missing `order` values is renumbered (10, 20, 30…) whenever the server
  or the CLI rewrites it.
- ID allocation is `max(nextId, highest ID found in tasks/) + 1`, so a `board.json` that fell behind
  never causes an ID to be reused.

### Fixed

- Keyboard focus is always visible in the web UI: a solid 2px ring in the accent color on task
  cards, the token field, buttons and project tabs (it could be missing because the outline style
  wasn't set). Transitions now animate only colors, borders and shadows instead of every property.
- Live updates could be lost: a task file created and removed quickly (while the watcher was still
  waiting for its size to settle) produced no event at all, so open boards kept showing it.

- Stale cross-process locks: a lock left by a dead process is recovered at once (dead PID on the
  same host) or after 10 s without a heartbeat. Breaking a stale lock is serialized, so two
  processes can no longer end up holding the lock at the same time; the default wait (15 s) now
  outlasts the stale age.
