// 声明解释器：在“入口资源 + 授权资源图”的上下文内解释 JSON Schema 2020-12 片段。
// 只收集声明与引用语义，不做实例验证。所有解释结果均带资料位置（document/path），
// 无法解释的部分进入 pending，绝不以默认值或猜测补齐。

const ROOT_POINTER = '';

// 本 profile 识别的 2020-12 关键字全集。其中结构化解释的子集见下方三类容器；
// 其余标准关键字不实现其断言语义，原样登记到 preservedKeywords；
// 不在此集合内的一律视为未知词汇，进入 unknownVocabulary 待人工核对。
const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$dynamicRef', '$dynamicAnchor', '$anchor',
  '$vocabulary', '$defs', '$comment', '$recursiveAnchor', '$recursiveRef',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum',
  'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
  'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains',
  'maxProperties', 'minProperties', 'required',
  'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly',
  'examples', 'format',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'properties', 'patternProperties', 'additionalProperties',
  'items', 'additionalItems', 'contains', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'dependentSchemas',
  'dependentRequired', 'prefixItems'
]);

// 结构语义实际参与分支/引用解释的关键字，其余已知关键字只保留不解释。
const STRUCTURAL_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$dynamicRef', '$dynamicAnchor', '$anchor',
  '$vocabulary', '$defs', 'type', 'required', 'oneOf', 'anyOf', 'allOf',
  'not', 'if', 'then', 'else', 'properties', 'items', 'prefixItems',
  'unevaluatedProperties', 'unevaluatedItems'
]);

// 值本身即 schema（对象/布尔）的关键字
const SINGLE_SCHEMA_KEYWORDS = new Set([
  'not', 'if', 'then', 'else', 'additionalProperties', 'additionalItems',
  'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'
]);
// 值为 schema 数组的关键字
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
// 值为 name -> schema 的关键字
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPointer(base, token) {
  return base === '' ? '/' + escapeToken(token) : base + '/' + escapeToken(token);
}

function decodeToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

// 遍历一份文档内的全部 schema 子树（跳过非 schema 的普通数据节点）。
function walkSchemas(root, visit) {
  const stack = [{ schema: root, pointer: ROOT_POINTER }];
  while (stack.length) {
    const { schema, pointer } = stack.pop();
    visit(schema, pointer);
    if (!isObject(schema)) continue;
    for (const [keyword, value] of Object.entries(schema)) {
      if (SINGLE_SCHEMA_KEYWORDS.has(keyword)) {
        if (value !== undefined) stack.push({ schema: value, pointer: joinPointer(pointer, keyword) });
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        value.forEach((item, index) => stack.push({ schema: item, pointer: joinPointer(pointer, `${keyword}/${index}`) }));
      } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        for (const name of Object.keys(value)) {
          stack.push({ schema: value[name], pointer: joinPointer(pointer, joinPointer(keyword, name)) });
        }
      } else if (keyword === 'items' && (isObject(value) || typeof value === 'boolean')) {
        stack.push({ schema: value, pointer: joinPointer(pointer, keyword) });
      }
    }
  }
}

function readPointer(root, pointer) {
  if (pointer === '' || pointer === undefined) return root;
  if (pointer.startsWith('#')) pointer = pointer.slice(1);
  let current = root;
  for (const rawToken of pointer.split('/').slice(1)) {
    if (current === null || current === undefined) return undefined;
    current = current[decodeToken(rawToken)];
  }
  return current;
}

// 由授权目录与已取得文档构建资源索引。
// documents: [{ id, href, path, revision, schema|null, fetchError, status }]
// canonicalResources: 规范 $id -> document.id
export function buildResourceIndex(documents, canonicalResources = {}) {
  const byDocument = Object.create(null);
  const resources = new Map(); // resourceURI -> { document, pointer, anchor, dynamic, href }
  const anchors = new Map();   // `${document}#${name}` -> { resourceURI, pointer, dynamic }
  const pending = [];
  const conflicts = [];
  // 未领到文档已知的资源 URI：优先用历史声明 $id，其次用目录授权映射与 href 反推。
  const undeliveredUris = {};

  for (const document of documents) {
    byDocument[document.id] = document;
    if (!document.schema || document.fetchError) {
      pending.push({
        kind: 'resource-unavailable',
        location: { document: document.id, path: document.path ?? null, href: document.href ?? null, revision: document.revision ?? null },
        reason: document.fetchError ?? 'document not fetched',
        detail: { status: document.status ?? null }
      });
      const knownUris = [];
      if (document.declaredIds) knownUris.push(...document.declaredIds);
      for (const [uri, docId] of Object.entries(canonicalResources)) {
        if (docId === document.id) knownUris.push(uri);
      }
      if (knownUris.length) undeliveredUris[document.id] = knownUris[0];
      continue;
    }
    const rootId = isObject(document.schema) && typeof document.schema.$id === 'string'
      ? document.schema.$id : `urn:local:${document.id}`;
    const declare = (uri, pointer, anchor = null, dynamic = false) => {
      const existing = resources.get(uri);
      if (existing && existing.document !== document.id) {
        conflicts.push({
          kind: 'resource-conflict',
          resource: uri,
          location: { document: document.id, pointer },
          reason: `resource URI already declared by document ${existing.document}`,
          detail: { prior: { document: existing.document, pointer: existing.pointer } }
        });
      } else {
        resources.set(uri, { document: document.id, pointer, anchor, dynamic, href: document.href });
      }
    };
    declare(rootId, ROOT_POINTER);
    walkSchemas(document.schema, (schema, pointer) => {
      if (!isObject(schema)) return;
      if (typeof schema.$id === 'string' && pointer !== ROOT_POINTER) declare(schema.$id, pointer);
      if (typeof schema.$anchor === 'string') {
        const uri = rootId + '#' + schema.$anchor;
        anchors.set(`${document.id}#${schema.$anchor}`, { resourceURI: uri, pointer, dynamic: false });
        declare(uri, pointer, schema.$anchor, false);
      }
      if (typeof schema.$dynamicAnchor === 'string') {
        const uri = rootId + '#' + schema.$dynamicAnchor;
        anchors.set(`${document.id}#${schema.$dynamicAnchor}`, { resourceURI: uri, pointer, dynamic: true });
        declare(uri, pointer, schema.$dynamicAnchor, true);
      }
    });
  }

  for (const [resourceURI, documentId] of Object.entries(canonicalResources)) {
    if (!byDocument[documentId]) {
      pending.push({
        kind: 'resource-unavailable',
        location: { document: documentId },
        reason: 'authorized canonical resource has no catalog document',
        detail: { resource: resourceURI }
      });
    } else if (![...resources.keys()].some(uri => uri === resourceURI || uri.startsWith(resourceURI + '#'))) {
      pending.push({
        kind: 'resource-unavailable',
        location: { document: documentId },
        reason: 'authorized canonical resource never declared its $id',
        detail: { resource: resourceURI }
      });
    }
  }

  return { byDocument, resources, anchors, canonical: canonicalResources, undeliveredUris, pending: [...conflicts, ...pending], conflicts };
}

// 解析引用字符串 -> 资源索引目标。$dynamicRef 的解析依赖入口动态作用域，
// 因此同一引用字符串在不同入口下可能得到不同目标，绝不跨入口共用结果。
function resolveReference(ref, originDocument, index, dynamicScope = []) {
  if (typeof ref !== 'string') return null;
  const hashAt = ref.indexOf('#');
  const basePart = hashAt === -1 ? ref : ref.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : ref.slice(hashAt + 1);

  if (basePart === '' && fragment) {
    const dynamicOwner = dynamicScope.find(docId => index.anchors.get(`${docId}#${fragment}`)?.dynamic);
    if (dynamicOwner) {
      const anchor = index.anchors.get(`${dynamicOwner}#${fragment}`);
      return { document: dynamicOwner, pointer: anchor.pointer, resourceURI: anchor.resourceURI, dynamic: fragment };
    }
  }

  if (basePart === '') {
    const origin = index.byDocument[originDocument];
    if (!origin) return null;
    const rootId = origin.schema && isObject(origin.schema) && origin.schema.$id ? origin.schema.$id : `urn:local:${originDocument}`;
    if (fragment === '') return { document: originDocument, pointer: ROOT_POINTER, resourceURI: rootId };
    const anchored = index.anchors.get(`${originDocument}#${fragment}`);
    if (anchored) return { document: originDocument, pointer: anchored.pointer, resourceURI: anchored.resourceURI };
    if (fragment.startsWith('/')) return { document: originDocument, pointer: fragment, resourceURI: `${rootId}#${fragment}` };
    return { document: originDocument, pointer: null, missingAnchor: fragment };
  }

  const resourceURI = fragment ? `${basePart}#${fragment}` : basePart;
  const direct = index.resources.get(resourceURI);
  if (direct) return { document: direct.document, pointer: direct.pointer, resourceURI };
  const baseResource = index.resources.get(basePart);
  if (baseResource) {
    if (fragment === '') return { document: baseResource.document, pointer: baseResource.pointer, resourceURI: basePart };
    if (fragment.startsWith('/')) return { document: baseResource.document, pointer: fragment, resourceURI };
    const anchored = index.anchors.get(`${baseResource.document}#${fragment}`);
    if (anchored) return { document: baseResource.document, pointer: anchored.pointer, resourceURI: anchored.resourceURI };
    return { document: baseResource.document, pointer: null, missingAnchor: fragment };
  }
  // 资源不在已声明索引中：区分“授权目录里有、但还没领到”与“根本未授权”。
  const authorizedDocument = index.canonical[basePart]
    ?? Object.keys(index.byDocument).find(docId => index.undeliveredUris[docId] === basePart);
  const authorized = authorizedDocument && index.byDocument[authorizedDocument];
  if (authorized && (authorized.fetchError || !authorized.schema)) {
    return { document: authorizedDocument, pointer: null, undelivered: true, resourceURI: basePart };
  }
  return null;
}

// 沿 $ref 求有效根（2020-12 允许 $ref 与同级关键字并存），返回目标 schema、
// 经过的引用链以及入口节点自身保留的同级关键字。跨文档链上后续引用按
// 当前所在文档解析，不能一律按入口文档解析。
function effectiveRoot(schema, originDocument, index) {
  const chain = [];
  const seen = new Set();
  let current = schema;
  let currentDocument = originDocument;
  let ownKeywords = {};
  while (isObject(current) && typeof current.$ref === 'string') {
    const key = currentDocument + '#' + current.$ref;
    if (seen.has(key)) break;
    seen.add(key);
    if (chain.length === 0) {
      ownKeywords = Object.fromEntries(Object.entries(current).filter(([keyword]) => keyword !== '$ref'));
    }
    const target = resolveReference(current.$ref, currentDocument, index);
    if (!target || target.pointer === null) break;
    const document = index.byDocument[target.document];
    const next = document?.schema ? readPointer(document.schema, target.pointer) : undefined;
    if (next === undefined) break;
    chain.push({ ref: current.$ref, document: target.document, pointer: target.pointer });
    current = next;
    currentDocument = target.document;
  }
  return { schema: current, chain, ownKeywords };
}

// 提取字段约束形状，所有位置都带 provenance。$ref 属性会展开到目标约束，
// 并保留引用边信息，避免把引用字段误报成无约束。
function constraintShape(schema, documentId, pointer, index = null, depth = 0) {
  if (!isObject(schema)) return { kind: typeof schema === 'boolean' ? 'boolean-schema' : 'unknown', provenance: { document: documentId, pointer } };
  const shape = { provenance: { document: documentId, pointer } };
  if (typeof schema.$ref === 'string' && index && depth < 8) {
    const target = resolveReference(schema.$ref, documentId, index);
    if (target && target.pointer !== null && !target.undelivered) {
      const targetDocument = index.byDocument[target.document];
      const targetSchema = targetDocument?.schema ? readPointer(targetDocument.schema, target.pointer) : undefined;
      if (targetSchema !== undefined) {
        shape.ref = { to: target.document, pointer: target.pointer, resource: target.resourceURI ?? null };
        Object.assign(shape, constraintShape(targetSchema, target.document, target.pointer, index, depth + 1));
        shape.provenance = { document: documentId, pointer };
      }
    }
  }
  for (const keyword of ['type', 'enum', 'const', 'format', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']) {
    if (keyword in schema) shape[keyword] = structuredClone(schema[keyword]);
  }
  if (Array.isArray(schema.required)) shape.required = [...schema.required];
  if (isObject(schema.properties)) {
    shape.properties = {};
    for (const [name, sub] of Object.entries(schema.properties)) {
      shape.properties[name] = constraintShape(sub, documentId, joinPointer(pointer, `properties/${escapeToken(name)}`), index, depth);
    }
  }
  return shape;
}

function branchProperties(schema, documentId, pointer, index = null) {
  if (!isObject(schema) || !isObject(schema.properties)) return {};
  const properties = {};
  for (const [name, sub] of Object.entries(schema.properties)) {
    properties[name] = constraintShape(sub, documentId, joinPointer(pointer, `properties/${escapeToken(name)}`), index);
  }
  return properties;
}

function collectBranches(rootSchema, originDocument, index) {
  const { schema, chain, ownKeywords } = effectiveRoot(rootSchema, originDocument, index);
  const requiredBase = [];
  if (isObject(rootSchema) && Array.isArray(rootSchema.required)) requiredBase.push(...rootSchema.required);
  for (const link of chain) {
    const document = index.byDocument[link.document];
    const node = document?.schema ? readPointer(document.schema, link.pointer) : undefined;
    if (isObject(node) && Array.isArray(node.required)) requiredBase.push(...node.required);
  }
  if (!isObject(schema) || !Array.isArray(schema.oneOf)) {
    // 根为纯 $ref 且解析目标不带 oneOf 时，分支约束来自被引用资源本身，
    // 其字段来源必须标注到目标文档而不是入口文档。
    const targetDoc = chain.length ? chain[chain.length - 1].document : originDocument;
    const targetPointer = chain.length ? chain[chain.length - 1].pointer : ROOT_POINTER;
    return {
      branches: [{
        index: 0,
        required: [...new Set(requiredBase)],
        properties: branchProperties(schema, targetDoc, targetPointer, index),
        source: { document: targetDoc, pointer: targetPointer }
      }],
      refChain: chain,
      ownKeywords,
      effectiveSchema: schema
    };
  }
  // oneOf 所在文档即有效根文档（可能是 $ref 链的末端）。
  const branchDoc = chain.length ? chain[chain.length - 1].document : originDocument;
  return {
    branches: schema.oneOf.map((branch, branchIndex) => ({
      index: branchIndex,
      required: [...new Set([...requiredBase, ...(Array.isArray(branch.required) ? branch.required : [])])],
      properties: branchProperties(branch, branchDoc, `/oneOf/${branchIndex}`, index),
      source: { document: branchDoc, pointer: `/oneOf/${branchIndex}` }
    })),
    refChain: chain,
    ownKeywords,
    effectiveSchema: schema
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter(edge => !seen.has(edge.id) && seen.add(edge.id));
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => !seen.has(JSON.stringify(item)) && seen.add(JSON.stringify(item)));
}

// 入口解释。entry = { id, documentId }。动态锚点目标、边、待核对项均按
// 本次入口上下文独立计算；同一 $dynamicRef 在不同入口下不得共用解析结果。
export function interpretEntry(entry, index) {
  const entryDocument = index.byDocument[entry.documentId];
  if (!entryDocument || !entryDocument.schema || entryDocument.fetchError) {
    return {
      id: entry.id,
      rootDocument: entry.documentId,
      status: 'pending',
      branches: [],
      properties: {},
      rootAnnotations: {},
      dynamicTargets: {},
      edges: [],
      pending: [{
        kind: 'resource-unavailable',
        location: { document: entry.documentId, path: entryDocument?.path ?? null, href: entryDocument?.href ?? null },
        reason: entryDocument?.fetchError ?? 'entry document not delivered',
        detail: { status: entryDocument?.status ?? null }
      }],
      unknownVocabulary: [],
      preservedKeywords: [],
      refChain: []
    };
  }

  const pending = [];
  const edges = [];
  const preservedKeywords = [];
  const unknownVocabulary = [];
  const dynamicTargets = {};
  const { branches, refChain, ownKeywords, effectiveSchema } = collectBranches(entryDocument.schema, entry.documentId, index);
  // 根资源自身的属性约束（不属于某个 oneOf 分支），单独保留并标注来源。
  const rootDocForProperties = refChain.length ? refChain[refChain.length - 1].document : entry.documentId;
  const rootPointerForProperties = refChain.length ? refChain[refChain.length - 1].pointer : ROOT_POINTER;
  const rootProperties = isObject(effectiveSchema)
    ? branchProperties(effectiveSchema, rootDocForProperties, rootPointerForProperties, index)
    : {};

  // 动态作用域：入口文档优先，沿 $ref 首次到达的文档依次入列。
  const dynamicScope = [entry.documentId];
  const scopeSeen = new Set([entry.documentId]);
  const visited = new Set();
  const stack = [{ documentId: entry.documentId, schema: entryDocument.schema, pointer: ROOT_POINTER }];

  const followRef = (ref, kind, documentId, refPointer) => {
    const target = resolveReference(ref, documentId, index, dynamicScope);
    if (!target) {
      pending.push({ kind: 'reference-unresolved', location: { document: documentId, pointer: refPointer }, reason: 'referenced resource is not among authorized source documents', detail: { ref } });
      return;
    }
    if (target.undelivered) {
      const undeliveredDocument = index.byDocument[target.document];
      pending.push({
        kind: 'resource-unavailable',
        location: { document: target.document, path: undeliveredDocument?.path ?? null, href: undeliveredDocument?.href ?? null },
        reason: undeliveredDocument?.fetchError ?? 'authorized document has not been delivered yet',
        detail: { ref, status: undeliveredDocument?.status ?? null }
      });
      return;
    }
    if (target.pointer === null) {
      pending.push({ kind: 'reference-unresolved', location: { document: documentId, pointer: refPointer }, reason: `anchor '${target.missingAnchor}' is not declared`, detail: { ref } });
      return;
    }
    if (target.dynamic) {
      dynamicTargets[target.dynamic] = target.document === entry.documentId
        ? entry.id
        : { entry: entry.id, document: target.document, pointer: target.pointer, anchor: target.dynamic };
    }
    edges.push({
      id: `${documentId}${refPointer}->${target.document}${target.pointer}`,
      kind,
      ref,
      from: { document: documentId, pointer: refPointer },
      to: { document: target.document, pointer: target.pointer, resource: target.resourceURI ?? null },
      contextEntry: entry.id,
      dynamicAnchor: target.dynamic ?? null
    });
    const targetDocument = index.byDocument[target.document];
    if (!targetDocument?.schema) {
      pending.push({ kind: 'resource-unavailable', location: { document: target.document, path: targetDocument?.path ?? null }, reason: 'referenced document has not been delivered yet', detail: { ref } });
      return;
    }
    if (kind === 'ref' && !scopeSeen.has(target.document)) {
      scopeSeen.add(target.document);
      dynamicScope.push(target.document);
    }
    const targetSchema = readPointer(targetDocument.schema, target.pointer);
    if (targetSchema !== undefined) stack.push({ documentId: target.document, schema: targetSchema, pointer: target.pointer });
  };

  while (stack.length) {
    const { documentId, schema, pointer } = stack.pop();
    if (!isObject(schema)) continue;
    const nodeKey = documentId + pointer;
    if (visited.has(nodeKey)) continue;
    visited.add(nodeKey);

    for (const keyword of Object.keys(schema)) {
      if (!KNOWN_KEYWORDS.has(keyword)) {
        unknownVocabulary.push({ keyword, location: { document: documentId, pointer }, reason: 'keyword outside the supported JSON Schema 2020-12 profile' });
      } else if (!STRUCTURAL_KEYWORDS.has(keyword)) {
        preservedKeywords.push({ keyword, location: { document: documentId, pointer } });
      }
    }
    if (typeof schema.$schema === 'string' && !schema.$schema.includes('draft/2020-12')) {
      unknownVocabulary.push({ keyword: '$schema', location: { document: documentId, pointer }, reason: `unsupported schema dialect ${schema.$schema}` });
    }
    if (isObject(schema.$vocabulary)) {
      for (const uri of Object.keys(schema.$vocabulary)) {
        if (!uri.includes('json-schema.org/2020-12')) {
          unknownVocabulary.push({ keyword: '$vocabulary', location: { document: documentId, pointer }, reason: `unknown vocabulary declaration ${uri}` });
        }
      }
    }

    if (typeof schema.$ref === 'string') followRef(schema.$ref, 'ref', documentId, joinPointer(pointer, '$ref'));
    if (typeof schema.$dynamicRef === 'string') followRef(schema.$dynamicRef, 'dynamicRef', documentId, joinPointer(pointer, '$dynamicRef'));

    for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
      if (isObject(schema[keyword])) stack.push({ documentId, schema: schema[keyword], pointer: joinPointer(pointer, keyword) });
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      if (Array.isArray(schema[keyword])) {
        schema[keyword].forEach((item, i) => stack.push({ documentId, schema: item, pointer: joinPointer(pointer, `${keyword}/${i}`) }));
      }
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      if (isObject(schema[keyword])) {
        for (const name of Object.keys(schema[keyword])) {
          stack.push({ documentId, schema: schema[keyword][name], pointer: joinPointer(pointer, joinPointer(keyword, name)) });
        }
      }
    }
    if (isObject(schema.items) || typeof schema.items === 'boolean') {
      stack.push({ documentId, schema: schema.items, pointer: joinPointer(pointer, 'items') });
    }
  }

  const reachableDocuments = new Set([entry.documentId, ...edges.map(edge => edge.to.document)]);
  const scopedIndexPending = index.pending.filter(item => reachableDocuments.has(item.location?.document));
  const allPending = dedupeItems([...scopedIndexPending, ...pending]);
  const status = allPending.length === 0 && unknownVocabulary.length === 0 ? 'interpreted' : 'pending-review';

  return {
    id: entry.id,
    rootDocument: entry.documentId,
    status,
    branches,
    properties: rootProperties,
    rootAnnotations: ownKeywords,
    dynamicTargets,
    edges: dedupeEdges(edges),
    pending: allPending,
    unknownVocabulary: dedupeItems(unknownVocabulary),
    preservedKeywords: dedupeItems(preservedKeywords),
    refChain
  };
}

// 修订留痕：对比两份解释，返回叶子级变化路径，旧表单映射可据此说明依据变化。
export function diffInterpretations(previous, current) {
  const changes = [];
  const walk = (a, b, path) => {
    if (Object.is(a, b)) return;
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) walk(a[i], b[i], `${path}[${i}]`);
    } else {
      changes.push({ path, before: a ?? null, after: b ?? null });
    }
  };
  walk(previous, current, '');
  return changes;
}

// 录入人员的字段约束视图：保留 branchIndex 与来源，互斥分支的 required 不合并。
export function constraintMap(interpretation) {
  const rows = [];
  // 根资源自身字段不属于任何互斥分支，单独列出。
  for (const [name, constraint] of Object.entries(interpretation.properties ?? {})) {
    rows.push({
      entry: interpretation.id,
      branchIndex: null,
      field: name,
      required: false,
      constraint,
      source: constraint?.provenance ?? null
    });
  }
  for (const branch of interpretation.branches) {
    for (const [name, constraint] of Object.entries(branch.properties ?? {})) {
      rows.push({
        entry: interpretation.id,
        branchIndex: branch.index,
        field: name,
        required: (branch.required ?? []).includes(name),
        constraint,
        source: constraint?.provenance ?? branch.source
      });
    }
    for (const requiredName of branch.required ?? []) {
      if (!branch.properties || !(requiredName in branch.properties)) {
        rows.push({ entry: interpretation.id, branchIndex: branch.index, field: requiredName, required: true, constraint: { declared: true }, source: branch.source });
      }
    }
  }
  return rows;
}
