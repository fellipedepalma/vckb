import { parseArgs } from 'node:util';
import { VckbError } from '../core/errors.js';
import { resolveBoardsDir } from '../core/paths.js';
import { BoardStore, type Task } from '../core/store.js';
import type { Priority } from '../core/task-file.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const HELP = `vckb — kanban em arquivos Markdown

Uso:
  vckb projects
  vckb list <projeto> [--status todo] [--label ui]
  vckb show <projeto> T-001
  vckb add <projeto> "título" [--priority high] [--label ui --label api] [--status todo] [--description "..."]
  vckb move <projeto> T-001 doing
  vckb done <projeto> T-001
  vckb note <projeto> T-001 "texto"
  vckb next <projeto>

Opções globais:
  --dir <caminho>   diretório boards/ (padrão: $VCKB_BOARDS_DIR ou ./boards da instalação)
  --json            saída em JSON (para agentes/scripts)
  -h, --help        esta ajuda
`;

const PRIORITY_TAG: Record<Priority, string> = { high: 'alta', medium: 'média', low: 'baixa' };

function line(t: Task): string {
  const prog = t.progress.total ? `  (${t.progress.done}/${t.progress.total})` : '';
  const labels = t.labels.length ? `  ${t.labels.map((l) => `#${l}`).join(' ')}` : '';
  return `  ${t.id}  [${PRIORITY_TAG[t.priority]}]  ${t.title}${prog}${labels}`;
}

function detail(t: Task): string {
  return [
    `${t.id} — ${t.title}`,
    `status: ${t.status} · prioridade: ${PRIORITY_TAG[t.priority]} · labels: ${t.labels.join(', ') || '—'}`,
    `criada: ${t.created} · atualizada: ${t.updated} · arquivo: tasks/${t.file}`,
    '',
    t.body.trim(),
  ].join('\n');
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new VckbError('INVALID', `Faltou ${what}. Veja: vckb --help`);
  return v;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        status: { type: 'string' },
        label: { type: 'string', multiple: true },
        priority: { type: 'string' },
        description: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.err(`erro: ${(err as Error).message}\n`);
    return 2;
  }
  const { values: o, positionals } = parsed;
  const [cmd, project, a, b] = positionals;
  if (o.help || !cmd || cmd === 'help') {
    io.out(HELP);
    return 0;
  }

  const store = new BoardStore(resolveBoardsDir(o.dir));
  const json = (v: unknown) => io.out(`${JSON.stringify(v, null, 2)}\n`);

  try {
    switch (cmd) {
      case 'projects': {
        const projects = await store.listProjects();
        if (o.json) return json(projects), 0;
        if (!projects.length) io.out(`Nenhum projeto em ${store.root}\n`);
        for (const p of projects) io.out(`${p.slug}  —  ${p.name}${p.description ? `: ${p.description}` : ''}\n`);
        return 0;
      }
      case 'list': {
        const slug = need(project, '<projeto>');
        const label = o.label?.[0];
        const [board, tasks] = await Promise.all([
          store.getProject(slug),
          store.listTasks(slug, { status: o.status, label }),
        ]);
        if (o.json) return json(tasks), 0;
        const columns = o.status ? [o.status] : board.columns;
        for (const col of columns) {
          const inCol = tasks.filter((t) => t.status === col);
          io.out(`${col} (${inCol.length})\n`);
          for (const t of inCol) io.out(`${line(t)}\n`);
        }
        const orphan = tasks.filter((t) => !board.columns.includes(t.status));
        if (orphan.length && !o.status) {
          io.out(`? status desconhecido (${orphan.length})\n`);
          for (const t of orphan) io.out(`${line(t)}  → "${t.status}"\n`);
        }
        return 0;
      }
      case 'show': {
        const t = await store.getTask(need(project, '<projeto>'), need(a, '<id>'));
        if (o.json) return json(t), 0;
        io.out(`${detail(t)}\n`);
        return 0;
      }
      case 'add': {
        const t = await store.createTask(need(project, '<projeto>'), {
          title: need(a, '"título"'),
          priority: o.priority as Priority | undefined,
          labels: o.label,
          status: o.status,
          description: o.description,
        });
        if (o.json) return json(t), 0;
        io.out(`Criada ${t.id} em "${t.status}": ${t.title}\n`);
        return 0;
      }
      case 'move':
      case 'done': {
        const status = cmd === 'done' ? 'done' : need(b, '<status>');
        const t = await store.moveTask(need(project, '<projeto>'), need(a, '<id>'), status);
        if (o.json) return json(t), 0;
        io.out(`${t.id} → ${t.status}\n`);
        return 0;
      }
      case 'note': {
        const t = await store.addNote(need(project, '<projeto>'), need(a, '<id>'), need(b, '"texto"'));
        if (o.json) return json(t), 0;
        io.out(`Nota adicionada em ${t.id}\n`);
        return 0;
      }
      case 'next': {
        const t = await store.nextTask(need(project, '<projeto>'));
        if (o.json) return json(t), 0;
        io.out(t ? `${detail(t)}\n` : 'Nenhuma tarefa em "todo".\n');
        return 0;
      }
      default:
        io.err(`Comando desconhecido: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.err(`erro: ${(err as Error).message}\n`);
    return 1;
  }
}
