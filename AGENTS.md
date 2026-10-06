# AGENTS.md: VCKB (Vibe Coding Kanban)

Instructions for any AI agent (Claude, Gemini, Codex, etc.) working **on this repository**.
`CLAUDE.md` and `GEMINI.md` only point here; this is the single source of rules.

## What this is

VCKB is a minimal kanban whose source of truth is Markdown files in a boards directory.
Humans use the web UI; agents use the `vckb` CLI, the REST API, or edit the `.md` files directly.
There is no database.

## Workflow (mandatory)

1. **Agreed decisions.** Before implementing anything non-trivial, describe the approach (files
   affected, trade-offs) and wait for the maintainer's OK. Don't change scope without asking.
2. **Implementation with evidence.** Every delivery comes with concrete proof: output of
   `npm test` and `npm run typecheck`, the commands you ran with their relevant output, and
   screenshots/logs when there is UI. "Should work" is not evidence.
3. **Review and approval.** Stop at the end of each stage and present the evidence. The
   maintainer reviews and approves.
4. **Commit.** Only after explicit approval. Use [Conventional Commits](https://www.conventionalcommits.org/)
   (e.g. `feat: add summary endpoint`), one logical change per commit.

When a test fails or something behaves unexpectedly, find the root cause
(reproduce → hypothesis → verify) before proposing a fix.

## Stack

- Node 22.12+, TypeScript (ESM, `module: NodeNext`, imports with the `.js` suffix)
- Backend: Hono + `@hono/node-server`; real time via chokidar → SSE
- Files: js-yaml reads and writes the frontmatter (**YAML** only; `splitFrontmatter` in `src/core/task-file.ts`)
- CLI: `node:util` `parseArgs`, no server needed (talks to the files directly)
- Frontend: React + Vite + Tailwind + dnd-kit (in `web/`), built to `dist/web` and served by the same server
- Tests: vitest (`server` and `web` projects), Playwright (chromium) e2e against the production build

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Dev (API + UI) | `npm run dev` (UI on http://localhost:5173, proxies /api) |
| UI only | `npm run dev:web` |
| API only | `npm run dev:server` |
| Tests | `npm test` |
| Typecheck | `npm run typecheck` (server and web) |
| E2E | `npm run test:e2e` (builds first; `npx playwright install chromium` once) |
| Slow-CI simulation | `VCKB_E2E_CPU_THROTTLE=4 npx playwright test --retries=0` (CPU 4x slower via CDP) |
| E2E stress | `npm run test:e2e:stress` (e2e/stress, long loops); in CI: "E2E stress" workflow, manual |
| Dependency audit | `npm run audit` |
| Build | `npm run build` |
| Production | `npm start` |
| CLI | `npm run vckb -- <command>` or `vckb <command>` after `npm link` |
| Docker | `docker compose up --build` |
| Local demo for the maintainer | `npm run demo` / `VCKB-demo.bat` (never leave a demo running in the background yourself) |

## Layout

```
src/core/     file format, validation, BoardStore (all business rules live here)
src/server/   Hono app (routes, auth, SSE) + watcher
src/cli/      vckb CLI
web/          React UI (src/strings.ts holds every UI text; src/api.ts is the only fetch wrapper)
tests/        vitest (core, API, CLI, security)
e2e/          Playwright (fails on any console error or CSP violation)
boards/       data (one directory per project). Only boards/example/ is versioned;
              real boards live outside the repo (VCKB_BOARDS_DIR)
```

## Code conventions

- All business rules live in `src/core/store.ts`. The API and CLI are thin layers on top of it.
- Disk writes always go through `atomicWrite` and inside the project's `withLock`.
- Every path built from external input goes through `assertSlug`/`normalizeTaskId` **and**
  `safeJoin`. Never `path.join` user input.
- Never swap the frontmatter parser for something that accepts `---js` (libraries such as gray-matter `eval` it).
- Preserve the Markdown body: change only the section you need (`setChecklist`, `setDescription`,
  `appendNote`).
- Everything contributors read (code, comments, messages, tests, docs) is in English, except
  `README.pt-BR.md` and the Portuguese block in `AGENT-PROTOCOL.md`.
- Agent notes: new tasks use `## Agent notes`; `## Notas do agente` is accepted and preserved
  (`NOTES_HEADINGS` in `src/core/task-file.ts`).
- Every bug fix gets a regression test. Security findings go in `tests/security.test.ts`.
- Dates (`created`, `updated`, agent notes) use `YYYY-MM-DD` in the server's local timezone.
- Style: 2 spaces, single quotes, semicolons, no `any` (except in tests).
- `@dnd-kit/*` is pinned and ignored by Dependabot: `ImmediateKeyboardSensor` (`web/src/components/Board.tsx`)
  relies on private internals of `@dnd-kit/core` 6.3.1. Bump manually: re-read that class, run
  `VCKB_E2E_CPU_THROTTLE=6 npm run test:e2e:stress`, then update `REVIEWED` in `tests/dnd-kit-pin.test.ts`.
- Update `CHANGELOG.md` (section `Unreleased`) in the same commit as any user-visible change.

## Task files edited by hand (contract)

Task files are also written by humans and agents directly, so reading must never fail on them:

- `BoardStore.scan` applies safe defaults and reports every problem as a `BoardWarning`
  (`invalid_file`, `incomplete_frontmatter`, `provisional_id`, `duplicate_id`, `duplicate_order`,
  `unknown_status`, `next_id_behind`). Add a new code there rather than throwing.
- Output contract: `vckb list --json` is `{ tasks, warnings }`; `/api/.../summary` has `warnings`.
  Changing these shapes is a breaking change (note it in the changelog).
- Writes through an ID shared by several files throw `CONFLICT` (HTTP 409); reads return the first
  file by name. `Task.file` is the unique key, not `id`.
- `Task.etag` is the hash of the file content. Store writes take `{ ifMatch }` and throw
  `PRECONDITION_FAILED` (HTTP 412) when the file changed since it was read. The UI must always send
  `If-Match` on task writes and never retry a 412 blindly. Tests: `tests/concurrency.test.ts`.
- ID allocation is `max(nextId, highest ID in tasks/ incl. file-name prefixes) + 1`; never reuse.
- `vckb doctor` (`BoardStore.doctor`) is read-only without `--fix`; with it, it runs under the lock.
  Tests for all of this live in `tests/hand-edits.test.ts`.

## Security

- The API requires `Authorization: Bearer $VCKB_TOKEN` (constant-time comparison) or the web UI's
  `vckb_session` cookie (`src/server/auth.ts`: HMAC with an HKDF-derived key, 7 days).
- Cookie-authenticated `POST/PUT/PATCH/DELETE` must pass the CSRF check (`X-VCKB-CSRF` + same-host
  `Origin`). The UI must send both on every write; never relax the check for convenience.
- `Host` must be in the allow-list (421 otherwise). Failed logins/Bearer tokens are rate limited.
- Every response carries the CSP in `CONTENT_SECURITY_POLICY` (`src/server/app.ts`): the UI can't use
  inline scripts or styles, external scripts or fonts, or `eval`.
- The server listens on `127.0.0.1` by default. CORS is off unless `VCKB_CORS_ORIGINS` is set.
- Markdown rendered in the UI must never interpret raw HTML; links with `javascript:` or `data:`
  URLs are blocked.
- Auth changes need tests in `tests/security.test.ts` that fail when the protection is removed.

## Web UI rules

- Never `dangerouslySetInnerHTML`. Never store the token in JS memory beyond the sign-in request,
  `localStorage` or `sessionStorage`; the session is the HttpOnly cookie.
- All requests go through `web/src/api.ts` (it adds the CSRF header, `If-Match`, and turns a 401 into
  "back to sign-in"). No other `fetch` calls.
- No external resources (CDNs, Google Fonts, remote images). Fonts are bundled (OFL). Frontend packages
  are devDependencies: they end up in the bundle, not in the production `node_modules`.
- Never relax the CSP. If a library needs `unsafe-inline`/`unsafe-eval`, stop and propose an alternative.
- Every text shown to users lives in `web/src/strings.ts`.
- Design tokens are in `web/src/styles.css`. Marigold means "needs you" (review column, warnings) and
  nothing else. Text must meet WCAG AA contrast; control borders 3:1.
