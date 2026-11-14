# 表单接口声明的条件分支与动态引用采集接入约定

## 来源获取

获授权供应方网关 `/schemas` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

源目录提供规范$id到本地href的授权映射；https://forms.local是逻辑资源名，不允许出网读取。入口index.json定义两种表单实例，输出id=base:node和strict:node。基础node有两个oneOf分支，不可把两者required合并。strict通过$ref扩展node并建立同名dynamicAnchor；基础children中的$dynamicRef在base入口指向base:node，在strict入口的动态求值范围内指向strict:node。输出保留branches（两项）、required（各分支内部）及dynamicTargets.node（上下文入口ID），递归以边表示而非无限复制。这里只收集声明与引用语义，不实现JSON实例验证器，未知vocabulary不假定已支持。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：node中name字段类型由string变为integer，两入口均受影响，但动态目标仍各自绑定。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置和未决原因。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 验证矩阵

1. 按样本跨文件完成 资源ID与锚点获取 与 条件分支保真，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. 动态引用上下文 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 递归依赖和变更影响 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`仅覆盖关键正例及重启重投，改动时需按以上矩阵增加适合方案的异常和来源变化测试。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
