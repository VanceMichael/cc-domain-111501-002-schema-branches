import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';
import { constraintMap } from '../src/schema.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();
  const result = await collect({ base: source.base, repository, mode: 'managed' });
  const records = repository.records();
  console.log(JSON.stringify({
    result,
    constraintViews: Object.fromEntries(records.map(record => [record.id, constraintMap(record)])),
    dynamicTargets: Object.fromEntries(records.map(record => [record.id, record.dynamicTargets])),
    edges: records.flatMap(record => record.edges.map(edge => ({ entry: record.id, ...edge }))),
    pending: records.flatMap(record => record.pending.map(item => ({ entry: record.id, ...item }))),
    requests: source.requests
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
