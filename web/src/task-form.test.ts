import { describe, expect, it } from 'vitest';
import { diffForm, fieldOfServerError, FORM_LIMITS, isDirty, parseLabels, toFormValues, validateForm } from './task-form';

const columns = ['backlog', 'todo', 'doing', 'review', 'done'];
const task = { title: 'Sync list', status: 'todo', priority: 'high', labels: ['backend', 'api'], description: 'Replace localStorage.' };
const values = (over: Partial<ReturnType<typeof toFormValues>> = {}) => ({ ...toFormValues(task), ...over });

describe('parseLabels', () => {
  it('splits on commas, trims, drops empties and duplicates (first one wins)', () => {
    expect(parseLabels('ui, forms,, ui ,  , api')).toEqual(['ui', 'forms', 'api']);
    expect(parseLabels('')).toEqual([]);
    expect(parseLabels(' , ,')).toEqual([]);
  });
  it('keeps case: labels are case sensitive, like the server', () => {
    expect(parseLabels('UI, ui')).toEqual(['UI', 'ui']);
  });
});

describe('diffForm', () => {
  it('is empty when nothing changed', () => {
    expect(diffForm(task, values())).toEqual({});
    expect(isDirty(task, values())).toBe(false);
  });
  it('contains only the fields that changed', () => {
    expect(diffForm(task, values({ title: 'New title' }))).toEqual({ title: 'New title' });
    expect(diffForm(task, values({ priority: 'low' }))).toEqual({ priority: 'low' });
    expect(diffForm(task, values({ status: 'doing' }))).toEqual({ status: 'doing' });
    expect(diffForm(task, values({ labels: 'backend, api, x' }))).toEqual({ labels: ['backend', 'api', 'x'] });
    expect(diffForm(task, values({ description: 'Other' }))).toEqual({ description: 'Other' });
    expect(diffForm(task, values({ title: 'T', priority: 'low' }))).toEqual({ title: 'T', priority: 'low' });
  });
  it('never sends body, checklist or position', () => {
    const patch = diffForm(task, { title: 'a', status: 'done', priority: 'low', labels: 'x', description: 'd' });
    expect(Object.keys(patch).sort()).toEqual(['description', 'labels', 'priority', 'status', 'title']);
  });
  it('trims the title and the description before comparing and sending', () => {
    expect(diffForm(task, values({ title: '  Sync list  ' }))).toEqual({});
    expect(diffForm(task, values({ title: '  Renamed ' }))).toEqual({ title: 'Renamed' });
    expect(diffForm(task, values({ description: '\n Replace localStorage. \n' }))).toEqual({});
    expect(diffForm(task, values({ description: '  Hello \n' }))).toEqual({ description: 'Hello' });
  });
  it('can clear the description', () => {
    expect(diffForm(task, values({ description: '   ' }))).toEqual({ description: '' });
  });
  it('labels: separators, duplicates and empties are no change when the list is the same', () => {
    expect(diffForm(task, values({ labels: 'backend,api' }))).toEqual({});
    expect(diffForm(task, values({ labels: ' backend , api , backend,' }))).toEqual({});
    expect(diffForm(task, values({ labels: 'api, backend' }))).toEqual({ labels: ['api', 'backend'] }); // order is data
    expect(diffForm(task, values({ labels: '' }))).toEqual({ labels: [] });
  });
});

describe('validateForm', () => {
  it('accepts the unchanged task', () => {
    expect(validateForm(values(), columns)).toEqual({});
  });
  it('title: required, no line breaks, same limit as the server', () => {
    expect(validateForm(values({ title: '   ' }), columns).title).toEqual({ kind: 'required' });
    expect(validateForm(values({ title: '' }), columns).title).toEqual({ kind: 'required' });
    expect(validateForm(values({ title: 'a\nb' }), columns).title).toEqual({ kind: 'lineBreak' });
    expect(validateForm(values({ title: 'x'.repeat(FORM_LIMITS.title) }), columns).title).toBeUndefined();
    expect(validateForm(values({ title: 'x'.repeat(FORM_LIMITS.title + 1) }), columns).title).toEqual({ kind: 'tooLong', max: 200 });
    // Only the trimmed title counts, as on the server.
    expect(validateForm(values({ title: ` ${'x'.repeat(FORM_LIMITS.title)} ` }), columns).title).toBeUndefined();
  });
  it('labels: the server label rule and at most 20', () => {
    for (const ok of ['ui', 'a1', 'v1.2', 'a_b-c', 'Ünï', '9lives', 'x'.repeat(32)]) {
      expect(validateForm(values({ labels: ok }), columns).labels, ok).toBeUndefined();
    }
    for (const bad of ['-ui', '.x', '_x', 'a/b', 'x'.repeat(33), '#tag']) {
      expect(validateForm(values({ labels: `ok, ${bad}` }), columns).labels, bad).toEqual({ kind: 'badLabel', label: bad });
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`).join(',');
    expect(validateForm(values({ labels: twenty }), columns).labels).toBeUndefined();
    expect(validateForm(values({ labels: `${twenty},l20` }), columns).labels).toEqual({ kind: 'tooManyLabels', max: 20 });
    // Duplicates collapse before counting, so 21 entries with a repeat are fine.
    expect(validateForm(values({ labels: `${twenty},l0` }), columns).labels).toBeUndefined();
  });
  it('status and priority must be known values', () => {
    expect(validateForm(values({ status: 'nope' }), columns).status).toEqual({ kind: 'unknownValue' });
    expect(validateForm(values({ priority: 'urgent' }), columns).priority).toEqual({ kind: 'unknownValue' });
  });
  it('description: at most the server body limit', () => {
    expect(validateForm(values({ description: 'x'.repeat(FORM_LIMITS.description) }), columns).description).toBeUndefined();
    expect(validateForm(values({ description: 'x'.repeat(FORM_LIMITS.description + 1) }), columns).description).toEqual({
      kind: 'tooLong',
      max: 100_000,
    });
  });
});

describe('fieldOfServerError', () => {
  it('maps the 400 messages of the server to a field', () => {
    expect(fieldOfServerError('"title" is required')).toBe('title');
    expect(fieldOfServerError('"title" exceeds 200 characters')).toBe('title');
    expect(fieldOfServerError('"description" exceeds 100000 characters')).toBe('description');
    expect(fieldOfServerError('body exceeds 100000 characters')).toBe('description');
    expect(fieldOfServerError('invalid label: "a b"')).toBe('labels');
    expect(fieldOfServerError('at most 20 labels')).toBe('labels');
    expect(fieldOfServerError('"priority" must be low | medium | high')).toBe('priority');
    expect(fieldOfServerError('invalid status: "x". Columns: todo')).toBe('status');
    expect(fieldOfServerError('nothing to update')).toBeNull();
  });
});
