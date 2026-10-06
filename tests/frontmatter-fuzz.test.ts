import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardStore } from '../src/core/store.js';
import { parseTaskFile, serializeTask } from '../src/core/task-file.js';
import { seeded, type Rng, YAML_TOKENS } from './seeded.js';

/**
 * Deterministic fuzzing of the task-file reader: valid files, mutated at random with a fixed seed.
 * Whatever the mutation, reading a file must end in a valid task or in an ordinary Error (which the
 * store reports as an invalid file), within 200 ms, and a task that was read must write and read back
 * the same. No exception of another kind, no hang.
 */

const SEED = 6102026;
const ITERATIONS = 5000;
const PER_CASE_MS = 200;

const SEEDS = [
  '---\nid: T-001\ntitle: Plain\nstatus: todo\npriority: high\nlabels: [a, b]\norder: 10\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\nBody text\n\n## Checklist\n\n- [x] done\n- [ ] todo\n\n## Agent notes\n\n- 2026-09-30: a note\n',
  '﻿---\r\nid: T-002\r\ntitle: "Quoted: \\"title\\" # not a comment"\r\nstatus: doing\r\npriority: low\r\nlabels: [x]\r\norder: 20\r\ncreated: 2026-09-30\r\nupdated: 2026-09-30\r\nowner: me\r\nmeta:\r\n  tags: [one, two]\r\n---\r\nWindows body\r\n\r\n---\r\n\r\nafter a rule\r\n',
  '---\nid: T-003\ntitle: Extras\nstatus: review\nextra:\n  - {a: 1, b: [2, 3]}\n  - plain\nnote: |\n  multi\n  line\n---\n',
  '---\n# only a comment\n---\nBody',
  '---yaml\nid: T-004\ntitle: Lang\nstatus: todo\n...\n---\nB\n',
];

const DELIMITERS = ['---', '--- ', '----', '...', '\n---\n', '\r\n---\r\n', '---js', '---\n---\n', '\n...\n'];
const BYTES = ['\u0000', '\u0001', '\u001b', '\u007f', '\u0085', ' ', '﻿', '\ud800', '\udfff', '\r', '\n', '\t', '"', "'", '\\', ':', '&a ', '*a', '!!js/function ', '<<: ', '[', '{', '| ', '> '];

function mutate(rng: Rng, text: string): string {
  let s = text;
  for (let n = 1 + rng.int(4); n > 0; n--) {
    const at = rng.int(s.length + 1);
    switch (rng.int(10)) {
      case 0:
        s = s.slice(0, at); // truncate
        break;
      case 1:
        s = s.slice(0, at) + rng.pick(BYTES) + s.slice(at); // insert a character
        break;
      case 2:
        s = s.slice(0, at) + rng.pick(DELIMITERS) + s.slice(at); // insert a delimiter
        break;
      case 3:
        s = s.replace(/---/, rng.pick(DELIMITERS)); // swap the first ---
        break;
      case 4: {
        const end = Math.min(s.length, at + 1 + rng.int(80));
        s = s.slice(0, end) + s.slice(at, end) + s.slice(end); // duplicate a block
        break;
      }
      case 5: {
        const lines = s.split('\n');
        for (let i = lines.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [lines[i], lines[j]] = [lines[j], lines[i]];
        }
        s = lines.join('\n'); // shuffle the lines
        break;
      }
      case 6:
        s = s.slice(0, at) + s.slice(at + 1 + rng.int(40)); // delete a stretch
        break;
      case 7:
        s = s.slice(0, at) + rng.pick(YAML_TOKENS) + s.slice(at);
        break;
      case 8: {
        const lines = s.split('\n');
        const i = rng.int(lines.length);
        lines.splice(i, 0, lines[rng.int(lines.length)]); // repeat a line (duplicate keys)
        s = lines.join('\n');
        break;
      }
      default:
        s = s.replace(/\r?\n/g, rng.pick(['\n', '\r\n', '\r'])); // change the line endings
    }
  }
  return s;
}

describe(`reader fuzzing (${ITERATIONS} seeded mutations)`, () => {
  it('always ends in a valid task or an ordinary error, quickly, and what is read writes back the same', () => {
    const rng = seeded(SEED);
    const started = performance.now();
    let valid = 0;
    let invalid = 0;
    let slowest = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const input = mutate(rng, rng.pick(SEEDS));
      const t0 = performance.now();
      let doc;
      try {
        doc = parseTaskFile(input).doc;
        valid++;
      } catch (err) {
        invalid++;
        expect(err, `case ${i}`).toBeInstanceOf(Error);
        expect((err as Error).message, `case ${i}`).toBeTruthy();
      }
      if (doc) {
        const written = serializeTask(doc);
        const back = parseTaskFile(written).doc;
        expect(back.title, `case ${i}`).toBe(doc.title);
        expect(back.status, `case ${i}`).toBe(doc.status);
        expect(back.labels, `case ${i}`).toEqual(doc.labels);
        expect(back.extra, `case ${i}`).toEqual(doc.extra);
        expect(back.body, `case ${i}`).toBe(doc.body);
        expect(serializeTask(back), `case ${i}`).toBe(written);
      }
      slowest = Math.max(slowest, performance.now() - t0);
    }
    expect(slowest, 'slowest case (ms)').toBeLessThan(PER_CASE_MS);
    expect(performance.now() - started, 'whole run (ms)').toBeLessThan(15_000);
    // Both outcomes really happen (a fuzzer that only produced one kind would prove little).
    expect(valid).toBeGreaterThan(ITERATIONS * 0.1);
    expect(invalid).toBeGreaterThan(ITERATIONS * 0.1);
  });

  it('the same files through the store: a task or an invalid_file warning, nothing thrown', async () => {
    const rng = seeded(SEED + 1);
    const dir = await mkdtemp(path.join(tmpdir(), 'vckb-fuzz-'));
    try {
      const store = new BoardStore(path.join(dir, 'boards'));
      await store.createProject({ name: 'App', slug: 'app' });
      const files = 300;
      for (let i = 0; i < files; i++) {
        await writeFile(path.join(dir, 'boards', 'app', 'tasks', `T-${String(i + 1).padStart(3, '0')}-fuzz.md`), mutate(rng, rng.pick(SEEDS)), 'utf8');
      }
      const t0 = performance.now();
      const { tasks, warnings } = await store.scanTasks('app');
      expect(performance.now() - t0).toBeLessThan(5000);
      const invalid = warnings.filter((w) => w.code === 'invalid_file').length;
      expect(tasks.length + invalid).toBe(files); // every file is one or the other
      expect(invalid).toBeGreaterThan(0);
      expect(tasks.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
