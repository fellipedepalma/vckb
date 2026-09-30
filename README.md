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

## Quick start (local)

Requires Node.js **22.12+**.

```bash
git clone https://github.com/fellipedepalma/vckb.git
cd vckb
npm install
cp .env.example .env
# put a long random token in .env:
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm run dev:server        # API on http://127.0.0.1:8787/api
```

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
- The port is published on **127.0.0.1 only**.
- The container runs as the unprivileged `node` user (uid 1000); make sure it can write to the
  mounted directory.

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

All endpoints require `Authorization: Bearer $VCKB_TOKEN`. JSON in, JSON out.

| Method | Path | Notes |
|---|---|---|
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

- **Token.** Every API call needs `Authorization: Bearer <VCKB_TOKEN>`, compared in constant time.
  The server refuses to start without a token of at least 16 characters.
- **Loopback by default.** The server binds to `127.0.0.1`; Docker publishes the port on `127.0.0.1` only.
- **CORS off by default.** Enable specific origins with `VCKB_CORS_ORIGINS`.
- **Input hardening.** Strict validation of project slugs and task IDs plus resolved-path checks
  (no path traversal), request body limits, YAML-only frontmatter (no code evaluation).
- **Remote access.** To reach VCKB from another device, use a private network such as
  [Tailscale](https://tailscale.com/) or another VPN. **Never expose it directly to the internet**;
  if you must, put it behind a reverse proxy with TLS and additional authentication.
- **Files are trusted input.** Anyone who can write to the boards directory can change tasks; that's
  the design. Protect the directory like you protect your code.

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

## License

[MIT](LICENSE) © 2026 Fellipe
