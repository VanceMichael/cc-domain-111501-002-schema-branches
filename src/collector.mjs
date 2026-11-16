import { readFile } from 'node:fs/promises';
import { json, request } from './http.mjs';
import { preview } from './preview.mjs';
import { fetchCatalogPhase, interpretPhase, runManaged } from './managed.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

// 默认旧预览模式保持不变；mode:'managed' 走结构化条件分支接入。
export async function collect(options) {
  if (options.mode === 'managed') return runManaged(options);
  return legacyCollect(options);
}

// 阶段入口单独导出，便于在阶段边界模拟进程终止后的恢复。
export const managed = { fetchCatalogPhase, interpretPhase };

async function legacyCollect({ base, repository }) {
  const catalog = await json(base, fixture.entry);
  const first = catalog.documents[0];
  const response = await request(base, first.href);
  if (!response.ok) throw new Error(`document status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = await repository.retain(first.path, bytes, { etag: response.headers.get('etag'), revision: first.revision });
  const result = preview(bytes.toString('utf8'), first.format);
  await repository.put({ id: first.id, path: first.path, ...result, digest });
  await repository.cursor('preview', { document: first.id, revision: first.revision });
  return { imported: 1, complete: false, mode: 'legacy' };
}
