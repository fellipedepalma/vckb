# VCKB agent protocol

Paste the block below into the `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) of every project you
track in VCKB. Replace the two placeholders first:

- `{{VCKB_BOARDS}}` → **absolute** path of your boards directory, i.e. the value of `VCKB_BOARDS_DIR`
  (e.g. `/home/you/vckb-boards` or `C:/Users/you/vckb-boards`)
- `{{PROJECT}}` → the project's slug in VCKB (e.g. `my-shop`)

The block does not depend on any agent skill/plugin, and it works without the VCKB server running.
A Portuguese version is at the [end of this file](#versão-em-português-pt-br).

---

````markdown
## VCKB: task tracking (mandatory)

This project's tasks live in VCKB as Markdown files:
`{{VCKB_BOARDS}}/{{PROJECT}}/tasks/` (columns are defined in `{{VCKB_BOARDS}}/{{PROJECT}}/board.json`).

### Before starting any work
1. Read the current tasks: `vckb list {{PROJECT}}` (or read the `.md` files in the folder above).
2. If the user's request doesn't match an existing task, create one (see "New tasks") before starting.

### Which task to pick
- Take tasks from the `todo` column by priority (`high` > `medium` > `low`); on ties, lowest `order`
  first. Shortcut: `vckb next {{PROJECT}}`.
- Don't take a task that is already in `doing` unless the user asks you to.

### Lifecycle
1. When you **start**: `vckb move {{PROJECT}} T-XXX doing`
2. While working: tick finished `## Checklist` items (`- [ ]` → `- [x]`) and record decisions,
   trade-offs and what was done under `## Agent notes` (older tasks may use `## Notas do agente`; keep
   whichever heading the task already has):
   `vckb note {{PROJECT}} T-XXX "Chose X because Y; files changed: ..."`
3. When you **finish**: `vckb move {{PROJECT}} T-XXX review`
4. **Never move a task to `done`.** Only the user approves and moves tasks to `done`.
5. If blocked, write the reason in the agent notes, leave the task in `doing` and tell the user.

### New tasks
When you discover pending work outside the current scope (bug, refactor, TODO), **don't do it now**:
record it in `backlog`:
`vckb add {{PROJECT}} "Short title" --priority medium --label bug`
(`vckb add` creates tasks in `backlog` by default.)

### Editing the files by hand (if the CLI is not available)
Each task is `tasks/T-NNN-title-in-kebab-case.md`:

```
---
id: T-007
title: Short title
status: todo          # one of the columns in board.json
priority: medium      # low | medium | high
labels: [backend, ui]
order: 10             # position within the column (lower = higher up)
created: 2026-09-30
updated: 2026-09-30
---
Free-form Markdown description.

## Checklist

- [ ] item

## Agent notes

- 2026-09-30: what was decided/done
```

Rules for manual edits:
- Change only what is needed and keep the rest of the file intact. Set `updated` to today's date.
- `status` must be one of the `columns` in `board.json`.
- To create a task by hand, use `nextId` from `board.json` as the number (T-NNN, 3 digits) and
  increment `nextId` in the same step. Prefer the CLI, which does this with a lock and atomic writes.
- Frontmatter is always YAML (`---`). Never use `---js` or any other format.
- Don't delete tasks; the user decides what leaves the board.
````

---

## Installing the CLI for agents

In the VCKB directory: `npm install && npm link`. After that `vckb` is available in any terminal.
It reads `VCKB_BOARDS_DIR` from the environment or from VCKB's own `.env` (default: `./boards`
inside the VCKB install), so it finds the same boards no matter which project it is called from.
`--dir <path>` overrides it for a single command.

Commands: `vckb projects | list | show | add | move | done | note | next | doctor` (add `--json`
for structured output; `vckb --help` for details). If `vckb list` prints warnings after you edited
a file by hand, run `vckb doctor {{PROJECT}}` and fix what it reports.

---

## Versão em português (pt-BR)

Mesmos placeholders: `{{VCKB_BOARDS}}` (caminho absoluto dos boards) e `{{PROJETO}}` (slug).

````markdown
## VCKB: gestão de tarefas (obrigatório)

As tarefas deste projeto ficam no VCKB, em arquivos Markdown:
`{{VCKB_BOARDS}}/{{PROJETO}}/tasks/` (colunas em `{{VCKB_BOARDS}}/{{PROJETO}}/board.json`).

### Antes de começar qualquer trabalho
1. Leia as tarefas atuais: `vckb list {{PROJETO}}` (ou leia os `.md` da pasta acima).
2. Se o pedido do usuário não corresponder a uma tarefa existente, crie uma (veja "Novas tarefas")
   antes de começar.

### Qual tarefa pegar
- Pegue tarefas da coluna `todo` por prioridade (`high` > `medium` > `low`); em empate, a de menor
  `order`. Atalho: `vckb next {{PROJETO}}`.
- Não pegue tarefas que já estão em `doing` sem o usuário pedir.

### Ciclo de vida
1. Ao **iniciar**: `vckb move {{PROJETO}} T-XXX doing`
2. Durante o trabalho: marque os itens concluídos do `## Checklist` (`- [ ]` → `- [x]`) e registre
   decisões, trade-offs e o que foi feito em `## Agent notes` (tarefas antigas podem usar
   `## Notas do agente`; mantenha o título que a tarefa já tiver):
   `vckb note {{PROJETO}} T-XXX "Escolhi X porque Y; arquivos alterados: ..."`
3. Ao **terminar**: `vckb move {{PROJETO}} T-XXX review`
4. **Nunca mova para `done`.** Quem aprova e move para `done` é o usuário.
5. Se ficar bloqueado, anote o motivo nas notas, deixe a tarefa em `doing` e avise o usuário.

### Novas tarefas
Ao descobrir trabalho pendente fora do escopo atual (bug, refatoração, TODO), **não o faça agora**:
registre em `backlog`:
`vckb add {{PROJETO}} "Título curto" --priority medium --label bug`
(`vckb add` cria em `backlog` por padrão.)

### Editando os arquivos à mão (se o CLI não estiver disponível)
Cada tarefa é `tasks/T-NNN-titulo-em-kebab.md`:

```
---
id: T-007
title: Título curto
status: todo          # uma das colunas do board.json
priority: medium      # low | medium | high
labels: [backend, ui]
order: 10             # posição na coluna (menor = mais acima)
created: 2026-09-30
updated: 2026-09-30
---
Descrição livre em Markdown.

## Checklist

- [ ] item

## Agent notes

- 2026-09-30: o que foi decidido/feito
```

- Altere só o necessário e atualize `updated` com a data de hoje.
- `status` precisa ser uma das `columns` do `board.json`.
- Para criar uma tarefa à mão, use o `nextId` do `board.json` e incremente-o no mesmo passo.
  Prefira o CLI, que faz isso com lock e escrita atômica.
- Frontmatter sempre YAML (`---`). Nunca use `---js`.
- Não apague tarefas; o usuário decide o que sai do board.
````
