# 表单接口声明的条件分支与动态引用采集

Node.js 22.23.4 ESM 资料接入服务。默认旧预览模式提供单文件预览、原始字节留存和重复导入；`mode:'managed'`沿授权资源图完成结构化接入：保留`oneOf`条件分支（不合并互斥`required`）、资源标识与递归引用边，并按入口上下文解析`$dynamicRef`。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test覆盖旧版预览、来源HTTP缓存与故障响应、存储重开，以及声明解释器的分支保真、按入口动态解析、递归边、未知词汇和未决引用。acceptance在真实回环HTTP来源上验证缺件/临时失败、修订留痕、条件请求复用与进程终止恢复。demo当场创建空目录并启动真实回环HTTP服务、调用采集器后打印字段约束视图、动态目标、引用边和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态（取得文件与解释关系两层均无未决），不可由HTTP200或预览成功推断。managed内部拆成`fetchCatalogPhase`（取目录、留存原始字节）与`interpretPhase`（构建资源索引并逐入口解释），两阶段各自落盘，`scripts/phase-runner.mjs`可作为独立进程单跑一阶段，用于演示边界终止后的恢复。`Repository`中的records、evidence、cursors、notes是现有持久化接口，并新增managed计划与按摘要读回证据；旧记录和原始字节继续可读。

## 解释语义（managed）

- **条件分支**：根`oneOf`的每个分支单独保留`branches[].required`与分支内属性约束，互斥字段不会被拍平成一张清单；根资源自身字段放在记录的`properties`，字段约束视图用`branchIndex:null`与分支字段区分。
- **动态锚点**：同一`$dynamicRef:'#node'`在`base:node`入口解析到`base:node`、在`strict:node`入口解析到`strict:node`。解析始终携带入口动态作用域，绝不按引用字符串跨入口共用结果。
- **资源标识与递归**：保留文档`$id`、`$anchor`、`$dynamicAnchor`与授权映射；引用以带`from/to/contextEntry`的边表示，递归回边不复制节点。跨文档`$ref`链按当前所在文档继续解析。
- **待核对**：未领到或临时失败的授权资源、指向未授权资源或未声明锚点的引用、未知词汇分别进入记录的`pending`/`unknownVocabulary`与仓库`notes`，并附具体资料位置（document、JSON Pointer、href）；已知但本服务不实现断言的标准关键字登记在`preservedKeywords`，不假定已支持。
- **修订**：来源修订后只重解释依赖闭包签名变化的入口；旧字段映射、来源摘要与叶子级变化路径保存在记录`history`，旧表单映射仍能说明依据。补件会写`resource-recovered`留痕，失败不会使已确认内容消失。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开，覆盖协议验证矩阵：跨文件资源与条件分支保真、重复投递与重开身份不膨胀、缺件/失败的显式未决与补件后选择性重解释、round=2修订的递归依赖留痕，以及在“原始资料已保存、关系尚未提交”边界终止进程后的恢复。断言不固定输出样本答案，也不让原始证据与规范化结果错位；资料未齐时保留可解释未决，不为“通过”填充不存在的源值。

## 离线容器

```sh
docker build --pull=false -t schema-branches:local .
docker run --rm --network none schema-branches:local npm test
docker run --rm --network none schema-branches:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
