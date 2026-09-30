# VCKB: Vibe Coding Kanban

**Um kanban em arquivos para humanos e agentes de IA.** Cada tarefa é um arquivo Markdown com
frontmatter YAML. Você usa um board na web; seus agentes (Claude Code, Gemini CLI, Codex, Cursor,
qualquer um que leia arquivos ou rode um comando) usam o CLI `vckb`, a API REST ou editam os arquivos.

🇺🇸 [Read in English](README.md) (versão principal)

> [!WARNING]
> **🚧 Em desenvolvimento inicial.** O backend (formato de arquivos, store), o CLI `vckb` e a API
> REST estão prontos e testados. **A web UI está em construção.** Espere mudanças incompatíveis antes da 1.0.

<!-- TODO(ui): trocar por print/GIF do board quando a web UI existir -->
> 🖼️ _Print / GIF do board: chega junto com a web UI._

## Por que existe

Quando você faz vibe coding em vários projetos, "o que está feito e o que falta" acaba espalhado em
históricos de chat, comentários TODO e na memória de cada agente. O VCKB mantém **uma fonte da verdade
em Markdown puro** que qualquer agente lê e atualiza, que você revisa num board e versiona com git:

- **Sem banco de dados.** `boards/<projeto>/tasks/T-001-algum-titulo.md`. O `git diff` mostra exatamente o que um agente mudou.
- **Qualquer agente, sem plugin.** Se ele lê arquivo ou roda comando no shell, ele usa o VCKB.
- **Um protocolo, não só uma ferramenta.** O [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md) traz um bloco pronto
  para colar no `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` dos seus projetos: o agente pega tarefas de
  `todo` por prioridade, move para `doing`, depois para `review` e **nunca para `done`**; aprovar é com você.
- **Tempo real.** O servidor observa os arquivos e avisa a UI, então edições feitas por agentes
  direto no disco aparecem na hora.

## Início rápido (local)

Requer Node.js **22.12+**.

```bash
git clone https://github.com/fellipedepalma/vckb.git
cd vckb
npm install
cp .env.example .env
# coloque um token longo e aleatório no .env:
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm run dev:server        # API em http://127.0.0.1:8787/api
```

Instale o CLI globalmente (funciona sem o servidor rodando):

```bash
npm link
vckb projects
vckb list example
```

## Mantenha seus boards reais fora deste repositório

Só o `boards/example/` é versionado aqui. Para os seus projetos, o fluxo recomendado é:

1. Crie um **repositório git privado separado** para os boards, por exemplo `~/vckb-boards`.
2. Aponte o VCKB para ele no `.env`:
   ```bash
   VCKB_BOARDS_DIR=/home/voce/vckb-boards
   ```
   Caminhos relativos são resolvidos a partir da pasta de instalação do VCKB. O CLI lê o `.env` do
   próprio VCKB, então encontra os mesmos boards de qualquer projeto. `--dir <caminho>` sobrescreve
   por comando.
3. Faça commit do repositório de boards quando quiser: você ganha o histórico de cada mudança de
   status e de cada nota de agente.

## Docker

```bash
cp .env.example .env      # defina VCKB_TOKEN (e VCKB_BOARDS_DIR se os boards estiverem em outro lugar)
docker compose up --build
```

- O diretório `${VCKB_BOARDS_DIR:-./boards}` é montado em `/data` no container.
- A porta é publicada **só em 127.0.0.1**.
- O container roda como o usuário sem privilégios `node` (uid 1000); garanta que ele consiga
  escrever no diretório montado.

## CLI

```
vckb projects
vckb list <projeto> [--status todo] [--label ui]
vckb show <projeto> T-001
vckb add <projeto> "título" [--priority high] [--label ui --label api] [--status todo] [--description "..."]
vckb move <projeto> T-001 doing
vckb done <projeto> T-001
vckb note <projeto> T-001 "texto"       # acrescenta em "## Agent notes"
vckb next <projeto>                     # tarefa de maior prioridade em "todo"
vckb doctor <projeto> [--fix]           # encontra (e corrige) problemas de edição à mão

Globais: --dir <caminho>   --json   -h/--help
```

O `vckb add` cria na primeira coluna (`backlog` por padrão).

`vckb list --json` retorna `{ "tasks": [...], "warnings": [...] }`; no modo texto os avisos vão para
o stderr. Veja [Arquivos editados à mão](#arquivos-editados-à-mão).

## API REST

Todos os endpoints exigem `Authorization: Bearer $VCKB_TOKEN`. JSON na entrada e na saída.
A tabela completa está no [README em inglês](README.md#rest-api). Resumo:

- `GET/POST /api/projects`, `GET /api/projects/:slug`
- `GET/POST /api/projects/:slug/tasks` (filtros `?status=&label=`)
- `GET/PATCH/DELETE /api/projects/:slug/tasks/:id` (PATCH aceita `title, status, priority, labels, body, description, checklist, position, order`)
- `POST /api/projects/:slug/tasks/:id/notes` com `{ text }`
- `GET /api/projects/:slug/summary`: contagem por coluna, próximas tarefas de `todo` por prioridade e `warnings`
- `GET /api/events`: Server-Sent Events (`change` com `{ "project": "<slug>" }`)

## Formato dos arquivos

```
boards/
  <slug-do-projeto>/
    board.json      { "name": "...", "description": "...", "columns": ["backlog","todo","doing","review","done"], "nextId": 1 }
    tasks/
      T-001-titulo-em-kebab.md
```

```markdown
---
id: T-001
title: Título curto
status: todo            # deve ser uma das colunas do board
priority: medium        # low | medium | high
labels: [backend, ui]
order: 10               # posição dentro da coluna
created: 2026-09-30
updated: 2026-09-30
---
Descrição livre em Markdown.

## Checklist
- [ ] item 1
- [x] item 2

## Agent notes
(agentes anotam decisões e o que foi feito aqui)
```

- IDs sequenciais por projeto, nunca reutilizados, alocados com lock entre processos. O próximo ID é
  `max(nextId, maior ID encontrado em tasks/) + 1`, então um `board.json` defasado se corrige sozinho.
- O lock é um diretório `.vckb.lock/` no projeto. Se um processo morre segurando o lock, ele é
  recuperado na hora quando o PID não existe mais (mesma máquina), ou após 10 s sem heartbeat
  (ex.: um processo num container que compartilha o volume). Só apague à mão se nada estiver rodando.
- Toda escrita é atômica (arquivo temporário + rename). Só o frontmatter e a seção alterada mudam;
  o resto do corpo é preservado byte a byte, assim como campos desconhecidos do frontmatter.
- O frontmatter precisa ser YAML. Outras linguagens do gray-matter (ex.: `---js`) são rejeitadas de propósito.
- Os títulos `## Checklist` e `## Agent notes` fazem parte do formato. `## Notas do agente` também é aceito
  para as notas; o título que a tarefa já tiver é sempre preservado.

### Arquivos editados à mão

Agentes e pessoas podem criar ou editar os arquivos diretamente. O VCKB nunca deixa de listar o board
por causa disso: aplica valores padrão seguros e reporta cada problema como aviso (`warnings`):

| Problema | O que o VCKB faz |
|---|---|
| Sem `id` | Usa o prefixo `T-NNN` do nome do arquivo; senão, um ID provisório (o próximo livre), gravado na próxima escrita |
| Sem `title`, `priority`, `order`, `created`, `updated` | Título pelo nome do arquivo, `medium`, fim da coluna, data de modificação do arquivo |
| `status` fora das colunas (ou ausente) | Exibida na primeira coluna |
| Dois arquivos com o mesmo `id` | Os dois são listados; escritas por esse ID são recusadas até a correção |
| `order` repetida na coluna | Coluna renumerada (10, 20, 30…) na próxima vez que o servidor ou o CLI a reescrever |
| Arquivo ilegível (YAML inválido, sem frontmatter) | Ignorado e reportado; corrija à mão |

`vckb doctor <projeto>` lista esses problemas e o que mudaria, sem alterar nada.
`vckb doctor <projeto> --fix` grava os valores padrão, dá um ID novo aos duplicados (fica com o ID o
arquivo cujo nome bate com ele, ou então o mais antigo; o outro é renomeado), renumera as colunas
afetadas e ajusta o `nextId` para depois do maior ID.

## Protocolo para agentes

Copie o bloco do **[AGENT-PROTOCOL.md](AGENT-PROTOCOL.md)** (há versão em português no fim do arquivo)
para o `AGENTS.md` de cada projeto, substituindo `{{VCKB_BOARDS}}` e `{{PROJETO}}`. Em resumo:

1. Ler `<boards>/<projeto>/tasks/` antes de começar.
2. Pegar tarefas de `todo` por prioridade.
3. Mover para `doing` ao iniciar e para `review` ao terminar, **nunca para `done`**.
4. Marcar o checklist e registrar decisões em "Agent notes".
5. Criar em `backlog` o trabalho novo que descobrir.
6. Usar o CLI `vckb` ou editar os arquivos respeitando o formato.

## Modelo de segurança

O VCKB é uma **ferramenta local, de um único usuário**. Trate-o como um servidor de desenvolvimento, não como um SaaS.

- **Token.** Toda chamada exige `Authorization: Bearer <VCKB_TOKEN>`, comparado em tempo constante.
  O servidor não sobe sem um token de pelo menos 16 caracteres.
- **Só loopback por padrão.** O servidor escuta em `127.0.0.1`; o Docker publica a porta só em `127.0.0.1`.
- **CORS desligado por padrão.** Libere origens específicas com `VCKB_CORS_ORIGINS`.
- **Validação de entrada.** Slugs e IDs validados com regex estrita e checagem do caminho resolvido
  (sem path traversal), limite de tamanho das requisições, frontmatter só YAML (nada é executado).
- **Acesso remoto.** Para acessar de outro dispositivo, use uma rede privada como o
  [Tailscale](https://tailscale.com/) ou outra VPN. **Nunca exponha direto à internet**; se precisar,
  use um proxy reverso com TLS e autenticação adicional.
- **Os arquivos são entrada confiável.** Quem escreve no diretório de boards altera tarefas; isso é
  proposital. Proteja o diretório como protege seu código.

Achou uma vulnerabilidade? Veja o [SECURITY.md](SECURITY.md).

## Alternativas

Outras ferramentas do mesmo espaço que valem uma olhada:

- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)**: segundo o README, você planeja com
  issues num board kanban e roda agentes de código (Claude Code, Gemini CLI, Codex e outros) em
  workspaces; inicia com `npx vibe-kanban`.
- **[Backlog.md](https://github.com/MrLesk/Backlog.md)**: segundo o README, um gerenciador de
  tarefas e visualizador Kanban nativo em Markdown para qualquer repositório Git, em que cada
  tarefa é um arquivo `.md` no repositório; tem CLI, um board web local (`backlog browser`) e
  funciona com assistentes de IA compatíveis com MCP ou CLI.

A proposta do VCKB: um único diretório de boards para **vários** projetos, fora dos repositórios
deles, mais um pequeno protocolo de copiar e colar que funciona com qualquer agente.

## Desenvolvimento

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build
```

Veja o [CONTRIBUTING.md](CONTRIBUTING.md) e o [AGENTS.md](AGENTS.md) (regras para agentes de IA que trabalham neste repositório).

## Licença

[MIT](LICENSE) © 2026 Fellipe
