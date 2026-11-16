import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResourceIndex, interpretEntry, constraintMap, diffInterpretations } from '../src/schema.mjs';

function document(id, schema, extra = {}) {
  return { id, path: `${id}.json`, href: `/raw/${id}.json`, revision: 1, schema, fetchError: null, ...extra };
}

const nodeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forms.local/node',
  $dynamicAnchor: 'node',
  type: 'object',
  properties: {
    name: { type: 'string' },
    children: { type: 'array', items: { $dynamicRef: '#node' } }
  },
  oneOf: [
    { required: ['person'], properties: { person: { type: 'string' } } },
    { required: ['organization'], properties: { organization: { type: 'string' } } }
  ]
};
const strictSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forms.local/strict',
  $dynamicAnchor: 'node',
  $ref: 'https://forms.local/node',
  unevaluatedProperties: false
};

function featureIndex(overrides = []) {
  const docs = [
    document('entry', { entries: [{ id: 'base:node', href: 'node.json' }, { id: 'strict:node', href: 'strict.json' }] }),
    document('node', nodeSchema),
    document('strict', strictSchema),
    ...overrides
  ];
  return buildResourceIndex(docs, { 'https://forms.local/node': 'node', 'https://forms.local/strict': 'strict' });
}

test('oneOf branches keep mutually exclusive required fields instead of merging them', () => {
  const interpretation = interpretEntry({ id: 'base:node', documentId: 'node' }, featureIndex());
  assert.equal(interpretation.branches.length, 2);
  assert.deepEqual(interpretation.branches.map(branch => branch.required), [['person'], ['organization']]);
  const rows = constraintMap(interpretation);
  assert.ok(rows.every(row => row.branchIndex === 0 ? row.field !== 'organization' : row.field !== 'person'));
  assert.ok(rows.every(row => row.source.document === 'node' && typeof row.source.pointer === 'string'));
});

test('the same dynamic anchor resolves per entry context, never by shared ref string', () => {
  const index = featureIndex();
  const base = interpretEntry({ id: 'base:node', documentId: 'node' }, index);
  const strict = interpretEntry({ id: 'strict:node', documentId: 'strict' }, index);
  assert.equal(base.dynamicTargets.node, 'base:node');
  assert.equal(strict.dynamicTargets.node, 'strict:node');
  const strictDynamicEdge = strict.edges.find(edge => edge.kind === 'dynamicRef');
  assert.equal(strictDynamicEdge.to.document, 'strict');
  const baseDynamicEdge = base.edges.find(edge => edge.kind === 'dynamicRef');
  assert.equal(baseDynamicEdge.to.document, 'node');
  // 两个入口都保留两条 oneOf 分支，strict 经 $ref 继承 node 的分支。
  assert.equal(strict.branches.length, 2);
  assert.deepEqual(strict.branches.map(branch => branch.required), [['person'], ['organization']]);
  assert.equal(strict.rootAnnotations.unevaluatedProperties, false);
});

test('recursive relationships are represented as edges, not duplicated nodes', () => {
  const interpretation = interpretEntry({ id: 'base:node', documentId: 'node' }, featureIndex());
  const dynamicEdges = interpretation.edges.filter(edge => edge.kind === 'dynamicRef');
  assert.equal(dynamicEdges.length, 1);
  assert.equal(dynamicEdges[0].from.pointer, '/properties~1children/items/$dynamicRef');
  assert.equal(dynamicEdges[0].to.pointer, '');
  assert.equal(dynamicEdges[0].contextEntry, 'base:node');
  // 边去重：递归回边不会因为再次访问而膨胀。
  assert.equal(new Set(interpretation.edges.map(edge => edge.id)).size, interpretation.edges.length);
});

test('unknown vocabulary is explicitly flagged for review and blocks interpreted status', () => {
  const exotic = document('exotic', {
    $id: 'https://forms.local/exotic',
    type: 'object',
    properties: { code: { type: 'string', minLength: 2, 'x-special-policy': { locked: true } } }
  });
  const index = featureIndex([exotic]);
  const interpretation = interpretEntry({ id: 'exotic:entry', documentId: 'exotic' }, index);
  const flagged = interpretation.unknownVocabulary.find(item => item.keyword === 'x-special-policy');
  assert.ok(flagged, 'unknown keyword must be reported');
  assert.equal(flagged.location.document, 'exotic');
  assert.equal(interpretation.status, 'pending-review');
  // 已知但本服务不实现断言的关键字只保留，不算未知词汇。
  const preserved = interpretation.preservedKeywords.find(item => item.keyword === 'minLength');
  assert.ok(preserved);
  assert.equal(preserved.location.document, 'exotic');
  assert.ok(!interpretation.unknownVocabulary.some(item => item.keyword === 'minLength'));
});

test('unsupported dialect declarations are treated as unknown vocabulary', () => {
  const dialect = document('dialect', { $schema: 'https://example.test/draft-99/schema', type: 'string' });
  const index = featureIndex([dialect]);
  const interpretation = interpretEntry({ id: 'dialect:entry', documentId: 'dialect' }, index);
  assert.ok(interpretation.unknownVocabulary.some(item => item.keyword === '$schema' && item.reason.includes('unsupported')));
});

test('a reference to a non-authorized resource stays pending with its concrete location', () => {
  const broken = document('broken', {
    $id: 'https://forms.local/broken',
    type: 'object',
    properties: { external: { $ref: 'https://elsewhere.test/schema#thing' } }
  });
  const index = featureIndex([broken]);
  const interpretation = interpretEntry({ id: 'broken:entry', documentId: 'broken' }, index);
  const item = interpretation.pending.find(pending => pending.kind === 'reference-unresolved');
  assert.ok(item);
  assert.equal(item.location.document, 'broken');
  assert.equal(item.detail.ref, 'https://elsewhere.test/schema#thing');
  assert.notEqual(interpretation.status, 'interpreted');
});

test('an undeclared local anchor is reported rather than guessed', () => {
  const broken = document('broken-anchor', {
    $id: 'https://forms.local/broken-anchor',
    type: 'object',
    properties: { child: { $ref: '#missing' } }
  });
  const index = featureIndex([broken]);
  const interpretation = interpretEntry({ id: 'broken-anchor:entry', documentId: 'broken-anchor' }, index);
  assert.ok(interpretation.pending.some(item => item.kind === 'reference-unresolved' && item.reason.includes('missing')));
});

test('an undelivered referenced document is an explicit pending resource, not a fake interpretation', () => {
  const docs = [
    document('entry', { entries: [{ id: 'base:node', href: 'node.json' }] }),
    document('node', nodeSchema, { schema: null, fetchError: 'not delivered', status: 404 })
  ];
  const index = buildResourceIndex(docs, {});
  const interpretation = interpretEntry({ id: 'base:node', documentId: 'node' }, index);
  assert.equal(interpretation.status, 'pending');
  assert.deepEqual(interpretation.branches, []);
  assert.equal(interpretation.pending[0].kind, 'resource-unavailable');
  assert.equal(interpretation.pending[0].location.document, 'node');
});

test('a ref chain crossing documents resolves later local refs against the current document', () => {
  // B 内部再用本地片段引用自身 $defs，入口 A 只引用 B 根。
  const bSchema = {
    $id: 'https://forms.local/chain-b',
    type: 'object',
    $defs: { piece: { type: 'object', properties: { deep: { type: 'number' } } } },
    properties: { linked: { $ref: '#/$defs/piece' } }
  };
  const aSchema = {
    $id: 'https://forms.local/chain-a',
    $ref: 'https://forms.local/chain-b',
    unevaluatedProperties: false
  };
  const docs = [
    document('entry', { entries: [{ id: 'chain:entry', href: 'a.json' }] }),
    document('a', aSchema),
    document('b', bSchema)
  ];
  const index = buildResourceIndex(docs, { 'https://forms.local/chain-a': 'a', 'https://forms.local/chain-b': 'b' });
  const interpretation = interpretEntry({ id: 'chain:entry', documentId: 'a' }, index);
  assert.equal(interpretation.status, 'interpreted');
  assert.equal(interpretation.properties.linked.provenance.document, 'b');
  assert.equal(interpretation.properties.linked.properties.deep.type, 'number');
  assert.ok(interpretation.edges.some(edge => edge.from.document === 'b' && edge.to.document === 'b'));
});

test('revision diff isolates the changed constraint leaf', () => {  const before = interpretEntry({ id: 'base:node', documentId: 'node' }, featureIndex());
  const revisedSchema = structuredClone(nodeSchema);
  revisedSchema.properties.name = { type: 'integer' };
  const after = interpretEntry({ id: 'base:node', documentId: 'node' },
    buildResourceIndex([
      document('entry', { entries: [{ id: 'base:node', href: 'node.json' }] }),
      document('node', revisedSchema),
      document('strict', strictSchema)
    ], {}));
  const changes = diffInterpretations(
    { branches: before.branches, properties: before.properties, dynamicTargets: before.dynamicTargets },
    { branches: after.branches, properties: after.properties, dynamicTargets: after.dynamicTargets }
  );
  const typeChange = changes.find(change => change.path === 'properties.name.type');
  assert.ok(typeChange);
  assert.equal(typeChange.before, 'string');
  assert.equal(typeChange.after, 'integer');
  assert.equal(after.properties.name.type, 'integer');
  assert.equal(before.properties.name.type, 'string');
});
