import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, '..', 'scripts', 'phase-runner.mjs');

function runPhase(base, directory, phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, base, directory, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (code !== 0) reject(new Error(`phase ${phase} exited ${code}: ${stderr || stdout}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

async function withSource(run) {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-'));
  const source = await createSource({ scenario: 'feature' });
  try {
    await run(source, directory);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('process ending after catalog phase leaves resumable work and no fake records', async () => {
  await withSource(async (source, directory) => {
    const catalog = await runPhase(source.base, directory, 'catalog');
    assert.equal(catalog.phase, 'catalog');
    assert.equal(catalog.summary.failures, 0);

    // 独立重开进程验证持久化状态：原始字节已在，解释记录尚不存在。
    const reopened = await new Repository(directory).open();
    const snapshot = reopened.snapshot();
    assert.equal(reopened.records().length, 0);
    const rawFiles = await readdir(join(directory, 'raw'));
    assert.equal(rawFiles.length, 3, 'all raw evidence retained before interpretation');
    assert.equal(snapshot.managed.phases.catalog.done, true);
    assert.equal(snapshot.managed.phases.interpretation, undefined);

    // 新进程只跑解释阶段即可补齐，不重新依赖前一进程内存。
    const interpretation = await runPhase(source.base, directory, 'interpret');
    assert.equal(interpretation.summary.complete, true);
    const finalRepo = await new Repository(directory).open();
    assert.deepEqual(finalRepo.records().map(record => record.id).sort(), ['base:node', 'strict:node']);
    // 证据摘要与记录中声明的来源一致，没有错位。
    for (const record of finalRepo.records()) {
      for (const sourceRef of record.sources) {
        if (sourceRef.digest) assert.ok((await readFile(join(directory, 'raw', sourceRef.digest))).length > 0);
      }
    }
  });
});

test('restart while a document is unavailable keeps pending state until backfill arrives', async () => {
  await withSource(async (source, directory) => {
    source.state.failDoc = 'node';
    await runPhase(source.base, directory, 'catalog');
    const first = await runPhase(source.base, directory, 'interpret');
    assert.equal(first.summary.complete, false);
    assert.ok(first.summary.pendingCount > 0);

    // 重启后失败仍在，待核对状态不能被默认值掩盖。
    const stillPending = await runPhase(source.base, directory, 'interpret');
    assert.equal(stillPending.summary.complete, false);

    source.state.failDoc = null;
    const recovered = await runPhase(source.base, directory, 'catalog');
    assert.equal(recovered.summary.failures, 0);
    const completed = await runPhase(source.base, directory, 'interpret');
    assert.equal(completed.summary.complete, true);
    const repo = await new Repository(directory).open();
    assert.ok(repo.records().every(record => record.status === 'interpreted'));
  });
});
