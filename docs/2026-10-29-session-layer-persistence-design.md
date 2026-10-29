# dsh-prompt-library 0.2 设计档：会话系统层持久化

> 三句话：把每个会话的 1~3 条系统层写进**这个会话自己的文件夹**，本插件只负责这一处的读写，不与其他插件耦合；重启和刷新后按需读回，不再靠一次后台扫描；任何读失败先试备份/兜底，都失败才按“没有这个文件”的原始会话回退（不抛错、不写盘），单会话新增开销不超过 100ms。
>
> 文档关系：本档是 0.1 设计档（[design.md](design.md)）的增量，覆盖其中 §2 非目标、§5.3、§6.2、§9、§12.3 的持久化语义。实施完成后，0.1 文档里的旧结论会按 §10.5 回写；在此之前，0.1 文档描述的是 0.1 行为。

## 1. 背景与问题

### 1.1 现象

- 重启 DSH：输入框上方的系统层标签和系统提示词里的层一起消失。
- 只刷新页面：标签消失，但宿主进程里的层还在；下一次组装系统提示词时，层仍然生效。
- 用户要求层文件放在会话自己的文件夹里，而不是插件的全局目录；本插件只负责这个位置的读写，不与其他插件约定。

### 1.2 根因与证据

| 现象 | 结构性根因 | 证据（2026-10-29 as-of） |
| --- | --- | --- |
| 重启后层消失 | 层只存在进程内存的 Map 里，从不写盘；系统提示词段每次从这张 Map 读 | src/host/layers.ts:40-41 明确写 “process memory, never persisted”；src/host/layers.ts:98-102 的 add 只改内存；src/index.ts:87-96 的段直接读注册表；0.1 需求/设计也把它写成非目标（docs/requirements.md:25、docs/requirements.md:59、docs/requirements.md:71、docs/design.md:37、docs/design.md:145-148、docs/design.md:318） |
| 刷新后标签消失（宿主仍有层） | 标签的恢复只有一条触发链：远程挂载完成后扫一遍会话列表、以及会话列表变化时再扫。标签组件本身只订阅 store，不主动读；扫的时机错过且之后没有列表变化时，store 一直空着 | 恢复链：src/client/index.ts:185-196、src/client/index.ts:206-210、src/client/index.ts:316-343、src/client/index.ts:369-380；标签只订阅：src/client/chips.ts:17-20；dock 注入只给 store 和动作：src/client/index.ts:383-397；平台的会话列表是异步快照（dsh-client-ui-session/lib/client.js:808-818 用 list.subscribe） |

**诚实边界**：用户那次刷新的控制台日志没有被采集，所以不能把“具体哪一次时序错过了”钉死。可以确定的是代码里只有一条恢复链、标签自己不读；本设计用“标签挂载即读 + 并发去重”消除对那条链的依赖，而不是押注某一次竞态。

### 1.3 平台事实与约束

以下事实来自 DSH 0.2.1-rc.3 源码（as-of 2026-10-29），实施时如果平台升级，需要重新核对：

1. **会话目录是给会话本地产物用的**：平台把每个会话的目录描述为 “The directory owned by one session and available for future session-local artifacts”（会话拥有的目录，留给将来的会话本地产物使用）。见 dsh-session-persistence-jsonl/lib/index.js:912-922。
2. **平台扫描会话目录只认日志文件名**：目录扫描只识别 session.v版本.jsonl.zstd 这类代际日志，不认识的文件跳过；不会因为多一个文件报错。见 dsh-session-persistence-jsonl/lib/index.js:3411-3443。
3. **会话对象能拿到 id 和 cwd**：Session 的 header 是公开字段，id 由 header 派生（dsh-session/lib/types/index.js:406-430）。本设计只需要 id，不需要 cwd。
4. **客户端会话列表是异步快照**：dsh-client-ui-session/lib/client.js:808-818 用 list.subscribe 驱动 UI；本插件不能假设“页面加载时列表已经就绪”。
5. **dock 插槽的 inject 收到 sessionId**：平台 queue dock 在 conversation.input.dock 上注册 inject: (sessionId) => ...（dsh-client-ui-conversation/lib/client.js:17267-17274，as-of 2026-10-29），且该槽声明为 scope: "session"（同文件:19939-19941）。本插件按同一签名取会话 id；若未来签名变化，备选取 id 的路径是 trigger source 的 session.sessionId 或 slots binding。

### 1.4 为什么不用其他存法

- **放插件全局目录**：最简单，但用户明确要求放在会话自己的文件夹；放在插件目录会让文件脱离会话目录。
- **放会话目录的子目录**：路径多一层，读写和排查都更绕；顶层文件已经够用。
- **写进会话日志的事件**：要解码 zstd、受日志格式版本和压缩/合并影响，还会把插件状态混进聊天记录；侵入性远大于收益。
- **用平台通用存储/数据库**：多一个依赖，且它和“会话目录”没有天然绑定；本插件其余数据本来就是文件，一致性和可检查性都更好。

## 2. 目标与非目标

### 目标

- 每个会话的层写进该会话自己的文件夹；本插件只负责这个位置的读写和删除。
- 重启后第一次使用会话时自动读回，注入与标签同时恢复。
- 刷新后标签自己发起读取，不再依赖一次后台扫描。
- 写盘成功才更新内存与界面；失败明确报错。
- 单文件损坏、目录缺失、超大、不可读、写盘失败都有确定行为，不阻塞启动。
- 读失败先试备份/兜底；都失败才按“没有这个持久化文件”的原始会话回退：不抛错、不写盘、不影响会话和侧边栏。
- 单会话首次读取新增耗时 p95 ≤ 100ms、典型 ≤ 20ms；不扫描全部会话；超大文件不读取解析。
- 不改变最多 3 条、同 id 更新、顺序、token、菜单、设置页、编辑弹窗。

### 非目标

- 不做全局常驻注入；没有层时系统段仍是空串。
- 不做云同步/跨机器同步/团队共享。
- 不做 0.1 内存层的升级迁移（0.1 没有持久数据）。
- 不自动清理旧会话层文件（文件跟会话走）。
- 不做逐条保存开关或全局开关；不加“已恢复”标记。

## 3. 决策与理由

### D1 存储位置：会话目录顶层文件（选定）/ 插件全局目录 / 会话目录子目录 / 会话日志事件

- 选定会话目录顶层文件。理由：用户要求放在会话自己的文件夹；顶层文件最简单，便于手工查看、备份和加载；平台源码明确说会话目录可放会话本地产物。
- 否决插件全局目录：用户明确要求放在会话目录；插件目录会让文件脱离会话目录。
- 否决子目录：路径多一层，读写和排查更绕；顶层文件够用。
- 否决写会话日志事件：格式/压缩/合并耦合，侵入性大，容易把插件状态混进聊天记录。

### D2 读取时机：按需读 + stat 失效（选定）/ 启动时全量预读 / 每次组装都完整解析

- 选定按需读：第一次用某个会话（组装系统提示词或界面请求标签）时读；之后每次先 stat，文件没变就用内存，变了再解析。
- 否决启动全量预读：会话目录可能有数千个，扫全部会拖慢启动；绝大多数会话没有层。
- 否决每次组装完整解析：多一次 JSON 解析没有必要；stat 更便宜。
- 特别注意：**不缓存“文件不存在”**。文件可能后来才出现在会话目录；每次都要 stat 一次，才能发现它出现了。

### D3 写入顺序：先落盘再提交内存（选定）/ 先改内存异步写盘

- 选定先落盘：写成功才更新内存与界面；失败时 RPC 报错、标签不变、重启后仍是旧状态。
- 否决先改内存：会出现“标签在、重启就丢”的假象，正是这次要消灭的问题。

### D4 空会话兜底：插件目录兜底文件 + 自动搬入（选定）/ 直接失败 / 自己创建会话目录

- 选定兜底文件：会话文件夹还不存在时先写插件目录；文件夹出现后搬入并删兜底文件。
- 否决直接失败：新会话第一次加层就报错，体验不可接受。
- 否决自己创建会话目录：需要复刻平台的路径编码（项目目录名 + 会话 id 编码），平台一改就漂移，可能把文件写到错的目录。

### D5 备份与空状态：一份备份 + 写空文件（选定）/ 不备份 / 删除文件

- 选定一份上一版备份：主文件坏时还有一次恢复机会。
- 选定空状态写成合法的空 layers 文件，并删除备份：避免“主文件坏了→备份又把已删的层复活”。
- 否决直接删除主文件：部分删除（主文件删了、备份没删）会让备份在下次损坏时复活旧层；删除失败也没有可表达的“空状态”。
- 空文件会留在会话目录里，几字节；这是有意的、可解释的状态，不是垃圾。

### D6 可见性：不加“已恢复”标记、不新增开关（选定，用户裁决）

- 用户原话：不想要就自己点 ×；chip 本身就是提示。
- 不加标记、不做全局/逐条开关，减少 UI 噪音和状态组合。

### D7 文件名与临时文件（选定）

- 主文件固定名 prompt-library-layers.json，备份 prompt-library-layers.bak.json，临时文件 prompt-library-layers.json.tmp。
- 临时文件以 .tmp 结尾：写完改名；失败时清理，避免把写了一半的文件当成完成。
- 主文件、备份、临时文件都在会话目录顶层；不建子目录。

### D8 未知版本：只读、不覆盖（选定）

- version 不是 1 时，读取返回空、标记只读；加/删层报 layer-readonly。
- 否决“按最新格式覆盖”：可能是更新版本写的，覆盖会丢数据。
- 与 0.1 提示词库的只读策略保持一致。

### D9 不与其他插件约定（选定）

- 只保证两件事：文件写在会话目录里；能从会话目录加载。文件如何被外部搬移、同步、复制，不在本批范围。
- 否决跨插件钩子/事件约定：会引入版本耦合，收益不抵成本；目录里放对文件就够了。

### D10 读失败：零副作用、先试备份、再按无文件回退（选定）

- 读路径只 stat/read/parse，不写盘、不改名、不清理、不修备份；任何异常都在读层内吞掉。
- 候选顺序：主文件 → 备份 → 兜底文件；第一个可读且合法的就用；都失败才按“没有这个文件”返回空。
- 备份恢复多一次小文件读取；备份也受 1 MiB 上限；用主/备/兜底的 stamp 组合缓存，文件都没变就不重复解析。
- 失败即“没有这个文件”：标签空、注入空；不把异常抛给系统提示词组装或界面 RPC。
- 失败分两类，写入行为不同：
  - **I/O 类**（stat/read 抛出、不可读、读取中被删）且所有候选都不可用：按无文件；30 秒退避；加/删层拒绝写入（layer-read-failed），绝不拿空内存覆盖磁盘；有可读备份/兜底就按副本继续。
  - **混合情形**：只要出现过 I/O 错误且没有可用命中，就按 I/O 优先拒绝写入；内容类覆盖只在没有任何 I/O 错误时允许。
  - **内容类**（格式/字段/超大/不是普通文件）且备份/兜底都不可用：按无文件；加/删层允许写新文件覆盖坏主文件（把坏文件修回来）；非普通文件写入被文件系统拒绝时返回 layer-persist。
- 大小上限 1 MiB：先 stat，超过的候选直接跳过，继续试下一个。
- I/O 异常在单个候选上吞掉，继续试下一个；所有候选都不可用时 30 秒退避。不在读路径修主文件。

### D11 性能预算：stat 先行、按需解析、不扫全部会话（选定）

- 启动不扫描；只在该会话被使用时定位/读取。
- 每次组装最多 stat 当前会话的少量候选；文件 stamp 未变不解析。
- 定位只扫 sessions 根下的项目目录（数量少），不扫每个项目下的会话；正结果缓存。
- 单会话首次读取新增 p95 ≤ 100ms、典型 ≤ 20ms；最多 3 个候选的 stat + 最多 3 次小文件读取（每个候选 ≤ 1 MiB）；重复读取只 stat。
- 客户端读取异步，不阻塞会话/侧边栏渲染。

## 4. 方案

### 4.1 文件放在哪

| 用途 | 路径（默认） | 说明 |
| --- | --- | --- |
| 会话根 | $DSH_HOME/sessions | 平台默认根；本插件不新增强制配置 |
| 主文件 | 会话根/项目目录/会话 id/prompt-library-layers.json | 跟会话同目录，顶层文件 |
| 备份 | 同目录/prompt-library-layers.bak.json | 上一版；主文件坏时自动尝试恢复 |
| 临时文件 | 同目录/prompt-library-layers.json.tmp | 写完再改名；失败清理，不留半截 |
| 兜底主文件 | $DSH_HOME/prompt-library/sessions/会话 id.json | 会话目录还不存在时用 |
| 兜底备份 | $DSH_HOME/prompt-library/sessions/会话 id.bak.json | 同上 |
| 坏文件（内容类） | 原地不动 | 不隔离、不改名、不写盘；按无层处理；下次用户写层时允许覆盖；I/O 类失败则拒绝写入 |
| 提示词库 | $DSH_HOME/prompt-library/prompts.json | 不变，与本功能无关 |

### 4.2 一次“加层”发生什么

1. 界面把正文、标题、promptId 发给后台。
2. 后台先确保这个会话的现有层已经读进内存（避免覆盖磁盘上已有的层）。
3. 计算下一版：同 promptId 更新原位置；否则追加；超过 3 条拒绝。
4. 写盘：有会话目录就写会话目录；没有就写兜底目录。只把能解析的旧主文件复制到备份，再写临时文件，再整体改名。
5. 写盘成功后才更新内存；RPC 返回新的快照；界面更新标签。
6. 写盘失败则报错，内存不变，界面不出现新标签。

### 4.3 一次“读取/重启”发生什么

1. 组装系统提示词时，段回调拿到会话 id，调用注册表的 sectionText。
2. 注册表先确保该会话已加载：定位会话目录 → 主文件 → 备份 → 兜底文件；第一个可读且合法的就用。
3. 如果文件的 (路径, mtime, 大小) 与上次读的一致，直接用内存；否则重新解析。
4. 解析时校验版本、sessionId、行数和每行字段；token 重算。
5. 返回正文拼接；没有层就是空串（零 token）。
6. 重启后第一次使用会话时走同一条路径，所以注入和标签一起恢复。

### 4.4 一次“刷新”发生什么

1. 标签组件挂载（当前会话的 dock 出现）。
2. 组件在 useEffect 里调用 ensure(sessionId)，主动向后台要这个会话的层。
3. 同一会话如果已经有读取在飞，复用同一个 Promise，不重复发。
4. 读取成功：写入 store、标记已就绪，标签出现；失败：不标记，下次还能重试。
5. 原来的会话列表 warm-up 保留，作为“提前预热其他会话”的优化，但不再是唯一保证。

### 4.5 失败方向

| 场景 | 行为 | 方向 |
| --- | --- | --- |
| 文件不存在 | 先试备份/兜底；都无才按无文件 | 读 fail-open |
| 主文件格式/字段错 | 不隔离、不写盘；试备份；备份不可用再试兜底；都不可用才按无文件 | 读 fail-open |
| 备份格式/字段错 | 跳过备份；试兜底；都坏才按无文件 | 读 fail-open |
| 文件超过 1 MiB | 跳过该候选；试下一个；都不可用才按无文件 | 读 fail-open |
| 文件不是普通文件（目录/符号链接等） | 跳过该候选；试下一个 | 读 fail-open |
| 读取中被删 / stat 与 read 不一致 | 跳过该候选；试下一个 | 读 fail-open |
| 不可读（权限/占用） | 跳过该候选；试下一个；都不可用才按无文件并 30 秒退避 | 读 fail-open |
| 读失败后立即加层 | I/O 类：拒绝写入（layer-read-failed），不覆盖磁盘；内容类且无副本：允许写新文件覆盖坏主文件 | 写方向按失败分类 |
| 未知版本 | 读返回空、只读；写入报 layer-readonly | 读只读、写 fail-closed |
| 目录不存在 | 用兜底目录；会话目录出现后搬入 | 功能可用，稍后搬入 |
| 写盘失败 | RPC 报层持久化错误；内存/界面不变 | 写 fail-closed |
| 并发加层 | 串行队列，逐条落盘；后写覆盖先写 | 不产生半截文件 |
| 两个 DSH 同时写 | 原子改名，后写覆盖先写 | 最后写入者赢；不产生半截 |

## 5. 机制与伪代码

### 5.0 存储模块接口

~~~ts
const MAX_FILE_BYTES = 1024 * 1024;

type LayerRow = { promptId: string; title: string; body: string };
type FileStamp =
  | { path: string; mtimeMs: number; size: number }
  | { path: string; error: string };
type Stamp = {
  main: FileStamp | null;
  backup: FileStamp | null;
  fallback: FileStamp | null;
};

interface LayerStore {
  // 同步：永不抛错。任何异常/坏文件/超大文件都返回 rows 空。
  load(sessionId: string, previousStamp: Stamp | null):
    | { unchanged: true }
    | {
        rows: LayerRow[];
        stamp: Stamp | null;
        readOnly: boolean;
        source: 'session' | 'fallback' | 'none';
        needsPromotion: boolean;
        failed?: boolean; // I/O 错误，注册表据此做 30 秒退避
      };
  // 异步：写前只把可解析的主文件复制到备份；失败抛错。
  // 写成功后返回当前复合 stamp；stat 失败返回 null。
  write(sessionId: string, rows: LayerRow[]): Promise<Stamp | null>;
}
~~~

- load 是同步的，因为系统提示词组装只能同步读；**永不抛错**：任何 stat/read/parse/大小/字段异常都返回空。读路径不写盘、不改名。
- 候选顺序：主文件 → 备份 → 兜底文件；第一个可读且合法的就用；都失败才按无文件。备份可读时自动恢复。
- 复合 stamp：主/备/兜底各自的 (路径, mtime, size) 或 stat 错误标记；三个都没变就不解析。备份恢复因此不会每次组装都重读。
- 每个候选超过 MAX_FILE_BYTES 都不读取、不解析；有效文件远小于 1 MiB。
- write 是异步的；失败抛错，注册表不提交内存；写前只复制能解析的主文件到备份，坏文件不覆盖备份。
- store 未注入时，注册表退化为 0.1 的纯内存行为（单测/兼容）；生产路径始终注入。
- 定位、路径拼装、大小检查、备份写入、.tmp 清理都在存储模块内部，注册表只依赖上面的三个方法。

### 5.1 路径与目录定位

~~~ts
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;

function validSessionId(id) {
  return typeof id === 'string'
    && SAFE_SESSION_ID.test(id)
    && id !== '.'
    && id !== '..';
}

function locateSessionDir(sessionId) {
  if (!validSessionId(sessionId)) return null;
  const cached = dirCache.get(sessionId);
  if (cached && isDirectory(cached)) return cached;
  dirCache.delete(sessionId);
  let projects;
  try { projects = readdirSync(sessionsRoot, { withFileTypes: true }); }
  catch { return null; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = join(sessionsRoot, project.name, sessionId);
    if (isDirectory(candidate)) { dirCache.set(sessionId, candidate); return candidate; }
  }
  return null;
}
~~~

- 前条件：sessionId 是字符串；sessionsRoot 可不存在。
- 后条件：返回绝对目录或 null；不创建目录；缓存只缓存正结果，目录消失会重新扫。
- 真实会话 id 是 session-加 uuid，形状符合白名单。平台对特殊字符会做路径编码；本插件只接受白名单内的 id，避免复刻平台的编码器。若未来平台发出白名单外的 id，加层会报 session-invalid，读返回空（见 §9）。
- 负结果不缓存：会话目录出现前，每次定位会重扫 sessions 根的项目目录（数量有限；见 §11 预算）。

### 5.2 读取与校验

~~~ts
function load(sessionId, previousStamp) {
  if (!validSessionId(sessionId)) return { rows: [], stamp: null, source: 'none', readOnly: false };
  const dir = locateSessionDir(sessionId);
  const sessionPaths = dir ? layerPaths(dir) : null;
  const fallbackPaths = fallbackLayerPaths(sessionId);

  const candidates = [];
  if (sessionPaths) {
    candidates.push({ key: 'main', kind: 'session', path: sessionPaths.main, needsPromotion: false });
    candidates.push({ key: 'backup', kind: 'session', path: sessionPaths.backup, needsPromotion: false });
  }
  candidates.push({ key: 'fallback', kind: 'fallback', path: fallbackPaths.main, needsPromotion: Boolean(dir) });

  const stamp = { main: null, backup: null, fallback: null };
  const infos = new Map();
  const errors = new Set();

  // 先 stat 全部候选，组成复合 stamp（文件或错误标记）；没变就直接用内存
  for (const c of candidates) {
    try {
      const info = statSync(c.path, { throwIfNoEntry: false });
      if (info) {
        infos.set(c.key, info);
        stamp[c.key] = { path: c.path, mtimeMs: info.mtimeMs, size: info.size };
      }
    } catch (error) {
      errors.add(c.key);
      stamp[c.key] = { path: c.path, error: 'stat-failed' };
      logOnce('layer-stat-failed', c.path, error);
    }
  }
  if (previousStamp && sameStampSet(previousStamp, stamp)) return { unchanged: true };

  // 按主 → 备 → 兜底解析；单候选失败不打断后面
  let errorBeforeHit = false;
  for (const c of candidates) {
    if (errors.has(c.key)) { errorBeforeHit = true; continue; }
    const info = infos.get(c.key);
    if (!info || !info.isFile()) continue;
    if (info.size > MAX_FILE_BYTES) continue;
    try {
      const parsed = parseLayerFile(readFileSync(c.path, 'utf8'), sessionId, contract);
      if (parsed.ok) {
        return {
          rows: parsed.rows,
          stamp: errorBeforeHit ? null : stamp,
          source: c.kind === 'fallback' ? 'fallback' : 'session',
          readOnly: false,
          needsPromotion: c.needsPromotion
        };
      }
      if (parsed.readOnly) return { rows: [], stamp: errorBeforeHit ? null : stamp, source: c.kind === 'fallback' ? 'fallback' : 'session', readOnly: true };
      // 坏文件：继续试下一个候选
    } catch (error) {
      errors.add(c.key);
      stamp[c.key] = { path: c.path, error: 'read-failed' };
      errorBeforeHit = true;
      logOnce('layer-read-failed', c.path, error);
    }
  }
  if (errors.size > 0) return { rows: [], stamp: null, source: 'none', readOnly: false, failed: true };
  // 内容类失败：返回空 + 复合 stamp（不置 failed）；下次加层可写新文件覆盖坏主文件。
  return { rows: [], stamp, source: 'none', readOnly: false };
}
~~~

- 前条件：previousStamp 可能是 null。
- 后条件：rows 最多 limit 条，顺序保留，token 重算；**永不抛错**；所有候选都不可用才按无文件；不写盘、不改名。
- 候选顺序：主文件 → 备份 → 兜底文件；第一个可读且合法的就用；备份可读时自动恢复；都失败才空。
- 复合 stamp：先 stat 三个候选；文件记 (路径, mtimeMs, size)，stat 异常记错误标记；三个都没变就直接返回 unchanged。命中之后的 I/O 错误不阻止缓存；命中之前的 I/O 错误把 stamp 置空，下次重试；非命中候选长期不可读时仍只 stat。
- 单候选失败（坏/超大/不是普通文件/读异常）不打断，继续试下一个；只要出现过 I/O 错误且没有可用命中，就返回 failed（I/O 优先，注册表 30 秒退避）；内容类覆盖只在没有任何 I/O 错误时允许。
- 解析规则：
  - 根必须是对象；version 必须是整数。
  - version 不是 1：返回 readOnly，不覆盖，也不再试备份（主文件是更新版本，备份可能更旧）。
  - sessionId 必须等于请求的 id，否则视为坏文件。
  - layers 必须是数组，长度不超过 limit。
  - 每行：promptId 非空字符串；title 非空且不超过标题上限；body 非空且不超过正文上限；同一 promptId 不允许重复。
  - 忽略未知字段；tokens 不读文件里的值，统一重算。
- 大小/类型：每个候选先 stat；不是普通文件、超过 1 MiB 都跳过，继续试下一个。
- 缓存：复合 stamp 缓存；坏文件/超大文件/错误标记都记 stamp，文件不变不重试；只要出现过 I/O 错误且无命中才返回 failed。

### 5.3 写入与备份

~~~ts
async function write(sessionId, rows, allowFallback = true) {
  const dir = locateSessionDir(sessionId);
  const target = dir && isDirectory(dir)
    ? { ...layerPaths(dir), kind: 'session' }
    : { ...fallbackLayerPaths(sessionId), kind: 'fallback' };
  if (target.kind === 'fallback') await mkdir(dirname(target.main), { recursive: true });

  try {
    if (rows.length === 0) {
      // 空状态：写合法空文件，删备份，避免备份复活已删的层
      await writeAtomic(target.main, payload(sessionId, rows));
      await unlinkIfExists(target.backup);
      if (target.kind === 'session') {
        const fallback = fallbackLayerPaths(sessionId);
        await unlinkIfExists(fallback.main);
        await unlinkIfExists(fallback.backup);
      }
      return readStampSet(sessionId);
    }

    await copyIfValid(target.main, target.backup); // 只复制能解析的主文件；坏文件不覆盖备份
    await writeAtomic(target.main, payload(sessionId, rows));
    if (target.kind === 'session') {
      const fallback = fallbackLayerPaths(sessionId);
      await unlinkIfExists(fallback.main);
      await unlinkIfExists(fallback.backup);
    }
    return readStampSet(sessionId);
  } catch (error) {
    if (allowFallback && target.kind === 'session' && error && error.code === 'ENOENT') {
      return write(sessionId, rows, false); // 目录被外部搬走/暂时不可用：改走兜底，不重建会话目录
    }
    throw error;
  }
}

async function writeAtomic(path, text) {
  const temp = path + '.tmp';
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await unlinkIfExists(temp);
    throw error;
  }
}
~~~

- 前条件：rows 已经过注册表校验（≤ limit、字段合法）。
- 后条件：主文件是完整 JSON；临时文件不残留；备份是上一版（空状态除外）；会话目录写成功后兜底文件删除；失败时抛错，内存不提交。
- 如果 locate 到会话目录但写入前它消失了（例如被外部搬走）：不重建会话目录，改用兜底目录写；日志记录。下一次读取时若会话目录回来，按兜底搬入规则搬入。
- 临时文件以 .tmp 结尾；崩溃残留的 .tmp 只在下一次写入时按 10 分钟阈值清理（best-effort）；读路径只忽略，不写盘。
- 备份复制失败（非 ENOENT）时不继续写，抛错；避免“备份没写成、主文件又被覆盖”。
- 写前校验主文件；坏/超大主文件不复制到备份，避免用坏文件覆盖可人工恢复的旧备份。
- 写成功后按主/备/兜底重新 stat 得到复合 stamp；stat 失败返回 null，下次读取重算。

### 5.4 注册表：先落盘再提交

~~~ts
class LayerRegistry {
  #rows = new Map();       // sessionId -> Layer[]
  #stamps = new Map();     // sessionId -> stamp|null
  #readOnly = new Map();   // sessionId -> boolean
  #failedUntil = new Map(); // sessionId -> epoch ms（I/O 错误退避）
  #tail = Promise.resolve();

  #enqueue(task) {
    const run = this.#tail.then(task);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #clearSession(sessionId) {
    this.#rows.delete(sessionId);
    this.#stamps.set(sessionId, null);
    this.#readOnly.set(sessionId, false);
  }

  #ensureLoaded(sessionId, force = false) {
    if (!this.#store) return; // 单测/兼容：退化为纯内存
    if (!force && (this.#failedUntil.get(sessionId) ?? 0) > Date.now()) return;
    let result;
    try {
      result = this.#store.load(sessionId, this.#stamps.get(sessionId));
    } catch (error) {
      console.error('[dsh-prompt-library] layer read failed', sessionId, error);
      this.#clearSession(sessionId);
      this.#failedUntil.set(sessionId, Date.now() + 30_000);
      return;
    }
    if (result.failed) {
      this.#clearSession(sessionId);
      this.#failedUntil.set(sessionId, Date.now() + 30_000);
      return;
    }
    this.#failedUntil.delete(sessionId);
    if (result.unchanged) return;
    this.#setRows(sessionId, result.rows);
    this.#stamps.set(sessionId, result.stamp);
    this.#readOnly.set(sessionId, result.readOnly === true);
    if (result.needsPromotion) this.#schedulePromotion(sessionId);
  }

  async #persist(sessionId, rows) {
    if (!this.#store) return null; // 单测/兼容：纯内存
    try { return await this.#store.write(sessionId, rows); }
    catch (error) { throw layerError('layer-persist', error); }
  }

  async add(sessionId, input) {
    return this.#enqueue(async () => {
      this.#ensureLoaded(sessionId, true);
      if ((this.#failedUntil.get(sessionId) ?? 0) > Date.now()) throw layerError('layer-read-failed');
      if (this.#readOnly.get(sessionId)) throw layerError('layer-readonly');
      const list = this.#rows.get(sessionId) ?? [];
      const next = computeAdd(list, input, this.limit); // 同 id 更新；满 3 拒绝
      const stamp = await this.#persist(sessionId, next);
      this.#setRows(sessionId, next);
      this.#stamps.set(sessionId, stamp);
      return snapshotOf(next, this.limit);
    });
  }

  async remove(sessionId, promptId) {
    return this.#enqueue(async () => {
      this.#ensureLoaded(sessionId, true);
      if ((this.#failedUntil.get(sessionId) ?? 0) > Date.now()) throw layerError('layer-read-failed');
      if (this.#readOnly.get(sessionId)) throw layerError('layer-readonly');
      const list = this.#rows.get(sessionId) ?? [];
      const next = list.filter((row) => row.promptId !== promptId);
      if (next.length === list.length) return snapshotOf(list, this.limit); // 幂等，不写盘
      const stamp = await this.#persist(sessionId, next);
      this.#setRows(sessionId, next);
      this.#stamps.set(sessionId, stamp);
      return snapshotOf(next, this.limit);
    });
  }

  async clear(sessionId) {
    return this.#enqueue(async () => {
      this.#ensureLoaded(sessionId, true);
      if ((this.#failedUntil.get(sessionId) ?? 0) > Date.now()) throw layerError('layer-read-failed');
      if (this.#readOnly.get(sessionId)) throw layerError('layer-readonly');
      const list = this.#rows.get(sessionId) ?? [];
      if (list.length === 0) return snapshotOf([], this.limit);
      const stamp = await this.#persist(sessionId, []);
      this.#setRows(sessionId, []);
      this.#stamps.set(sessionId, stamp);
      return snapshotOf([], this.limit);
    });
  }

  snapshot(sessionId) {
    try {
      this.#ensureLoaded(sessionId);
      return snapshotOf(this.#rows.get(sessionId) ?? [], this.limit);
    } catch (error) {
      console.error('[dsh-prompt-library] layer snapshot failed', sessionId, error);
      return snapshotOf([], this.limit);
    }
  }

  sectionText(sessionId) {
    try {
      this.#ensureLoaded(sessionId);
      return (this.#rows.get(sessionId) ?? []).map((row) => row.body).join('\n\n---\n\n');
    } catch (error) {
      console.error('[dsh-prompt-library] layer section failed', sessionId, error);
      return '';
    }
  }
}
~~~

- 确保加载是同步的：系统提示词组装只能在同步回调里读，不能等 Promise。
- 读异常（I/O 类）且所有候选都不可用：清空该会话内存层（按无文件）、记日志、30 秒退避；**不保留旧值**；加/删层拒绝写入。有可读备份/兜底就按副本继续。内容类失败不置 failed；加/删层允许写新文件覆盖坏主文件。
- 搬入：schedulePromotion 把任务放进同一个串行队列；任务里重新 ensureLoaded（此时用兜底数据）、写会话主文件、删兜底；失败保留兜底并记日志；同一会话 30 秒内不重复尝试。
- 空状态：remove 删掉最后一条、clear 都会写空文件；不是删主文件（见 D5）。
- 读不阻塞：所有磁盘操作都是小文件同步读写；不做全量扫描。
- 读异常/解析异常都在这里被吞掉；注册表向系统提示词和 RPC 只返回空，不抛错；I/O 错误 30 秒退避。
- store 为空时（单测或无持久化构造），ensureLoaded 直接返回，add/remove/clear 跳过写盘，行为与 0.1 内存注册表一致。
- add 前条件：sessionId 合法、input 字段合法、同 id 不新增行；后条件：文件成功、rows 已提交、返回快照；失败码 layer-limit / layer-persist / layer-readonly。
- remove 前条件：无；后条件：幂等，未命中不写盘，命中后写盘并提交。
- clear 前条件：无；后条件：写空状态并提交；已经没有层时不写盘。

### 5.5 系统提示词段

段回调不变，仍只拿会话 id；内部从持久化注册表读：

~~~ts
ctx.systemPrompt.section({
  name: SECTION_NAME,
  order: resolveSectionOrder(ctx.systemPrompt),
  interpolate: false,
  text: (context) => {
    const session = context?.agent?.session;
    if (!session) return '';
    return layers.sectionText(String(session.id));
  }
});
~~~

- 前条件：context 可能没有 agent/session。
- 后条件：没有层、读失败、会话未知都返回空串；绝不因为层文件坏而让系统提示词组装失败。
- 每次组装只做少量 stat（通常 1 次；主文件不存在时再看兜底）；文件没变不解析。

### 5.6 客户端水合

~~~ts
const oneFlight = new Map(); // sessionId -> Promise
let epoch = 0;

function ensureLayers(sessionId) {
  const key = String(sessionId);
  if (layersReady.has(key)) return Promise.resolve({ ok: true });
  const running = oneFlight.get(key);
  if (running) return running;
  const startedAt = epoch;
  const run = refreshLayers(sessionId).then((result) => {
    if (startedAt !== epoch) return result; // 连接已重置，丢弃旧结果
    if (result.ok) layersReady.add(key);
    else layersReady.delete(key);
    return result;
  }).catch((error) => {
    console.error('[dsh-prompt-library] layer hydrate failed', key, error);
    layersReady.delete(key);
    return { ok: false };
  }).finally(() => {
    if (oneFlight.get(key) === run) oneFlight.delete(key);
  });
  oneFlight.set(key, run);
  return run;
}
~~~

dock 注入新增 sessionId 和 ensure：

~~~ts
slots.inject('conversation.input.dock', () => slots.register({
  name: 'conversation.input.dock',
  id: 'prompt-library',
  order: 30,
  locale: NS,
  inject: (sessionId) => ({
    sessionId,
    ensure: () => { void ensureLayers(sessionId); },
    hooks: { layers: layerStore(sessionId) },
    openEditor: (promptId) => { void openLayerEditor(sessionId, promptId); },
    remove: (promptId) => { void removeLayer(sessionId, promptId); }
  })
}, LayersDock));
~~~

组件在挂载时读：

~~~ts
export function LayersDock(props) {
  const snapshot = props.useLayers((value) => value);
  React.useEffect(() => { props.ensure(); }, [props.sessionId]);
  const layers = Array.isArray(snapshot?.layers) ? snapshot.layers : [];
  if (layers.length === 0) return null;
  // 其余渲染不变
}
~~~

- 前条件：props.ensure 幂等，重复调用不会重复发请求。
- 后条件：标签在不依赖会话列表变化的情况下出现。
- 连接重置：epoch 加一、清空 ready 和 oneFlight、再 warm 一遍；旧 epoch 的结果不会标记 ready。refreshLayers 在写入 store 之前也要检查 epoch，否则旧连接的成功响应可能在重置后覆盖新状态。
- 失败：不标记 ready，下一次组件挂载或列表变化还会重试；ensureLayers 的 Promise 永不 reject，ensure 外层再包 try/catch，绝不把异常带进组件渲染。

## 6. 状态与 schema

### 6.1 层文件

~~~json
{
  "version": 1,
  "sessionId": "session-example-0001",
  "updatedAt": "2026-10-29T08:00:00.000Z",
  "layers": [
    {
      "promptId": "p_m3k2aa7f1b2c3d4e5",
      "title": "说人话",
      "body": "请用白话解释，先说结论。"
    }
  ]
}
~~~

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| version | 整数 | 当前只写 1；不是 1 时只读、不覆盖 |
| sessionId | 字符串 | 必须等于请求的会话 id；不等于视为坏文件 |
| updatedAt | 字符串 | ISO 时间；读取时不依赖，写入时更新 |
| layers | 数组 | 0~3 条；顺序即注入顺序 |
| layers[].promptId | 字符串 | 非空；同一文件内不重复 |
| layers[].title | 字符串 | 非空；不超过 80 字 |
| layers[].body | 字符串 | 非空；不超过 20000 字 |
| tokens | 不存 | 读取时按现有估算函数重算 |

- 写入格式：2 空格缩进 + 末尾换行，方便手工查看。
- 单文件上限 1 MiB；超过不读取、不解析；有效文件远小于这个上限。
- 文件大小上限：3 × （20000 字正文 + 标题 + JSON 包装）；中文按 UTF-8 算最多约 180 KB，实际通常只有几 KB。
- 文件位置：会话目录顶层；兜底目录同样结构。
- 谁写：host 的注册表（add/remove/clear 触发的串行写）。谁读：host 的 sectionText、layers RPC；客户端只通过 RPC 读。

### 6.2 内存状态

| 状态 | 位置 | 说明 |
| --- | --- | --- |
| rows | 注册表 Map | sessionId → 已提交的层数组 |
| stamps | 注册表 Map | sessionId → 上次读取时主/备/兜底三个文件的 (路径, mtimeMs, size) 组合（含 stat 错误标记）；null 表示没有完成缓存 |
| readOnly | 注册表 Map | sessionId → 是否因为未知版本只读 |
| dirCache | 存储模块 | sessionId → 会话目录；目录消失会重新扫 |
| oneFlight | 客户端 | sessionId → 正在飞的读取 Promise |
| layersReady | 客户端 | 已经成功读过、可跳过的会话 |
| epoch | 客户端 | 连接重置代数；丢弃旧连接的落点 |

### 6.3 错误码

| 错误码 | 触发 | 客户端表现 |
| --- | --- | --- |
| layer-limit | 第 4 条 | 弹窗“系统层已满（最多 3 条）” |
| layer-persist | 写盘/备份/改名失败 | 弹窗报“没能保存到磁盘，这次没有加进去”并保持打开 |
| layer-read-failed | 加/删层前读失败 | 弹窗报“读取会话层失败，这次没有写入”；磁盘不变 |
| layer-readonly | 文件版本未知 | 弹窗报“该会话的层文件由更新版本写入，当前只读” |
| session-invalid | 会话 id 不在白名单 | 弹窗报“这个会话的编号不合法，无法保存” |
| input-invalid | 请求字段不合法 | 现有弹窗错误文案 |

- layer-limit 保持现有映射；新增三个文案在 zh/en 字典同 key。
- 删除（×）失败目前没有界面提示：标签留在原处就是“没删掉”的可见反馈；用户可再点。这个取舍写进 §12，不在本批扩大 UI。
- 读失败不产生错误码：layers RPC 一律返回空快照；只有写失败/只读/非法 id 才有错误码。

### 6.4 线上协议

- LayerSnapshot（layers / totalTokens / limit）不变；不新增字段。
- 加层/删层/清空 RPC 的入参不变。
- contract 的 schema、manifest、wire 类型不变；本批只改 host 行为与客户端水合。
- 版本号升到 0.2.0；主机构建产物由 tsc/tsdown 生成，不手改 lib。

## 7. 图示

### 7.1 数据流

~~~mermaid
flowchart LR
  U["用户：加/删层"] --> UI["界面：标签区"]
  UI -->|内部调用| RPC["后台服务"]
  RPC --> REG["注册表（内存）"]
  REG -->|首次或文件变化| STORE["会话层存储"]
  STORE -->|读写| SD["会话自己的文件夹"]
  REG -->|正文| SP["系统提示词段"]
  SP -->|每次请求| M["模型"]
~~~

### 7.2 会话层状态

~~~mermaid
stateDiagram-v2
  [*] --> Empty
  Empty --> One: 加第 1 条
  One --> Two: 加第 2 条
  Two --> Three: 加第 3 条
  Three --> Three: 第 4 条被拒
  One --> Empty: 删最后一条
  Two --> One: 删一条
  Three --> Two: 删一条
  Empty --> Gone: 删除会话
  Three --> Gone: 删除会话
~~~

### 7.3 重启/刷新恢复时序

~~~mermaid
sequenceDiagram
  participant U as 用户
  participant UI as 界面
  participant H as 后台
  participant F as 会话文件夹
  U->>UI: 刷新页面 / 重启后打开会话
  UI->>H: 这个会话有层吗（挂载即读）
  H->>F: 读层文件（先 stat）
  F-->>H: 层内容
  H-->>UI: 标签数据
  UI-->>U: 标签回来，注入继续
~~~

## 8. 防偏离

### 8.1 验收到测试的映射

| 验收 | 测试落点 | 测试类型 |
| --- | --- | --- |
| AC-1 重启恢复 | tests/layer-store.test.mjs：新实例读取已写文件；tests/layers.test.mjs：注册表首次读取 | 单测 |
| AC-2 关闭后不复活 | tests/layer-store.test.mjs：空状态写回、备份删除；tests/layers.test.mjs：remove/clear | 单测 |
| AC-3 刷新恢复 | tests/client-index.test.mjs：dock 注入 ensure、并发合并、失败重试 | 单测 |
| AC-4 多会话隔离 | tests/layers.test.mjs、tests/layer-store.test.mjs：两个会话目录各自读写 | 单测 |
| AC-5 文件归属 | tests/layer-store.test.mjs：把会话目录整体复制到别处再复制回来 | 单测 |
| AC-6 读失败回退 | tests/layer-store.test.mjs：坏主文件+好备份→备份；备份/兜底都不可用→空；不改名、不写盘 | 单测 |
| AC-7 写失败 | tests/layers.test.mjs：假存储抛错，注册表不提交 | 单测 |
| AC-8 空会话兜底 | tests/layer-store.test.mjs：无会话目录写兜底文件（不是 .tmp）；目录出现后搬入 | 单测 |
| AC-9 非法编号 | tests/layer-store.test.mjs：斜杠、双点、空格 | 单测 |
| AC-10 零 token | tests/layers.test.mjs：sectionText 空串 | 单测 |
| AC-11 上限 | tests/layers.test.mjs：第 4 条 layer-limit | 单测 |
| AC-12 全绿 | npm run check | 构建 + 类型 + 全量测试 |
| AC-13 读失败无感 | tests/layer-store.test.mjs、tests/layers.test.mjs：不存在/坏 JSON/超大/不可读/读取中被删，返回空且不抛错；section/RPC 返回空快照 | 单测 |
| AC-14 性能预算 | tests/layer-store.test.mjs：机械断言“10 MiB 不读取、重复只 stat、坏主文件不重复解析”；计时仅作烟雾参考（p95 是预算） | 机械断言 + 手工 |

### 8.2 负向断言

- 读操作全程不写盘（坏文件不改名、不清理、不修备份）；测试用只读目录/写计数验证。
- 读失败不抛错：用抛错的假存储、坏文件、超大文件验证 sectionText 返回空串、snapshot 返回空快照。
- 超过 1 MiB 的候选不被读取解析；其他候选可读时用其他候选。
- 坏主文件+好备份时用备份；复合 stamp 让第二次读取只 stat、不重读备份；坏文件不会在每次组装重复解析。
- 机械断言为主：10 MiB 不读取、重复只 stat、坏主文件不重复解析；单测计时只作烟雾参考（宽阈值）。
- 非命中候选长期不可读（如兜底文件 EACCES）时，复合 stamp 仍命中（错误标记不变），重复读取只 stat、不重解析主文件；命中之前的 I/O 错误则 stamp 置空重试。
- 写失败时注册表 rows 不变，RPC 返回 layer-persist；测试用抛错的假存储。
- I/O 类失败且所有候选都不可用时加层被拒绝（layer-read-failed），磁盘文件不变；I/O 类但有可读副本时按副本继续；内容类失败且无副本时加层成功并覆盖坏主文件（测试用抛错 store/坏文件 + 写计数）。
- 不出现 .tmp 残留；测试在成功写入后断言目录里没有 .tmp。
- 非法 id 不产生任何目录或文件；测试在临时根里断言没有越界路径。
- 空状态后备份不存在；测试断言备份被删除，且新实例读到空。
- 没有层时 sectionText 是空串；测试断言系统段为空。
- 第 4 条被拒绝后文件仍是 3 条；测试断言文件与内存都是 3。
- 兜底搬入成功后兜底文件不存在；测试断言。
- 客户端 ensure 并发只发一次读；测试用计数。
- 客户端读失败后 ready 不置位；测试再调用会重试。
- 会话目录被整体移走且没有回来时，读取按无层处理；测试只验证定位与空处理。

### 8.3 测试设施与命令

- 新测试统一在系统临时目录建 DSH_HOME 骨架：sessionsRoot、项目目录、会话目录、兜底目录；测试结束清理。
- 文件位置用“整体复制/移动目录”验证：不启动任何其他插件，断言层文件在会话目录里、读回一致。
- 注册表测试注入假存储，精确控制 read/write 的返回值与失败点。
- 性能/失败测试：10 MiB 假文件断言不读取；坏主文件+好备份断言恢复备份；有效文件首读计时 < 100ms；抛错 store 断言不抛；重复读取断言无再次解析（读计数）。
- 非命中候选不可读（如兜底文件 EACCES）时主文件仍只 stat/不重解析；命中之前的 I/O 错误则重试（读计数）。
- 命令：
  - 单测：node --test tests/layer-store.test.mjs
  - 单测：node --test tests/layers.test.mjs tests/service.test.mjs
  - 客户端：node --test tests/client-index.test.mjs tests/dialog.test.mjs tests/locales.test.mjs
  - 全量：npm run check（build + typecheck + test）
- 当前基线（2026-10-29）：typecheck 通过；测试 125 通过 / 1 跳过 / 0 失败。新增测试后要求 0 失败。

### 8.4 真机验收清单

1. 加 1 条层，关闭 DSH，重启，打开同一会话：标签在，发一条消息后系统提示词里含该正文（看会话请求头/日志）。
2. 点 ×，再重启：标签不在，系统段为空。
3. 浏览器 F5：标签直接回来，不切换会话、不等列表刷新。
4. 两个会话各加不同层，重启后互不串。
5. 把整个会话目录复制到别处再复制回来（不启动任何其他插件）：文件仍在，读回一致。
6. 手工把层文件改成坏 JSON / 放大到 10 MiB / 设为不可读，重启：DSH 正常启动，会话与侧边栏正常；备份/兜底可读时恢复，都不可用时标签按无层显示；文件不被改名、不被清理。
7. 把会话目录设为只读（或模拟写失败），加层：弹窗报错，标签不新增。
8. 新建空会话加层：先写兜底；发第一条消息后确认文件搬进会话目录、兜底消失。
9. 第 4 条被拒绝；最多 3 条不变。
10. 不激活层时系统段为空（零 token）。
11. 用有效层文件测一次会话加载：观察新增耗时在预算内（计时烟雾）；主判据是日志/计数中的“不解析、只 stat”。

## 9. 边界

| 边界 | 行为 |
| --- | --- |
| 没有层 / 没有文件 | 标签不显示；系统段空串；不写盘 |
| 空白会话，会话目录不存在 | 写兜底目录；目录出现后搬入；搬入失败保留下次再试 |
| 主文件格式/字段错（内容类） | 不隔离、不改名；试备份；备份不可用再试兜底；都不可用才按无文件；下次加层可覆盖坏主文件 |
| 备份格式/字段错 | 跳过备份；试兜底；都不可用才按无文件 |
| 文件超过 1 MiB | 跳过该候选；试下一个；都不可用才按无文件 |
| 文件不是普通文件（目录/符号链接等） | 跳过该候选；试下一个 |
| 读取中被删 / stat 与 read 不一致 | 跳过该候选；试下一个 |
| 不可读（权限/占用，I/O 类） | 跳过该候选；试下一个；都不可用才空并 30 秒退避、加层被拒（layer-read-failed）；有可读副本就继续 |
| 所有候选都失败（I/O 类） | 按无文件；30 秒退避；加层被拒 |
| 所有候选都失败（内容类） | 按无文件；下次加层可覆盖坏主文件（修复） |
| 混合情形（内容类 + 另一副本 I/O 错误） | I/O 优先：拒绝写入；有可读命中就按命中 |
| 读失败后立即加层 | I/O 类拒绝写入（layer-read-failed）；内容类且无副本允许覆盖坏主文件 |
| 未知版本 | 读空、只读；写入报 layer-readonly；不隔离、不覆盖 |
| 主文件被手工删除 | 先试备份；备份也没有再试兜底；都不可用才按无文件；下次写入重建 |
| 写失败（目录只读/磁盘满） | 报 layer-persist；内存/界面不变；磁盘仍是上一版，读取仍返回旧层 |
| 并发加层 | 串行队列；逐条落盘；上限在落盘前检查 |
| 两个 DSH 同时写 | 原子改名；后写覆盖先写；不产生半截文件 |
| 重复会话 id 跨项目目录 | 定位取第一个并记日志；平台自身会报重复，本插件不扩大问题 |
| 删除会话 | 目录被删，层文件一起没 |
| 导出/换机 | 本批不把层文件纳入导出/换机流程；换机后需要重新加层（已知边界） |
| 0.1 升级到 0.2 | 0.1 没有持久层，无需升级迁移；库文件不变 |
| 平台目录布局变化 | 定位不到会话目录就退到兜底目录；功能可用但不会自动搬入会话目录；日志提示；后续版本跟进布局 |
| 崩溃留下 .tmp | 读路径只忽略；下次写入时按 10 分钟阈值清理 |
| 空状态文件 | 有意保留（几字节）；重启读到空；不会复活已删层 |
| 侧边栏 / 会话列表 | 本插件不参与其渲染；读失败不入渲染路径；不抛错、不阻塞 |
| × 删除失败 | 标签留在原处（可见反馈），用户可再点；本批不加界面提示 |

**失败方向总则**：读 fail-open（读失败先试备份/兜底；都失败才按无文件：空标签/空注入，不抛错、不写盘、不阻塞系统提示词），写 fail-closed（不显示假标签）。

## 10. 实施计划

### 10.1 阶段

1. **阶段 1：存储模块 + 单测**。新增会话目录定位、文件读写、大小检查、读失败回退、备份写入、兜底与路径安全；只碰新模块和它的测试。
2. **阶段 2：注册表 + 服务 + 接线 + 单测**。注册表改成先落盘再提交、按需读；服务增加错误映射；index 注入存储；更新现有层/服务/index 测试。
3. **阶段 3：客户端水合 + 文案 + 单测**。dock 挂载即读、并发去重、失败重试；新增错误文案；更新客户端/弹窗/字典测试。
4. **阶段 4：文档回写 + 版本 + 全量检查**。README、CHANGELOG、旧需求/设计档回写、版本 0.2.0；npm run check；真机验收准备；按 §10.2 去掉 .gitignore 的 docs/ 忽略并提交 docs（评审通过后执行）。

### 10.2 改动文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | src/host/layer-store.ts | 会话目录定位、读写、大小检查、读失败回退、备份写入、兜底 |
| 新增 | tests/layer-store.test.mjs | 存储、读失败、超大/不可读、性能与边界测试 |
| 修改 | src/host/layers.ts | 异步 add/remove/clear、按需读、读失败隔离、先落盘再提交、兜底搬入 |
| 修改 | src/host/service.ts | await 注册表；读失败返回空快照；保留/映射新错误码 |
| 修改 | src/index.ts | 构造存储并注入注册表；段回调不变 |
| 修改 | src/client/index.ts | ensureLayers 去重、epoch、dock 注入 ensure/sessionId |
| 修改 | src/client/chips.ts | 挂载时调用 ensure |
| 修改 | src/client/react.ts | 导出 useEffect |
| 修改 | src/client/locales.ts | layer-persist / layer-read-failed / layer-readonly / session-invalid 文案 |
| 修改 | src/client/dialog.ts | 错误码到文案的映射（含 layer-read-failed） |
| 修改 | package.json | 版本 0.2.0 |
| 修改 | README.md | 持久化、文件位置、边界 |
| 修改 | CHANGELOG.md | 0.2.0 条目 |
| 修改 | .gitignore | 去掉 docs/ 忽略；文档脱敏后纳入 Git |
| 提交 | docs/ 下的需求/设计文档（0.1 + 0.2） | 全部脱敏扫描零命中后纳入 Git |
| 修改 | docs/requirements.md | S6/FR-6/非目标/AC-7 回写 + 指向本档 |
| 修改 | docs/design.md | 非目标/生命周期/schema/边界/chip 行为回写 + 指向本档 |
| 修改 | tests/layers.test.mjs | async、假存储、失败回滚、兜底搬入 |
| 修改 | tests/service.test.mjs | await、新错误码 |
| 修改 | tests/client-index.test.mjs | 挂载即读、并发合并、失败重试 |
| 修改 | tests/dialog.test.mjs | 新错误码文案 |
| 修改 | tests/locales.test.mjs | 新增 key 的 zh/en 对齐 |
| 可能修改 | tests/bundle.test.mjs | 如果断言了 host 构建文件清单，加入新模块 |
| 不改 | src/contract.ts | 线上 schema 不变 |
| 不改 | lib/ | 由构建生成 |

### 10.3 每阶段验收

- 阶段 1：node --test tests/layer-store.test.mjs 全绿；覆盖读写、读失败、超大/不可读、备份写入、兜底搬入、路径安全、并发、性能预算。
- 阶段 2：node --test tests/layers.test.mjs tests/service.test.mjs tests/contract.test.mjs tests/gateway-reserved.test.mjs 全绿；新增读失败无感、失败回滚、兜底搬入用例。
- 阶段 3：node --test tests/client-index.test.mjs tests/dialog.test.mjs tests/locales.test.mjs tests/settings.test.mjs 全绿；新增并发/重试/文案用例。
- 阶段 4：npm run check 全绿；真机按 §8.4 验收；README/CHANGELOG/旧文档回写完成。

### 10.4 构建与重启

- 构建：npm run build（tsc + tsdown）。lib 是产物，不手改。
- 检查：npm run typecheck；npm test；完整 npm run check。
- 重启：host 代码改动只有重启 DSH 才生效。按用户规矩，重启前报告在跑的会话/作业与影响，由用户决定时机。
- 重启后先做 §8.4 的 1~4 条；再做目录复制、损坏/超大/不可读、计时与写失败。

### 10.5 旧文档回写清单（实施阶段执行）

- docs/requirements.md：S6（第 25 行，as-of 2026-10-29）、FR-6（第 39 行）、非目标第 5 条（第 59 行）、AC-7（第 71 行）；改语义并加一句“0.2 增量见本档”。
- docs/design.md：开头三句话（第 4 行）、目标“重启清空”（第 30 行）、非目标（第 37 行）、生命周期（第 145-148 行）、内存 schema（第 236 行）、边界（第 318 行）、阶段 3（第 349 行）、风险（第 371 行）、chip 行（第 394 行）；加“0.2 增量见本档”。
- README.md：第 5、11、31、38 行的“重启清空/不落盘”改为“按会话持久化、文件在会话目录”；补一句导出边界。
- CHANGELOG.md：新增 0.2.0 条目。
- 所有计数、版本、路径声明同批改；改后回读，确认没有替换字符。

## 11. 风险与待验证

| 风险 | 影响 | 缓解 / 验证 |
| --- | --- | --- |
| 平台会话目录布局变化 | 定位不到目录，退兜底，不会自动搬入会话目录 | 定位失败只影响自动搬入，不影响功能；日志提示；升级时按 §1.3 重核 |
| 读路径异常把会话带崩 | 读/解析/超大/不可读异常进入系统提示词或界面 | 读路径全部 try/catch；先试备份，仍不行才返回空；单测用抛错 store、坏文件、10 MiB 文件 |
| 读路径拖慢会话 | 大文件、重复解析、全量扫描 | stat 先行 + 1 MiB 上限 + 复合 stamp 缓存（含错误标记）+ 只扫项目目录 + 100ms 预算 |
| 备份恢复增加 I/O | 最多多两次小读取（备/兜底） | 每个候选 1 MiB 上限；复合 stamp 防重复；计入 100ms 预算 |
| 侧边栏不显示 | 插件抛错/阻塞事件循环 | 不在会话列表路径上；读路径零抛错；超大文件不读；客户端 ensure 不抛 |
| 读路径写盘 | 隔离/修备份/清 .tmp | 读路径零写；只在用户写层时写 |
| 读失败后立即加层 | 内容类允许覆盖（有意修复）；I/O 类拒绝写入 | 写前强制读；I/O 类报 layer-read-failed；内容类写新文件覆盖；测试覆盖 |
| 往会话目录写未知文件被平台视为异常 | 平台报错或清理 | 平台源码明确认日志文件名、忽略其他文件；单测 + 真机验收；出问题可退回兜底目录（功能仍可用） |
| Windows 文件替换/占用 | 改名失败 | 写失败报 layer-persist；不提交内存；重试 |
| mtime 粒度导致“文件变了但 stamp 没变” | 读到旧缓存 | 写入后主动更新 stamp；文件被外部改动时 mtime 通常变化；最坏情况下下一次读取才更新，不影响最终数据 |
| 两个 DSH 同时写 | 后写覆盖先写 | 原子改名，不产生半截；不承诺跨进程合并（与提示词库一致） |
| 兜底文件一直没搬入 | 该会话层会留在插件目录 | 只有“会话目录尚不存在”时才用兜底；目录出现后读/写都会触发搬入；测试覆盖 |
| 本批不做导出/换机 | 换机后要重新加 | 文档写明；不假装支持 |
| × 删除失败无提示 | 用户不知道为什么没删掉 | 标签留在原处就是反馈；用户可再点；本批不加界面提示，记入 §12 |
| 空状态文件留在会话目录 | 目录里多一个几字节文件 | 有意：避免删除/备份复活问题；文档写明 |
| 每次组装多几次 stat | 极小的固定开销 | 只 stat 当前会话的少量候选文件；文件没变不解析；性能测试可观测 |
| 目录出现前的定位会重扫项目目录 | 每次多几毫秒 | 正结果缓存；目录出现前每次重扫（项目目录数量有限，预算内）；不扫会话内部 |

## 12. 决策记录与已知取舍

- 2026-10-29 用户裁决：层文件放在会话目录；本插件只负责这一处的读写，不与其他插件耦合；重启自动恢复；不想要就点 ×；不加“已恢复”标记；不加开关；先看文档，再走工程模式。
- 2026-10-29 追加约束：读失败（不存在/格式错/超大/不可读）先试备份/兜底，都失败才按无文件回退；不影响会话或侧边栏；单会话新增开销 ≤ 100ms；读路径零写。
- 失败分类：I/O 类且所有副本不可用 → 拒绝写入（layer-read-failed）；混合情形按 I/O 优先；内容类且无副本、且没有任何 I/O 错误 → 允许写新文件覆盖坏主文件（修复）；有可读副本时按副本继续；命中之后的 I/O 错误不阻止缓存，命中之前的错误置空重试；详见需求档 §8。
- 已知取舍（不是开放项，评审时可提出）：
  1. 点 × 失败时不弹提示，标签留在原处作为反馈。
  2. 空状态保留一个几字节的合法空文件，不删除。
  3. 本批不做层文件的导出/换机。
  4. 兜底文件只在会话目录出现后搬入；如果会话一直没落盘，它会留在插件目录。
  5. 不做跨进程合并；两个 DSH 同时写，后写覆盖先写。
  6. 自动备份恢复会多一次小文件读取：用复合 stamp 防止重复解析；备份/兜底都不可用才按无文件；读路径最多 3 个候选的 stat + 3 次小读，预算内。
- 开放项：无。

## 13. 文档维护

- 本档与需求档是 0.2 的事实源；0.1 文档在本批实施完成后按 §10.5 回写。
- 任何计数、版本、路径、行为声明改动时，同批改列表与引用；改后回读被改区域，确认没有替换字符（U+FFFD）。
- 引用本仓文档用“档名 §节”；行号只作 as-of 括注，不作为稳定指针。
- 平台事实（§1.3）带 as-of 日期；平台升级后先重核，再改实现。
- 本档已脱敏：路径用 $DSH_HOME 占位；示例会话 id 是合成的；不含用户名、本机绝对路径、其他插件仓库路径。
- docs/ 纳入 Git：从 .gitignore 移除 docs/；提交前对全部 docs/ 跑脱敏检查；只提交 docs/ 与 .gitignore 的相关改动。
- 入库时机（2026-10-29 用户裁决）：等设计评审通过、进入实施阶段再执行；本轮只做脱敏，不改 .gitignore、不提交。


