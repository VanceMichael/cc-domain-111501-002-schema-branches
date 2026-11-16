import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';

async function session(run) {
  const directory = await mkdtemp(join(tmpdir(), 'source-changes-'));
  const source = await createSource({ scenario: 'feature' });
  try {
    await run(source, await new Repository(directory).open(), directory);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('temporarily failed document yields explicit pending review without losing other records', async () => {
  await session(async source => {
    source.state.failDoc = 'node';
    const directory = await mkdtemp(join(tmpdir(), 'fail-node-'));
    try {
      const repository = await new Repository(directory).open();
      const summary = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(summary.complete, false);
      const records = repository.records();
      const ids = records.map(record => record.id).sort();
      assert.deepEqual(ids, ['base:node', 'strict:node']);
      for (const record of records) {
        assert.notEqual(record.status, 'interpreted');
        assert.ok(record.pending.some(item =>
          (item.kind === 'resource-unavailable' || item.kind === 'reference-unresolved') &&
          JSON.stringify(item.location).includes('node')));
      }
      const note = repository.snapshot().notes.find(item => item.kind === 'file-fetch-failed');
      assert.ok(note);
      assert.equal(note.location.path, 'node.json');
      assert.equal(note.detail.status, 503);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('missing document is recorded as undelivered, then backfill re-interprets only affected entries', async () => {
  await session(async source => {
    source.state.missingDoc = 'node';
    const directory = await mkdtemp(join(tmpdir(), 'missing-node-'));
    try {
      const repository = await new Repository(directory).open();
      const first = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(first.complete, false);
      assert.ok(first.pendingCount > 0);

      source.state.missingDoc = null;
      const second = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(second.complete, true);
      // 补件后两个入口都重解释，但没有产生重复身份或额外记录。
      assert.equal(second.imported, 2);
      const records = repository.records();
      assert.deepEqual(records.map(record => record.id).sort(), ['base:node', 'strict:node']);
      assert.ok(records.every(record => record.status === 'interpreted'));
      for (const record of records) {
        assert.ok(record.sources.some(sourceRef => sourceRef.document === 'node' && sourceRef.digest));
      }
      const recoveredNote = repository.snapshot().notes.find(note => note.kind === 'resource-recovered' && note.location.document === 'node');
      assert.ok(recoveredNote, 'backfill must leave an explicit recovery trace');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('revision round 2 changes the shared constraint for both entries but keeps dynamic targets context-bound', async () => {
  await session(async source => {
    const directory = await mkdtemp(join(tmpdir(), 'revision-'));
    try {
      const repository = await new Repository(directory).open();
      await collect({ base: source.base, repository, mode: 'managed' });
      const before = Object.fromEntries(repository.records().map(record => [record.id, record]));
      assert.equal(before['base:node'].properties.name.type, 'string');
      const beforeSignatures = Object.fromEntries(Object.entries(before).map(([id, record]) => [id, record.signature]));

      source.state.round = 2;
      const revised = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(revised.imported, 2, 'both entries depend on node and must be re-interpreted');
      const after = Object.fromEntries(repository.records().map(record => [record.id, record]));
      assert.equal(after['base:node'].properties.name.type, 'integer');
      assert.equal(after['strict:node'].properties.name.type, 'integer');
      assert.notEqual(after['base:node'].signature, beforeSignatures['base:node']);
      // 动态目标仍各自绑定入口，不随修订串台。
      assert.equal(after['base:node'].dynamicTargets.node, 'base:node');
      assert.equal(after['strict:node'].dynamicTargets.node, 'strict:node');

      for (const record of Object.values(after)) {
        assert.equal(record.history.length, 1, 'old mapping must remain readable as history');
        const historical = record.history[0];
        assert.ok(historical.mapping.length > 0);
        assert.ok(historical.changes.some(change => change.path === 'properties.name.type'));
        assert.ok(historical.sources.every(sourceRef => sourceRef.digest));
      }
      const revisionNote = repository.snapshot().notes.find(note => note.kind === 'interpretation-revised');
      assert.ok(revisionNote);
      assert.ok(revisionNote.detail.changedPaths.includes('properties.name.type'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('unchanged re-delivery uses conditional requests and does not rebuild stable records', async () => {
  await session(async source => {
    const directory = await mkdtemp(join(tmpdir(), 'stable-'));
    try {
      const repository = await new Repository(directory).open();
      const first = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(first.imported, 2);
      const evidenceCount = Object.keys(repository.snapshot().evidence).length;
      const second = await collect({ base: source.base, repository, mode: 'managed' });
      assert.equal(second.imported, 0);
      assert.equal(second.skipped, 2);
      assert.equal(Object.keys(repository.snapshot().evidence).length, evidenceCount, 'no duplicate raw evidence');
      // 第二次拉取全部命中条件请求：计划中每件文件记录为 304 复用。
      const files = Object.values(repository.snapshot().managed.files);
      assert.ok(files.length >= 3);
      assert.ok(files.every(file => file.fetchStatus === 304));
      assert.equal(second.fetch.reused, files.length);
      assert.equal(second.fetch.fetched, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
