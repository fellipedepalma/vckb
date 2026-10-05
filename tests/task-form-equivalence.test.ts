import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/store.js';
import { FORM_LIMITS, toFormValues, validateForm } from '../web/src/task-form.js';
import { apiSetup } from './api-helpers.js';

/**
 * The details form checks title, labels and description before sending a request. Its limits and
 * label rule are copies of the server's (web/src/task-form.ts is self-contained); this runs both
 * against the real API so they cannot drift apart.
 */
const columns = ['backlog', 'todo', 'doing', 'review', 'done'];
const form = (over: { title?: string; labels?: string; description?: string }) => ({
  ...toFormValues({ title: 'T', status: 'todo', priority: 'medium', labels: [], description: '' }),
  ...over,
});

describe('task form vs the server', () => {
  it('limits are the same numbers', () => {
    expect(FORM_LIMITS.title).toBe(LIMITS.title);
    expect(FORM_LIMITS.description).toBe(LIMITS.body);
    expect(FORM_LIMITS.labels).toBe(LIMITS.labels);
  });

  it('what the form accepts the PATCH accepts, and what it refuses the PATCH refuses', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'App', slug: 'app' });
    await req('POST', '/api/projects/app/tasks', { title: 'First' });

    const patch = async (body: unknown) => (await req('PATCH', '/api/projects/app/tasks/T-001', body)).status;
    const labelsOf = (text: string) => text.split(',').map((l) => l.trim()).filter(Boolean);

    const titles = ['ok', ' padded ', 'x'.repeat(200), 'x'.repeat(201), 'a\nb', '   ', 'é'.repeat(200)];
    for (const title of titles) {
      const clientOk = !validateForm(form({ title }), columns).title;
      // The form sends the trimmed title (a line break inside it stays and is refused by both).
      expect((await patch({ title: title.trim() })) === 200, `title ${JSON.stringify(title.slice(0, 20))}`).toBe(clientOk);
    }

    const labelSets = ['ui', 'a1', 'v1.2', 'a_b-c', 'Ünï', '9lives', 'x'.repeat(32), 'x'.repeat(33), '-ui', '.x', '_x', 'a/b', '#tag', 'ok, ok', 'ok, -bad'];
    for (const labels of labelSets) {
      const clientOk = !validateForm(form({ labels }), columns).labels;
      expect((await patch({ labels: [...new Set(labelsOf(labels))] })) === 200, `labels ${labels}`).toBe(clientOk);
    }
    const many = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join(',');
    for (const n of [20, 21]) {
      const clientOk = !validateForm(form({ labels: many(n) }), columns).labels;
      expect((await patch({ labels: labelsOf(many(n)) })) === 200, `${n} labels`).toBe(clientOk);
    }

    // The server limit is on the whole body (description + checklist + notes + a newline), so the form
    // only refuses what can never fit; a description right at the limit is left to the server's 400.
    for (const length of [LIMITS.body - 1_000, LIMITS.body + 1]) {
      const description = 'x'.repeat(length);
      const clientOk = !validateForm(form({ description }), columns).description;
      expect((await patch({ description })) === 200, `description ${length}`).toBe(clientOk);
    }
  });
});
