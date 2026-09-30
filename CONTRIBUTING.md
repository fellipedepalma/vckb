# Contributing

Thanks for helping! VCKB is small on purpose; please open an issue to discuss larger changes first.

## Setup

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run audit       # npm audit --omit=dev
```

Node.js 22.12+ is required. CI runs the same checks on Node 22 and 24.

## Rules

- **PRs must include tests.** New behavior gets tests; every bug fix gets a regression test.
  Security fixes go in `tests/security.test.ts`.
- All checks above must pass.
- Business rules live in `src/core/` (`BoardStore`); the API and CLI are thin layers on top of it.
- Never build filesystem paths from user input without `assertSlug`/`normalizeTaskId` **and** `safeJoin`.
- Keep the Markdown body of task files intact: change only the frontmatter or the section you touch.
- Match the existing style: 2 spaces, single quotes, semicolons, ESM imports with `.js` suffix.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add label filter to the CLI
fix: keep CRLF bodies intact when moving tasks
docs: clarify VCKB_BOARDS_DIR resolution
test: cover reordering across columns
```

One logical change per commit.

## AI agents

If you contribute with an AI coding agent, point it at [AGENTS.md](AGENTS.md); `CLAUDE.md` and
`GEMINI.md` already do.
