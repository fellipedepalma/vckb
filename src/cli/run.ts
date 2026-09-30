import { parseArgs } from 'node:util';
import { VckbError } from '../core/errors.js';
import { resolveBoardsDir } from '../core/paths.js';
import { type BoardWarning, BoardStore, type DoctorReport, type Task } from '../core/store.js';
import type { Priority } from '../core/task-file.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const HELP = `vckb — Vibe Coding Kanban: a kanban made of Markdown files

Usage:
  vckb projects
  vckb list <project> [--status todo] [--label ui]
  vckb show <project> T-001
  vckb add <project> "title" [--priority high] [--label ui --label api] [--status todo] [--description "..."]
  vckb move <project> T-001 doing
  vckb done <project> T-001
  vckb note <project> T-001 "text"
  vckb next <project>
  vckb doctor <project> [--fix]     report hand-editing problems; --fix repairs them

Global options:
  --dir <path>   boards directory (default: $VCKB_BOARDS_DIR or ./boards in the install dir)
  --json         JSON output (for agents/scripts)
  -h, --help     this help
`;

function line(t: Task): string {
  const prog = t.progress.total ? `  (${t.progress.done}/${t.progress.total})` : '';
  const labels = t.labels.length ? `  ${t.labels.map((l) => `#${l}`).join(' ')}` : '';
  return `  ${t.id}  [${t.priority}]  ${t.title}${prog}${labels}`;
}

function detail(t: Task): string {
  return [
    `${t.id} — ${t.title}`,
    `status: ${t.status} · priority: ${t.priority} · labels: ${t.labels.join(', ') || '—'}`,
    `created: ${t.created} · updated: ${t.updated} · file: tasks/${t.file}`,
    '',
    t.body.trim(),
  ].join('\n');
}

function warningLines(warnings: BoardWarning[]): string {
  return warnings.map((w) => `warning: ${w.message}\n`).join('');
}

function doctorText(r: DoctorReport): string {
  const out: string[] = [];
  if (!r.warnings.length) return `${r.project}: no problems found.\n`;
  out.push(`${r.project}: ${r.warnings.length} problem(s)`);
  for (const w of r.warnings) out.push(`  - [${w.code}] ${w.message}`);
  const acts = [...r.actions.map((a) => `  ${a.file}${a.renameTo ? ` → ${a.renameTo}` : ''}: ${a.changes.join('; ')}`)];
  if (r.nextId) acts.push(`  board.json: nextId ${r.nextId.from} → ${r.nextId.to}`);
  if (acts.length) out.push('', r.fixed ? 'Fixed:' : 'Would fix (run with --fix):', ...acts);
  if (r.manual.length) out.push('', 'Needs manual fixing:', ...r.manual.map((w) => `  - ${w.message}`));
  if (r.remaining) out.push('', r.remaining.length ? `Remaining: ${r.remaining.length} problem(s)` : 'Board is clean now.');
  return `${out.join('\n')}\n`;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new VckbError('INVALID', `Missing ${what}. See: vckb --help`);
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
        fix: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.err(`error: ${(err as Error).message}\n`);
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
        if (!projects.length) io.out(`No projects in ${store.root}\n`);
        for (const p of projects) io.out(`${p.slug}  —  ${p.name}${p.description ? `: ${p.description}` : ''}\n`);
        return 0;
      }
      case 'list': {
        const slug = need(project, '<project>');
        const label = o.label?.[0];
        const [board, { tasks, warnings }] = await Promise.all([
          store.getProject(slug),
          store.scanTasks(slug, { status: o.status, label }),
        ]);
        if (o.json) return json({ tasks, warnings }), 0;
        const columns = o.status ? [o.status] : board.columns;
        for (const col of columns) {
          const inCol = tasks.filter((t) => t.status === col);
          io.out(`${col} (${inCol.length})\n`);
          for (const t of inCol) io.out(`${line(t)}\n`);
        }
        if (warnings.length) io.err(`${warningLines(warnings)}Run "vckb doctor ${slug}" for details.\n`);
        return 0;
      }
      case 'doctor': {
        const report = await store.doctor(need(project, '<project>'), { fix: o.fix });
        if (o.json) return json(report), 0;
        io.out(doctorText(report));
        return 0;
      }
      case 'show': {
        const t = await store.getTask(need(project, '<project>'), need(a, '<id>'));
        if (o.json) return json(t), 0;
        io.out(`${detail(t)}\n`);
        return 0;
      }
      case 'add': {
        const t = await store.createTask(need(project, '<project>'), {
          title: need(a, '"title"'),
          priority: o.priority as Priority | undefined,
          labels: o.label,
          status: o.status,
          description: o.description,
        });
        if (o.json) return json(t), 0;
        io.out(`Created ${t.id} in "${t.status}": ${t.title}\n`);
        return 0;
      }
      case 'move':
      case 'done': {
        const status = cmd === 'done' ? 'done' : need(b, '<status>');
        const t = await store.moveTask(need(project, '<project>'), need(a, '<id>'), status);
        if (o.json) return json(t), 0;
        io.out(`${t.id} → ${t.status}\n`);
        return 0;
      }
      case 'note': {
        const t = await store.addNote(need(project, '<project>'), need(a, '<id>'), need(b, '"text"'));
        if (o.json) return json(t), 0;
        io.out(`Note added to ${t.id}\n`);
        return 0;
      }
      case 'next': {
        const t = await store.nextTask(need(project, '<project>'));
        if (o.json) return json(t), 0;
        io.out(t ? `${detail(t)}\n` : 'No tasks in "todo".\n');
        return 0;
      }
      default:
        io.err(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}\n`);
    return 1;
  }
}
