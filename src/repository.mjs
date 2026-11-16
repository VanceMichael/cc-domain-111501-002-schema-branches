import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [], managed: { files: {}, entries: [], phases: {} } };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // 旧存储没有 managed 计划时补齐空结构，旧记录与原始字节继续可读。
    this.state.managed ??= { files: {}, entries: [], phases: {} };
    this.state.notes ??= [];
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  // 同一内容只留存一份：已存在的 digest 直接复用，不产生重复原始证据。
  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!this.state.evidence[digest]) {
      await writeFile(join(this.directory, 'raw', digest), bytes);
      this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
      await this.save();
    }
    return digest;
  }

  // 按证据摘要读回原始字节，供重开进程后重建解释。
  async readEvidence(digest) {
    return readFile(join(this.directory, 'raw', digest));
  }

  // managed 接入计划（目录、取得状态、阶段进度），与记录分开持久化，
  // 使“原始资料已保存、关系尚未提交”的中断可被重开识别。
  async saveManaged(plan) {
    this.state.managed = structuredClone(plan);
    await this.save();
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push(structuredClone(value));
    await this.save();
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
