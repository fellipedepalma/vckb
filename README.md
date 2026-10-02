# VCKB: Vibe Coding Kanban

**A file-based kanban for humans and AI coding agents.** Every task is a Markdown file with YAML
frontmatter. You use a web board; your agents (Claude Code, Gemini CLI, Codex, Cursor, anything
that can read files or run a command) use the `vckb` CLI, the REST API, or simply edit the files.

🇧🇷 [Leia em português](README.pt-BR.md)

> [!WARNING]
> **🚧 Early development.** The backend (file format, store), the `vckb` CLI and the REST API are
> working and tested. **The web UI is under construction.** Expect breaking changes before 1.0.

<!-- TODO(ui): replace with a screenshot/GIF of the board once the web UI lands -->
> 🖼️ _Screenshot / GIF of the board: coming with the web UI._

## Why

When you vibe-code across several projects, "what's done and what's left" ends up scattered across
chat histories, TODO comments and each agent's memory. VCKB keeps **one source of truth in plain
Markdown** that any agent can read and update, and that you can review in a board and version with git:

- **No database.** `boards/<project>/tasks/T-001-some-title.md`. `git diff` shows exactly what an agent changed.
- **Any agent, no plugin required.** If it can read a file or run a shell command, it can use VCKB.
- **A protocol, not just a tool.** [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md) is a ready-to-paste block for
  your projects' `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`: agents pick `todo` tasks by priority,
  move them to `doing`, then to `review`, and **never to `done`**; approving is your job.
- **Live.** The server watches the files and pushes changes to the UI, so edits made by agents
  directly on disk show up immediately.

## Try it with one command

After `npm ci`: `npm run demo` (Windows: double-click `VCKB-demo.bat`, which installs the
dependencies on first use). It builds VCKB, starts it on http://127.0.0.1:8787 (or the next free
port) with a copy of the example board, prints a token and opens the browser; paste the token to
sign in. The token is disposable and local: it is created for the demo, stored in `.demo/token`, and
only works for this demo on 127.0.0.1. Your changes stay in `.demo/boards` between runs
(`npm run demo -- --reset` starts over); the log is `.demo/server.log`. Close the window or press
Ctrl+C to stop.

## Quick start (local)

Requires Node.js **22.12+**.

```bash
git clone https://github.com/fellipedepalma/vckb.git
cd vckb
npm install
cp .env.example .env
# put a long random token in .env (VCKB_TOKEN=...):
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm run build
npm start                 # web UI on http://127.0.0.1:8787, API under /api
```

Open http://127.0.0.1:8787 and paste the token once; the browser gets a session cookie for 7 days.

For development, `npm run dev` runs the API (auto-reload) and the UI with Vite on
http://localhost:5173, which proxies `/api` to the API on the same origin (no CORS needed).

Install the CLI globally (it works without the server running):

```bash
npm link
vckb projects
vckb list example
```

## Keep your real boards out of this repo

`boards/example/` is the only board versioned here. For your own projects, the recommended setup is:

1. Create a **separate private git repository** for your boards, e.g. `~/vckb-boards`.
2. Point VCKB at it in `.env`:
   ```bash
   VCKB_BOARDS_DIR=/home/you/vckb-boards
   ```
   Relative paths are resolved from the VCKB install directory. The CLI reads VCKB's own `.env`,
   so it finds the same boards from any project directory. `--dir <path>` overrides it per command.
3. Commit the boards repo whenever you like: you get the history of every status change and every
   agent note for free.

## Docker

```bash
cp .env.example .env      # set VCKB_TOKEN (and VCKB_BOARDS_DIR if your boards live elsewhere)
docker compose up --build
```

- The boards directory `${VCKB_BOARDS_DIR:-./boards}` is mounted at `/data` in the container.
- Inside the container the server listens on `0.0.0.0` (required for the published port to work).
  Exposure is decided by the port mapping, which defaults to **`127.0.0.1:8787`**: this machine only.
- To reach it from your other devices, set the IP of **one** private interface in `.env`:
  `VCKB_BIND_IP=<Tailscale IP>` (`tailscale ip -4`) or your LAN IP. Never `0.0.0.0`: it publishes on
  every interface, and Docker's iptables rules bypass host firewalls such as ufw.
- The container runs as non-root (uid/gid 1000 by default) with a read-only filesystem, no Linux
  capabilities and `no-new-privileges`. On Linux the boards directory must be writable by that
  user: set `VCKB_UID=$(id -u)` and `VCKB_GID=$(id -g)` in `.env` to run as yourself.

## Keyboard

Every card is one Tab stop. To move a card without a mouse: **Tab** to it, **Space** picks it up,
**Left/Right** change the column (empty columns included), **Up/Down** change its position,
**Space** drops it and **Escape** cancels. Each step is announced to screen readers, and focus stays
on the card. **Enter** is reserved for opening the card's details (coming next).

## CLI

```
vckb projects
vckb list <project> [--status todo] [--label ui]
vckb show <project> T-001
vckb add <project> "title" [--priority high] [--label ui --label api] [--status todo] [--description "..."]
vckb move <project> T-001 doing
vckb done <project> T-001
vckb note <project> T-001 "text"        # appends to "## Agent notes"
vckb next <project>                     # highest-priority task in "todo"
vckb doctor <project> [--fix]           # find (and repair) problems left by hand edits

Global: --dir <path>   --json   -h/--help
```

`vckb add` creates tasks in the first column (`backlog` by default).

`vckb list --json` returns `{ "tasks": [...], "warnings": [...] }`; in text mode the warnings go to
stderr. See [Hand-edited files](#hand-edited-files).

## REST API

All endpoints require `Authorization: Bearer $VCKB_TOKEN`, or the web UI's session cookie (see
[Security model](#security-model)). JSON in, JSON out.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/session` | `{ token }` → sets the `vckb_session` cookie. Needs `X-VCKB-CSRF` + same-host `Origin`; rate limited |
| GET | `/api/session` | `{ authenticated, via: "cookie" \| "bearer", expiresAt }` |
| POST | `/api/session/logout` | clears the cookie (204) |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | `{ name, slug?, description?, columns? }` |
| GET | `/api/projects/:slug` | board (columns, nextId…) |
| GET | `/api/projects/:slug/tasks?status=&label=` | list tasks |
| POST | `/api/projects/:slug/tasks` | `{ title, status?, priority?, labels?, description?, checklist?, body?, position? }` |
| GET | `/api/projects/:slug/tasks/:id` | one task |
| PATCH | `/api/projects/:slug/tasks/:id` | any of `title, status, priority, labels, body, description, checklist, position, order` |
| DELETE | `/api/projects/:slug/tasks/:id` | 204 |
| POST | `/api/projects/:slug/tasks/:id/notes` | `{ text }`, appends an agent note |
| GET | `/api/projects/:slug/summary` | count per column + next `todo` tasks by priority + `warnings` |
| GET | `/api/events` | Server-Sent Events: `change` with `{ "project": "<slug>" }` |

`position` (0 = top) places the task inside its target column and renumbers the others.

Errors are `{ "error": "message" }` with status 400 (validation), 401 (auth), 403 (CSRF check
failed), 404 (not found), 409 (conflict), 412 (`If-Match` failed), 413 (body too large), 421 (`Host` not allowed) or 429
(too many failed attempts; see `Retry-After`). **409** also means the task ID is used by more than one
file: `PATCH`, `DELETE` and `notes` on that ID are refused until you run `vckb doctor <project> --fix`
(reads still work and return the first file by name).

**Optimistic concurrency.** Every task has an `etag` (a hash of its file) in listings, and task
responses carry it in the `ETag` header. Send it back as `If-Match: "<etag>"` on `PATCH`, `DELETE`
or `notes`: if the file changed on disk since you read it (an agent edited it, say), the answer is
**412** and nothing is written. Without `If-Match` the write proceeds (CLI-style clients).
A move renumbers the other cards of its column, which changes their files: the `PATCH` response
body has `renumbered`, a map of task ID to new etag for those cards, so a client moving several
cards in a row can send the right `If-Match` next.

`warnings` in `/summary` (and in `vckb list --json`) is a list of
`{ code, message, file?, files?, id?, column?, fields? }`, with `code` one of `invalid_file`,
`incomplete_frontmatter`, `provisional_id`, `duplicate_id`, `duplicate_order`, `unknown_status`,
`next_id_behind`. An empty list means the board is clean.

```bash
curl -s -H "Authorization: Bearer $VCKB_TOKEN" http://127.0.0.1:8787/api/projects/example/summary
```

## File format

```
boards/
  <project-slug>/
    board.json      { "name": "...", "description": "...", "columns": ["backlog","todo","doing","review","done"], "nextId": 1 }
    tasks/
      T-001-short-title.md
```

```markdown
---
id: T-001
title: Short title
status: todo            # must be one of the board's columns
priority: medium        # low | medium | high
labels: [backend, ui]
order: 10               # position within the column
created: 2026-09-30
updated: 2026-09-30
---
Free-form Markdown description.

## Checklist
- [ ] item 1
- [x] item 2

## Agent notes
(agents record decisions and what was done here)
```

- IDs are sequential per project, never reused, allocated under a cross-process lock. The next ID
  is `max(nextId, highest ID found in tasks/) + 1`, so a `board.json` that fell behind heals itself.
- The lock is a `.vckb.lock/` directory in the project. If a process dies holding it, the lock is
  recovered immediately when its PID is gone (same machine), or after 10 s without a heartbeat
  (e.g. a process in a container sharing the volume). Delete it by hand only if nothing is running.
- All writes are atomic (temp file + rename). Only the frontmatter and the touched section change;
  the rest of the Markdown body is preserved byte for byte, along with unknown frontmatter fields.
- Frontmatter must be YAML. Other gray-matter languages (e.g. `---js`) are rejected on purpose.
- The section headings `## Checklist` and `## Agent notes` are part of the format. `## Notas do agente`
  (Portuguese) is accepted as an alias for agent notes; an existing heading is always preserved.

### Hand-edited files

Agents and humans may create or edit task files directly. VCKB never refuses to list a board
because of that; it applies safe defaults and reports each problem as a warning:

| Problem | What VCKB does |
|---|---|
| Missing `id` | Uses the `T-NNN` prefix of the file name; otherwise a provisional ID (the next free one), saved on the next write |
| Missing `title`, `priority`, `order`, `created`, `updated` | Title from the file name, `medium`, end of the column, file modification date |
| `status` not among the columns (or missing) | Shown in the first column |
| Two files with the same `id` | Both are listed; writes through that ID are refused until it is fixed |
| Repeated `order` in a column | Column renumbered (10, 20, 30…) the next time the server or CLI rewrites it |
| Unparsable file (bad YAML, no frontmatter) | Skipped and reported; fix it by hand |

`vckb doctor <project>` lists these problems and what would change, without touching anything.
`vckb doctor <project> --fix` persists the defaults, gives duplicated IDs a new ID (the file whose
name matches the ID, or else the oldest, keeps it; the other is renamed), renumbers the affected
columns and moves `nextId` past the highest ID.

## Agent protocol

Copy the block from **[AGENT-PROTOCOL.md](AGENT-PROTOCOL.md)** (English and Portuguese versions)
into each project's `AGENTS.md`, replacing `{{VCKB_BOARDS}}` and `{{PROJECT}}`. In short:

1. Read `<boards>/<project>/tasks/` before starting.
2. Take `todo` tasks by priority.
3. Move to `doing` when starting and to `review` when finished, **never to `done`**.
4. Tick checklist items and record decisions in the agent notes.
5. Put newly discovered work in `backlog`.
6. Use the `vckb` CLI, or edit the files following the format.

## Security model

VCKB is a **local, single-user tool**. Treat it like a dev server, not like a SaaS.

- **Token.** CLI-style clients send `Authorization: Bearer <VCKB_TOKEN>`, compared in constant time.
  The server refuses to start without a token of at least 16 characters.
- **Web UI session.** The browser exchanges the token once (`POST /api/session`) for a
  `vckb_session` cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api`, 7 days, `Secure` over HTTPS. It
  is an HMAC with a key derived from `VCKB_TOKEN` by HKDF, so page scripts never hold the token and
  changing `VCKB_TOKEN` logs every browser out.
- **CSRF.** A state-changing request authenticated only by the cookie must carry `X-VCKB-CSRF` and
  an `Origin` whose host equals the request's `Host` (or is listed in `VCKB_ALLOWED_ORIGINS`);
  otherwise 403. Bearer requests are exempt: browsers never add that header on their own.
- **Host allow-list.** Requests whose `Host` is not `localhost`, `127.0.0.1`, `[::1]`, the bind
  address or a name in `VCKB_ALLOWED_HOSTS` get 421. This blocks DNS rebinding.
- **Rate limiting.** Failed logins and failed Bearer tokens are limited per client address with
  exponential backoff (5 free attempts, then 1 s, 2 s, 4 s… up to 5 min; 429 with `Retry-After`).
- **Headers.** A strict CSP (`default-src 'self'`, no inline script or style, `frame-ancestors
  'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store` on the API.
- **Loopback by default.** The server binds to `127.0.0.1`; Docker publishes the port on `127.0.0.1` unless you set `VCKB_BIND_IP`.
- **CORS off by default.** Enable specific origins with `VCKB_CORS_ORIGINS`.
- **Input hardening.** Strict validation of project slugs and task IDs plus resolved-path checks
  (no path traversal), request body limits, YAML-only frontmatter (no code evaluation).
- **Remote access.** To reach VCKB from another device, use a private network such as
  [Tailscale](https://tailscale.com/) or another VPN and add its name/IP to `VCKB_ALLOWED_HOSTS`.
  Prefer HTTPS (e.g. `tailscale serve`, then set `VCKB_TRUST_PROXY=true` so the cookie gets
  `Secure`). **Never expose it directly to the internet**; if you must, put it behind a reverse proxy
  with TLS and additional authentication.
- **Files are trusted input.** Anyone who can write to the boards directory can change tasks; that's
  the design. Protect the directory like you protect your code.

### Threat model

| Threat | Mitigation | Not covered |
|---|---|---|
| Another website you visit (CSRF) | `SameSite=Strict` cookie, `X-VCKB-CSRF` + `Origin` check, CORS off | |
| Another local dev server on a different port (same "site" for cookies) | `Origin` must match the exact host **and port** | It can still receive the cookie if you open it on `localhost`; don't run untrusted servers |
| DNS rebinding (evil.example resolving to 127.0.0.1) | Host allow-list → 421 | |
| XSS in the UI (e.g. through a task's Markdown) | No raw HTML rendered, `javascript:`/`data:` links blocked, strict CSP; the token is not reachable from JS | While the page is open, injected script can act as you |
| Token guessing | Long random token, constant-time compare, per-client backoff | All local clients share one address (127.0.0.1) |
| Clients behind a reverse proxy locking each other out | Default: the socket address is used, so everyone behind the proxy shares one bucket (safe, but one attacker can block the others). With `VCKB_TRUST_PROXY=true`, the client is the **rightmost** `X-Forwarded-For` entry, the one your proxy appended; entries a client forges further left are ignored | Only one trusted hop is supported. Never enable it without a proxy in front: anyone could then pick their own bucket |
| Sniffing on the network | Loopback by default; Tailscale/WireGuard or HTTPS for remote access | Plain HTTP on a LAN exposes the token and the cookie |
| Stolen cookie | Expires in 7 days; rotate `VCKB_TOKEN` to revoke all sessions | Logout clears the browser's cookie but can't revoke a copied one |
| Malicious process on your machine | Out of scope: it can read the boards directory and `.env` directly | |

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Alternatives

Other tools in the same space you may want to look at:

- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)**: per its README, you plan with issues
  on a kanban board and run coding agents (Claude Code, Gemini CLI, Codex and others) in
  workspaces; started with `npx vibe-kanban`.
- **[Backlog.md](https://github.com/MrLesk/Backlog.md)**: per its README, a Markdown-native task
  manager and Kanban visualizer for any Git repository, where every task is a plain `.md` file in
  the repo; it has a CLI, a local web board (`backlog browser`) and works with MCP- or
  CLI-compatible AI assistants.

VCKB's angle: a single boards directory for **many** projects, kept outside the projects' own
repositories, plus a small copy-paste protocol that works with any agent.

## Development

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) (rules for AI agents working on this repo).
Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 Fellipe
