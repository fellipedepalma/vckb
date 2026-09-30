# AGENTS.md: VCKB (Vibe Coding Kanban)

Instruções para qualquer agente de IA (Claude, Gemini, Codex etc.) que trabalhe **neste repositório**.
`CLAUDE.md` e `GEMINI.md` apenas apontam para cá; este é o único arquivo com regras.

## O que é

VCKB é um kanban minimalista cuja fonte da verdade são arquivos Markdown em `boards/`.
Humanos usam a web UI e agentes usam o CLI `vckb`, a API REST ou editam os `.md` diretamente.
Não há banco de dados.

## Fluxo de trabalho (obrigatório)

1. **Decisões combinadas.** Antes de implementar algo não trivial, descreva a abordagem (arquivos
   afetados, trade-offs) e espere o "ok" do mantenedor. Não mude o escopo sem perguntar.
2. **Implementação com evidências.** Toda entrega vem com provas concretas: saída de
   `npm test` e `npm run typecheck`, os comandos rodados com a saída relevante e prints/logs quando
   houver UI. "Deve funcionar" não é evidência.
3. **Revisão e aprovação.** Pare ao fim de cada etapa e apresente as evidências. O mantenedor
   revisa e aprova.
4. **Commit.** Só depois da aprovação explícita. Use mensagens no imperativo e em português
   (ex.: `Adiciona endpoint de summary`), um assunto por commit.

Quando um teste falhar ou algo se comportar de forma inesperada, investigue a causa raiz
(reproduzir → hipótese → verificar) antes de propor uma correção.

## Stack

- Node 20+, TypeScript (ESM, `module: NodeNext`, imports com sufixo `.js`)
- Backend: Hono + `@hono/node-server`; tempo real com chokidar → SSE
- Arquivos: gray-matter (somente leitura de frontmatter **YAML**), js-yaml (escrita)
- CLI: `node:util` `parseArgs`, sem servidor (fala direto com os arquivos)
- Frontend: React + Vite + Tailwind + dnd-kit (em `web/`)
- Testes: vitest

## Comandos

| Tarefa | Comando |
|---|---|
| Instalar | `npm install` |
| Dev (API + UI) | `npm run dev` |
| Só a API | `npm run dev:server` |
| Testes | `npm test` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Produção | `npm start` |
| CLI | `npm run vckb -- <comando>` ou `vckb <comando>` após `npm link` |
| Docker | `docker compose up --build` |

## Estrutura

```
src/core/     formato de arquivo, validação, BoardStore (toda regra de negócio fica aqui)
src/server/   Hono app (rotas, auth, SSE) + watcher
src/cli/      CLI vckb
web/          UI React
tests/        vitest (core, API, CLI, segurança)
boards/       dados (um diretório por projeto)
```

## Convenções de código

- Toda regra de negócio fica em `src/core/store.ts`. API e CLI são camadas finas por cima dele.
- Escritas em disco sempre com `atomicWrite` e dentro de `withLock` do projeto.
- Todo caminho montado a partir de entrada externa passa por `assertSlug`/`normalizeTaskId` **e**
  `safeJoin`. Nunca use `path.join` com entrada do usuário.
- Nunca troque o parser do frontmatter por algo que aceite `---js` (o gray-matter faria `eval`).
- Preserve o corpo Markdown: altere só a seção necessária (`setChecklist`, `setDescription`,
  `appendNote`).
- Mensagens para o usuário em português; identificadores de código em inglês.
- Todo bug corrigido ganha um teste de regressão. Achados de segurança vão para `tests/security.test.ts`.
- Estilo: 2 espaços, aspas simples, ponto e vírgula, sem `any` (exceto em testes).

## Segurança

- A API exige `Authorization: Bearer $VCKB_TOKEN` (comparação em tempo constante).
- O servidor ouve em `127.0.0.1` por padrão. CORS fica desligado, a menos que `VCKB_CORS_ORIGINS` seja definido.
- Markdown renderizado na UI não pode interpretar HTML cru.
