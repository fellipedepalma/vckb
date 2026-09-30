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
- Files: gray-matter (reading **YAML** frontmatter only), js-yaml (writing)
- CLI: `node:util` `parseArgs`, no server needed (talks to the files directly)
- Frontend: React + Vite + Tailwind + dnd-kit (in `web/`, in progress)
- Tests: vitest

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Dev (API + UI) | `npm run dev` (lands with the web UI) |
| API only | `npm run dev:server` |
| Tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Dependency audit | `npm run audit` |
| Build | `npm run build` |
| Production | `npm start` |
| CLI | `npm run vckb -- <command>` or `vckb <command>` after `npm link` |
| Docker | `docker compose up --build` |

## Layout

```
src/core/     file format, validation, BoardStore (all business rules live here)
src/server/   Hono app (routes, auth, SSE) + watcher
src/cli/      vckb CLI
web/          React UI (in progress)
tests/        vitest (core, API, CLI, security)
boards/       data (one directory per project). Only boards/example/ is versioned;
              real boards live outside the repo (VCKB_BOARDS_DIR)
```

## Code conventions

- All business rules live in `src/core/store.ts`. The API and CLI are thin layers on top of it.
- Disk writes always go through `atomicWrite` and inside the project's `withLock`.
- Every path built from external input goes through `assertSlug`/`normalizeTaskId` **and**
  `safeJoin`. Never `path.join` user input.
- Never swap the frontmatter parser for something that accepts `---js` (gray-matter would `eval` it).
- Preserve the Markdown body: change only the section you need (`setChecklist`, `setDescription`,
  `appendNote`).
- Everything contributors read (code, comments, messages, tests, docs) is in English, except
  `README.pt-BR.md` and the Portuguese block in `AGENT-PROTOCOL.md`.
- Agent notes: new tasks use `## Agent notes`; `## Notas do agente` is accepted and preserved
  (`NOTES_HEADINGS` in `src/core/task-file.ts`).
- Every bug fix gets a regression test. Security findings go in `tests/security.test.ts`.
- Style: 2 spaces, single quotes, semicolons, no `any` (except in tests).
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
- ID allocation is `max(nextId, highest ID in tasks/ incl. file-name prefixes) + 1`; never reuse.
- `vckb doctor` (`BoardStore.doctor`) is read-only without `--fix`; with it, it runs under the lock.
  Tests for all of this live in `tests/hand-edits.test.ts`.

## Security

- The API requires `Authorization: Bearer $VCKB_TOKEN` (constant-time comparison).
- The server listens on `127.0.0.1` by default. CORS is off unless `VCKB_CORS_ORIGINS` is set.
- Markdown rendered in the UI must never interpret raw HTML.
