import { expect, it } from 'vitest';
import { resolveProjects, deriveDraftText, resolutionPayload } from './project-resolution.js';
import type { CatalogView } from './projects.js';
const catalog: CatalogView = { generation: 'g1', revision: 'r1', state: 'ready', projects: [
  { id: 'shop', name: 'shop', aliases: ['Storefront'] },
  { id: 'pay', name: 'payments-service', aliases: ['Payments'] },
  { id: 'api', name: 'shop-api', aliases: [] },
  { id: 'coffee', name: 'café', aliases: ['C++', 'a.b'] },
] };
it.each([
  ['[STOREFRONT] Checkout', 'Use payments-service', 'shop', ['pay']],
  ['Checkout', 'Use shop and Payments', null, ['shop', 'pay']],
  ['Checkout', 'workshop shop-api', null, ['api']],
  ['[shop] Checkout', 'shop shop Payments', 'shop', ['pay']],
  ['Checkout', 'cafe\u0301 C++ a.b', null, ['coffee']],
  ['Checkout', 'Do not use shop; `Payments`', null, ['shop', 'pay']],
  ['[ café ] Task', '', 'coffee', []],
])('resolves %s / %s', (title, description, targetId, referenceIds) => {
  const text = { title, description };
  const result = resolveProjects(text, catalog);
  expect(result).toMatchObject({ targetId, referenceIds, problems: [] });
  for (const match of result.matches) expect(match.text).toBe(text[match.field].slice(match.start, match.end));
});
it.each(['[missing] Task', '[] Task', '[shop Task', '[shop][pay] Task', '[shop] [pay] Task'])('blocks invalid target %s', title => {
  expect(resolveProjects({ title, description: 'Payments' }, catalog).problems.length).toBeGreaterThan(0);
});
it('requires ambiguous names to be resolved and rejects stale choices', () => {
  const ambiguous = { ...catalog, projects: [...catalog.projects, { id: 'other', name: 'other', aliases: ['Payments'] }] };
  const text = { title: 'Task', description: 'Payments' };
  const first = resolveProjects(text, ambiguous);
  expect(first.problems[0].code).toBe('ambiguous-name');
  const key = first.matches[0].key;
  expect(resolveProjects(text, ambiguous, { excludedReferenceIds: [], ambiguities: { [key]: 'pay' } })).toMatchObject({ referenceIds: ['pay'], problems: [] });
  expect(resolveProjects(text, ambiguous, { excludedReferenceIds: [], ambiguities: { stale: 'pay' } }).problems.some(p => p.code === 'invalid-choice')).toBe(true);
});
it('excludes references but never the target', () => {
  expect(resolveProjects({ title: '[shop] Task', description: 'Payments' }, catalog,
    { excludedReferenceIds: ['pay'], ambiguities: {} })).toMatchObject({ targetId: 'shop', referenceIds: [], problems: [] });
  expect(resolveProjects({ title: '[shop] Task', description: '' }, catalog,
    { excludedReferenceIds: ['shop'], ambiguities: {} }).problems[0].code).toBe('invalid-choice');
});
it('takes the longest overlapping phrase and distinguishes unavailable roots', () => {
  const c = { ...catalog, projects: [...catalog.projects, { id: 'long', name: 'shop platform', aliases: [] }] };
  expect(resolveProjects({ title: 'Task', description: 'shop platform' }, c).referenceIds).toEqual(['long']);
  expect(resolveProjects({ title: 'Task', description: 'shop' }, { ...catalog, state: 'unavailable' }).problems[0].code).toBe('root-unavailable');
});
it('derives titles without requiring frontmatter and uses stable choice ordering', () => {
  expect(deriveDraftText('\n# [shop] Task\n\nPayments', 'other.md')).toEqual({ title: '[shop] Task', description: '\nPayments' });
  expect(deriveDraftText('Details', '[shop] Task.md')).toEqual({ title: '[shop] Task', description: 'Details' });
  const d = { title: 'x', description: 'y' };
  expect(resolutionPayload(d, catalog, { excludedReferenceIds: ['a','b'], ambiguities: { z: 'a', x: 'b' } }))
    .toBe(resolutionPayload(d, catalog, { excludedReferenceIds: ['b','a'], ambiguities: { x: 'b', z: 'a' } }));
});
