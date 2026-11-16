// 分阶段采集进程：用独立 Node 进程跑单一阶段并退出，
// 模拟“原始资料已保存、关系尚未提交”边界上的进程终止。
// 用法：node scripts/phase-runner.mjs <base> <repoDir> catalog|interpret
import { Repository } from '../src/repository.mjs';
import { fetchCatalogPhase, interpretPhase } from '../src/managed.mjs';

const [, , base, directory, phase] = process.argv;
if (!base || !directory || !['catalog', 'interpret'].includes(phase)) {
  console.error('usage: phase-runner.mjs <base> <repoDir> catalog|interpret');
  process.exit(2);
}

const repository = await new Repository(directory).open();
try {
  const summary = phase === 'catalog'
    ? await fetchCatalogPhase({ base, repository })
    : await interpretPhase({ repository });
  console.log(JSON.stringify({ phase, summary, state: repository.snapshot().managed }));
} catch (error) {
  console.log(JSON.stringify({ phase, error: error.message, state: repository.snapshot().managed }));
  process.exitCode = 1;
}
