// managed 模式：沿授权资源图完成“取得文件 -> 解释关系”两层接入。
// 两个阶段分别落盘，进程在边界终止后重开可识别待完成工作；
// 失败只记录待核对，不会删除已确认内容。

import { readFile } from 'node:fs/promises';
import { json, request } from './http.mjs';
import { buildResourceIndex, interpretEntry, diffInterpretations, constraintMap } from './schema.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

function nowStamp() {
  return new Date().toISOString();
}

function noteKey(note) {
  return [note.kind, JSON.stringify(note.location), note.reason, note.entry ?? ''].join('|');
}

async function addNote(repository, note) {
  const key = noteKey(note);
  const known = repository.snapshot().notes.some(existing => noteKey(existing) === key);
  if (!known) await repository.note({ at: nowStamp(), ...note });
}

// 阶段一：拉取目录并逐件取得原始字节。304 复用既有证据，503/404 显式登记。
export async function fetchCatalogPhase({ base, repository }) {
  const catalog = await json(base, fixture.entry);
  const previous = repository.snapshot().managed ?? { files: {} };
  const files = {};
  let fetched = 0;
  let reused = 0;
  let failures = 0;

  for (const descriptor of catalog.documents) {
    const prior = previous.files[descriptor.id];
    const headers = prior?.etag ? { 'if-none-match': prior.etag } : {};
    const response = await request(base, descriptor.href, { headers });
    const common = {
      id: descriptor.id,
      path: descriptor.path,
      href: descriptor.href,
      format: descriptor.format,
      revision: descriptor.revision,
      etag: response.headers.get('etag')
    };

    if (response.status === 304 && prior?.digest) {
      files[descriptor.id] = { ...prior, revision: descriptor.revision, fetchStatus: 304 };
      reused += 1;
      continue;
    }
    if (response.status === 503 || response.status === 404 || response.status >= 400) {
      files[descriptor.id] = {
        ...common,
        digest: prior?.digest ?? null,
        fetchStatus: response.status,
        fetchError: response.status === 404 ? 'not delivered' : 'temporarily unavailable',
        fetchedAt: nowStamp()
      };
      failures += 1;
      await addNote(repository, {
        kind: 'file-fetch-failed',
        entry: null,
        location: { document: descriptor.id, path: descriptor.path, href: descriptor.href },
        reason: files[descriptor.id].fetchError,
        detail: { status: response.status, revision: descriptor.revision }
      });
      continue;
    }
    if (!response.ok) throw new Error(`document status ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = await repository.retain(descriptor.path, bytes, {
      etag: response.headers.get('etag'),
      revision: descriptor.revision
    });
    let schema = null;
    let parseError = null;
    if (descriptor.format === 'json') {
      try {
        schema = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        parseError = error.message;
      }
    }
    files[descriptor.id] = {
      ...common,
      digest,
      fetchStatus: 200,
      parseError,
      bytes: bytes.length,
      fetchedAt: nowStamp()
    };
    if (parseError) {
      failures += 1;
      await addNote(repository, {
        kind: 'document-unparseable',
        entry: null,
        location: { document: descriptor.id, path: descriptor.path },
        reason: parseError
      });
    } else {
      fetched += 1;
    }
  }

  const plan = {
    catalogRevision: catalog.revision ?? null,
    canonicalResources: catalog.canonicalResources ?? {},
    files,
    previousFiles: previous.files ?? {},
    entries: previous.entries ?? [],
    phases: { ...previous.phases, catalog: { at: nowStamp(), done: true } },
    updatedAt: nowStamp()
  };
  await repository.saveManaged(plan);
  return { fetched, reused, failures, catalogRevision: plan.catalogRevision, priorPlan: previous };
}

// 从持久化证据重建可解释文档集合（阶段二在重开进程后也能独立运行）。
async function loadDocuments(repository) {
  const managed = repository.snapshot().managed;
  if (!managed) throw new Error('managed intake plan missing; run catalog phase first');
  const documents = [];
  for (const file of Object.values(managed.files)) {
    let schema = null;
    if (file.digest && !file.fetchError && !file.parseError) {
      const bytes = await repository.readEvidence(file.digest);
      if (file.format === 'json') {
        try {
          schema = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
          schema = null;
        }
      }
    }
    documents.push({
      id: file.id,
      path: file.path,
      href: file.href,
      revision: file.revision,
      digest: file.digest,
      etag: file.etag,
      schema,
      status: file.fetchStatus ?? null,
      fetchError: file.fetchError ?? (file.parseError ?? null)
    });
  }
  return { documents, managed };
}

function findEntryDocuments(documents) {
  const entries = [];
  for (const document of documents) {
    if (document.schema && Array.isArray(document.schema.entries)) {
      for (const item of document.schema.entries) {
        const target = documents.find(doc => doc.href === item.href || doc.path === item.href);
        entries.push({ id: item.id, documentId: target ? target.id : item.href, href: item.href, declaredBy: document.id });
      }
    }
  }
  return entries;
}

function closureDocuments(interpretation, index, entryDocumentId) {
  const ids = new Set([entryDocumentId]);
  for (const edge of interpretation.edges) ids.add(edge.to.document);
  // 待核对的缺件同样属于闭包，补件后必须触发重解释
  for (const item of interpretation.pending) {
    if (item.location?.document) ids.add(item.location.document);
  }
  return [...ids].sort();
}

function signatureFor(ids, documents) {
  const digestById = Object.fromEntries(documents.map(doc => [doc.id, `${doc.revision ?? 0}:${doc.digest ?? 'missing'}`]));
  return ids.map(id => `${id}=${digestById[id] ?? 'absent'}`).join('|');
}

// 阶段二：构建资源索引并逐入口解释，只重写签名变化的入口。
// priorPlan 为本轮拉取前已落盘的计划（进程内连续运行时由 fetch 阶段提供），
// 缺省时从当前计划无法区分新旧状态，恢复留痕仅在跨进程/显式传入时触发。
export async function interpretPhase({ repository, priorPlan = null }) {
  const { documents, managed } = await loadDocuments(repository);
  // 进程内连续运行用传入的 priorPlan；跨进程恢复时退回到计划中保存的 previousFiles。
  const priorFiles = priorPlan?.files ?? managed.previousFiles ?? {};
  // 目录授权映射给的是 path，资源索引按 document.id 工作，这里统一归一。
  const canonicalById = {};
  for (const [uri, pathOrId] of Object.entries(managed.canonicalResources ?? {})) {
    const match = documents.find(doc => doc.id === pathOrId || doc.path === pathOrId);
    if (match) canonicalById[uri] = match.id;
  }
  const index = buildResourceIndex(documents, canonicalById);
  const entries = findEntryDocuments(documents);
  const snapshot = repository.snapshot();
  let interpreted = 0;
  let skipped = 0;
  let pendingCount = 0;

  for (const resourceConflict of index.conflicts) {
    await addNote(repository, { kind: 'resource-conflict', entry: null, location: resourceConflict.location, reason: resourceConflict.reason, detail: resourceConflict.detail });
  }

  // 文件恢复（先前失败或缺件、本轮成功取得）时显式留痕，旧待核对项不被静默抹掉。
  for (const doc of documents) {
    const prior = priorFiles[doc.id];
    if (prior && (prior.fetchError || prior.parseError) && !doc.fetchError && doc.digest) {
      await addNote(repository, {
        kind: 'resource-recovered',
        entry: null,
        location: { document: doc.id, path: doc.path, href: doc.href },
        reason: `previously pending document delivered (was: ${prior.fetchError ?? prior.parseError})`,
        detail: { revision: doc.revision, digest: doc.digest }
      });
    }
  }

  for (const entry of entries) {
    const interpretation = interpretEntry(entry, index);
    const closure = closureDocuments(interpretation, index, entry.documentId);
    const signature = signatureFor(closure, documents);
    const previous = snapshot.records[entry.id];
    const sources = closure.map(id => {
      const doc = documents.find(item => item.id === id);
      return { document: id, path: doc?.path ?? null, href: doc?.href ?? null, revision: doc?.revision ?? null, digest: doc?.digest ?? null, etag: doc?.etag ?? null };
    });

    if (previous && previous.signature === signature) {
      skipped += 1;
      pendingCount += previous.pending?.length ?? 0;
      continue;
    }

    const history = [...(previous?.history ?? [])];
    if (previous) {
      history.push({
        at: nowStamp(),
        catalogRevision: managed.catalogRevision,
        signature: previous.signature,
        sources: previous.sources,
        mapping: constraintMap(previous),
        changes: diffInterpretations(
          { branches: previous.branches, properties: previous.properties, rootAnnotations: previous.rootAnnotations, dynamicTargets: previous.dynamicTargets, edges: previous.edges },
          { branches: interpretation.branches, properties: interpretation.properties, rootAnnotations: interpretation.rootAnnotations, dynamicTargets: interpretation.dynamicTargets, edges: interpretation.edges }
        )
      });
    }

    const record = {
      id: entry.id,
      mode: 'managed',
      entryId: entry.id,
      rootDocument: entry.documentId,
      status: interpretation.status,
      branches: interpretation.branches,
      properties: interpretation.properties,
      rootAnnotations: interpretation.rootAnnotations,
      dynamicTargets: interpretation.dynamicTargets,
      edges: interpretation.edges,
      pending: interpretation.pending,
      unknownVocabulary: interpretation.unknownVocabulary,
      preservedKeywords: interpretation.preservedKeywords,
      refChain: interpretation.refChain,
      sources,
      signature,
      history,
      catalogRevision: managed.catalogRevision,
      updatedAt: nowStamp()
    };
    await repository.put(record);
    interpreted += 1;
    pendingCount += interpretation.pending.length + interpretation.unknownVocabulary.length;

    for (const item of interpretation.pending) {
      await addNote(repository, { kind: item.kind, entry: entry.id, location: item.location, reason: item.reason, detail: item.detail ?? null });
    }
    for (const item of interpretation.unknownVocabulary) {
      await addNote(repository, { kind: 'unknown-vocabulary', entry: entry.id, location: item.location, reason: item.reason, detail: { keyword: item.keyword } });
    }
    if (previous && history.at(-1).changes.length > 0) {
      await addNote(repository, {
        kind: 'interpretation-revised',
        entry: entry.id,
        location: { document: entry.documentId },
        reason: 'source revision changed interpreted constraints; previous mapping retained in history',
        detail: { changedPaths: history.at(-1).changes.map(change => change.path) }
      });
    }
  }

  const fileFailures = documents.filter(doc => doc.fetchError || doc.parseError).length;
  const complete = entries.length > 0 && pendingCount === 0 && fileFailures === 0;
  await repository.saveManaged({
    ...managed,
    entries,
    phases: { ...managed.phases, interpretation: { at: nowStamp(), done: complete } },
    updatedAt: nowStamp()
  });
  await repository.cursor('managed', {
    catalogRevision: managed.catalogRevision,
    entries: entries.map(entry => entry.id),
    interpreted,
    skipped,
    pendingCount,
    complete,
    at: nowStamp()
  });
  return { imported: interpreted, skipped, complete, mode: 'managed', entries: entries.map(entry => entry.id), pendingCount };
}

export async function runManaged(options) {
  const fetchSummary = await fetchCatalogPhase(options);
  const { priorPlan, ...fetchCounters } = fetchSummary;
  const interpretSummary = await interpretPhase({ ...options, priorPlan });
  return { ...interpretSummary, fetch: fetchCounters };
}
