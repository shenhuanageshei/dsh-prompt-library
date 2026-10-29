# dsh-prompt-library 设计档

> 三句话：宿主半边管库文件和三档系统提示词段，客户端半边管 `/` 菜单、编辑确认弹窗、chip 和设置页；
> 系统层改成可叠（≤3 条、每条 chip、总 token 可见；0.2 起按会话落盘，重启/刷新后自动恢复）；
> 普通上下文靠连续选两次叠加，不预建组合。
>
> **0.2 增量**：系统层持久化后的行为（存储位置、读取与恢复、失败分类、错误码、客户端水合）以 [2026-10-29-session-layer-persistence-design.md](2026-10-29-session-layer-persistence-design.md) 与 [2026-10-29-session-layer-persistence-requirements.md](2026-10-29-session-layer-persistence-requirements.md) 为准；本档里 0.1 的「进程内存 / 重启清空」结论已按 0.2 回写，冲突时以 0.2 档为准。

## 1. 背景与问题

- 需求见 docs/requirements.md。
- 根因不是“没有地方存文字”，而是三个缺口：
  1. 没有按需入口：AGENTS.md / dsh-prompt-layer 都是常驻；
  2. 没有编辑确认：直接粘贴长文容易发错；
  3. 没有会话级分层：临时策略无法只对当前会话生效、随时撤。
- DSH 已有能力（已在本机 0.2.1-rc.2 包内确认）：
  - `ctx.commands`：斜杠命令；`ui-commands` 把 `/` 做成触发器；
  - `ctx.systemPrompt.section({ text: (context) => ... })`：按 agent 返回文本，空串即消失（plan-mode 同款）；
  - `inputTriggers.registerSource`：`/` / `@` 菜单来源，支持 `order` 排序；
  - `conversation.input.overlay` / `conversation.input.dock` / `settings.section`：客户端插槽；
  - `ctx.typert` + `ctx.remote.$mount`：host↔client 的严格 RPC（dsh-at-file 同款）；
  - `conversation.input.dock` 的组件能拿到 `input` / `inputActions`（dsh-at-file 的 FilesDock 已在用 `setDraft`）。

## 2. 目标 / 非目标

### 目标

- 一条提示词：选 → 改 → 插输入框（默认）或加系统层（额外选项）。
- 两条普通上下文：连续选两次，正文叠加，发送前可改。
- 两条系统层：可叠，≤3 条，每条 chip 可单独关，总 token 可见。
- 管理：设置页 CRUD、导入导出、token 估算；库是本地 JSON，可手工改。
- 不用时零新增 token；系统层按会话持久化，重启/刷新后自动恢复注入与 chip（0.2 增量、用户裁决：不想要时自己点 ×）。

### 非目标

- 不做右键菜单（没有原生插槽）。
- 不做模板变量、自动推荐、云同步、团队共享。
- 不做组合提示词（叠层已覆盖；组合可在以后作为“预设叠层”再加）。
- ~~系统层不持久化：重启即清空。~~ **0.2 已废止**：系统层按会话持久化（写入该会话目录，另有一份备份与插件目录兜底）；仍不新增「已恢复」标记或保存开关。

## 3. 关键决策与理由

### D1 系统层：可叠层（选定） / 单条 / 组合提示词

- 选定可叠层，最多 3 条。理由：用户明确要“两套同时”；叠层比预建组合灵活，每条可单独撤，token 账直观。
- 否决单条：上一版为防叠加只允许一条，但用户场景（极限测试 + 自主推进）天然要两条。
- 否决组合提示词：要预先创建、改起来回设置页、看不出里面有几段；叠层更直接。
- 代价：chip 会多一行；用总 token 和 3 条上限兜底。

### D2 存储：独立 JSON（选定） / settings / localStorage

- 选定 `$DSH_HOME/prompt-library/prompts.json`。理由：库是用户数据，不是插件配置；JSON 可手工改、进 Git、换机带走；不污染 `cordis.patch.yml`。
- 否决 settings：settings 是 profile 配置，长正文写进 YAML 难维护，且每次保存重写配置。
- 否决 localStorage：只在单浏览器，设置页/多窗口/备份都不好。

### D3 数据通道：Typert Remote（选定） / HTTP route / 命令编码

- 选定 Typert Remote，照 dsh-at-file：host `ctx.typert.register(MANIFEST)` + `TypertRemoteService`；client `ctx.remote.$mount(REMOTE)` + `ctx.reflect.get("remote.promptLibrary")`。
- 理由：它是 DSH 官方插件↔客户端通道，带 codec、取消、错误码；at-file 是完整可抄的样板。
- 否决 HTTP route：要自己处理浏览器信任 fence 和错误格式，多一套协议。
- 否决命令编码：长正文会进 session log，且返回值只有文本，chip 同步难做。
- 风险：typert 需要手写 manifest + `@Remote` 方法；阶段 0 先跑通最小 RPC。

### D4 客户端入口：原生 trigger source + overlay + dock（选定）

- `/` 用 `inputTriggers.registerSource({ trigger: "/", order: -10 })`，组名“提示词”放最前；
- 选中后不直接返回 text，而是打开 `conversation.input.overlay` 的编辑确认弹窗；
- 系统层 chip 放 `conversation.input.dock`（与 at-file 的 @ 路径 dock 同位置，输入框上方）；
- 管理页放 `settings.section`。
- 否决 commandUi popup：popup 的 onSelect 拿不到 inputActions/插入 span，做“编辑后插入”要绕。

### D5 构建：TypeScript + tsdown（选定）

- 复制 dsh-at-file / dsh-navbar 的双 half 构建：host ESM + client CJS `__ModuleLoader__.load` 包装。
- 理由：能直接用 `@Remote` 装饰器、类型、共享 contract；手写 JS 能省构建，但 typert 装饰器/类型风险更大。
- 构建链：tsdown + tsc（类型）；client 的 external 为 `react` / `react-dom` / `@deepseek-ai/dsh-client-*`。

## 4. 方案（FR → 实现）

| FR | 落点 | 说明 |
| --- | --- | --- |
| FR-1 | `PromptStore`（host） | 读写 JSON，原子写 + 备份 + 串行队列 |
| FR-2 | trigger source（client） | `/`，order -10，标题/标签/正文过滤，最多 20 行 |
| FR-3 | overlay 弹窗 | 标题、正文 textarea、投递单选、token、取消/确认 |
| FR-4 | `inputActions.setDraft` | 用 menu hit 的 span 替换 `/查询` token；连续两次自然叠加 |
| FR-5 | `LayerRegistry`（host） + RPC | `addLayer/removeLayer/layers/clearLayers`，≤3，按 sessionId 存 |
| FR-6 | dock chips | 每条 chip 标题 + token + ×；点标题开编辑弹窗；总 token 一行 |
| FR-7 | settings section | 列表/搜索/新增/编辑/删除/导入导出 |
| FR-8 | locale + styles | zh/en 字典；`<style data-plugin>`，用 `--dsw-alias-*` token |
| FR-9 | 共用 `estimateTokens` | 中文 0.75/字，其他 0.28/字；四舍五入 |
| FR-10 | 错误处理 | 坏文件备份、写入回滚、错误 toast、库空可启动 |

## 5. 机制伪代码

### 5.1 库文件读写（host）

    readLibrary(path):
      if !exists: return { version: 1, prompts: [] }
      text = readFile(path)
      try: parse + validate
      catch:
        rename(path, path + ".corrupt-" + timestamp)
        log warn
        return { version: 1, prompts: [], corruptBackup: newPath }

    writeLibrary(path, data):
      await queue:                    # 串行，防并发写
        if exists: copy(path, path + ".bak")
        tmp = path + ".tmp"
        writeFile(tmp, JSON.stringify(data, null, 2))
        rename(tmp, path)             # 原子替换

### 5.2 系统层注册表（host，内存）

    layers = Map<sessionId, Layer[]>   # Layer: { promptId, title, body }
    MAX = 3

    addLayer(sid, layer):
      list = layers.get(sid) ?? []
      if existing = find(list, layer.promptId):
        existing.title = layer.title
        existing.body = layer.body          # 同 id 视为更新，不重复
        return snapshot(sid)
      if list.length >= MAX: throw LayerLimit
      list.push(layer)
      layers.set(sid, list)
      return snapshot(sid)

    removeLayer(sid, promptId): filter; return snapshot(sid)

    sectionText(agent):
      if !agent: return ""                  # 非 agent 组装
      list = layers.get(String(agent.session.id)) ?? []
      if list.length === 0: return ""       # 空串 = 段落消失，零 token
      return list.map(l => l.body).join("\n\n---\n\n")

### 5.3 系统提示词段（host）

    order = (getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") ?? 10200) + 300
    ctx.systemPrompt.section({
      name: "prompt-library:session-layers",
      order,
      text: (context) => sectionText(context.agent),
      interpolate: false,      # 正文里的 {{...}} 原样保留，不炸装配
    })

层的生命周期：按 sessionId 存放，0.2 起以该会话自己的层文件为事实源（进程内只是缓存/视图）。
DSH 每个 turn/步骤会重建 agent，压缩也会换 agent，这些 **都不清层**（agent 生命周期比会话短），
也绝不会因为一次读失败而把内存里的旧值当成新状态（I/O 类失败按无文件处理并退避）。
用户显式删层（chip × / clearLayers）会写空状态到磁盘，重启也不会复活；
DSH 进程重启后第一次使用该会话时从会话目录读回，chip 与系统提示词段一起恢复。
若平台提供真正的 session 关闭事件，也不得在那里清层；绝不能用 `agent/disposed`
（真机证据：turn 28 step 1 的系统提示词有层，step 2 的 agent/disposed 后消失）。

### 5.4 RPC（host manifest + service）

    service promptLibrary (wire 命名空间 promptLibrary):
      list(): LibrarySnapshot
      save(input: PromptInput): LibrarySnapshot      # id 空 = 新建
      removePrompt(id): LibrarySnapshot   # wire 名不能是 remove：与网关 RemoteNamespaceService.prototype.remove 冲突
      layers(sessionId): LayerSnapshot
      addLayer(sessionId, LayerInput): LayerSnapshot
      removeLayer(sessionId, promptId): LayerSnapshot
      clearLayers(sessionId): LayerSnapshot

    LayerSnapshot = { layers: [{ promptId, title, tokens }], totalTokens }
    错误码：layer-limit / not-found / library-corrupt / stale-write

### 5.5 `/` 菜单来源（client）

    source = {
      trigger: "/", name: "prompt-library", order: -10,
      candidates(session, { query, signal }):
        lib = await ensureLibrary(signal)        # 缓存 TTL 5s
        rows = lib.prompts.filter(title/tags/body includes query).slice(0, 20)
        return rows.map(p => ({ name: p.title, description: tags, value: p.id }))
      onPick({ candidate, session }):
        span = readPickSpan(session.sessionId)   # 从 inputTriggers 控制器读 menu.hit.span
        pending.set(session.sessionId, { prompt, span, delivery: "insert" })
        controller.dismiss()
        return undefined                         # 不直接落文本，交给 overlay
    }

### 5.6 编辑确认弹窗（client overlay）

    on mount: 从 pending 取 { prompt, span, delivery }
    body = pending.body ?? prompt.body

    确认-插入:
      next = input.draft.slice(0, span.start) + body + input.draft.slice(span.end)
      inputActions.setDraft(next)
      close()

    确认-系统层:
      await remote.addLayer(sessionId, { promptId, title, body })
      layersStore.set(result)
      close()

    编辑系统层:
      await remote.addLayer(sessionId, { promptId, title, body })   # 同 id 覆盖

### 5.7 chip（client dock）

    useLayers(sessionId) -> LayerSnapshot
    render: 每条 chip [标题 ×]，末尾 “系统层 N 条 · 每轮 +X tokens”
    remove -> await remote.removeLayer(sessionId, promptId)
    click title -> pending.set(sessionId, { kind: "edit-layer", layer })

### 5.8 设置页（client settings section）

    列表 + 搜索 + 新增/编辑/删除 + 导入导出
    保存 -> remote.save({ id?, title, body, tags }) -> 刷新 store
    导入：读 JSON 文件 -> 校验 -> 合并/替换（二次确认）
    导出：下载 library JSON

## 6. 状态与 schema

### 6.1 库文件 `$DSH_HOME/prompt-library/prompts.json`

    {
      "version": 1,
      "updatedAt": "2026-10-27T09:00:00.000Z",
      "prompts": [
        {
          "id": "p_01J...",
          "title": "极限测试授权",
          "body": "我们是deepseek公司……",
          "tags": ["授权", "测试"],
          "createdAt": "2026-10-27T09:00:00.000Z",
          "updatedAt": "2026-10-27T09:00:00.000Z"
        }
      ]
    }

- 限制：title ≤ 80 字；body ≤ 20000 字；tags ≤ 8 个；prompts ≤ 200 条。
- 备份：每次写前把旧文件复制为 `prompts.bak.json`（保留 1 份）；坏文件另存 `prompts.corrupt-<ts>.json`。
- 谁写：host `PromptStore`（RPC 的 save/removePrompt）；谁读：host `list`、客户端设置页/菜单缓存。

### 6.2 宿主内存

    LayerRegistry: Map<sessionId, Layer[]>   # 内存视图；0.2 起真相在会话目录的层文件（LayerStore）
    LibraryCache: 进程内按 mtime 缓存（可选）；每次 RPC 以文件为准

### 6.3 客户端状态

    libraryStore: SnapshotStore<LibrarySnapshot>      # 菜单/设置页共用
    pendingBySession: Map<sessionId, PendingDialog>    # 弹窗
    layersBySession: Map<sessionId, SnapshotStore<LayerSnapshot>>  # chips

### 6.4 Wire 类型

- `SessionId`：`@deepseek-ai/dsh-session/types#SessionId`（严格 codec）。
- `PromptInput` / `Prompt` / `LibrarySnapshot` / `LayerInput` / `LayerSnapshot`：zod strict schema，host/client 共享 contract。

## 7. 图示

### 7.1 架构

    +---------------------------- DSH host ---------------------------- +
    |  dsh-prompt-library (lib/index.js)                                |
    |    PromptStore  <-- prompts.json ($DSH_HOME/prompt-library)       |
    |    LayerRegistry (Map<sessionId, Layer[]>)                        |
    |    systemPrompt.section(order 10500, text=layers(agent.session))  |
    |    Typert service promptLibrary  <-- RPC                          |
    +-------------------------------+----------------------------------+
                                    | /api/promptLibrary/*
    +-------------------------------v----------------------------------+
    |  client (lib/client.js)                                          |
    |    inputTriggers / source  --/-->  overlay dialog                |
    |    dock chips  <-- LayerSnapshot --  settings.section CRUD       |
    +------------------------------------------------------------------+

### 7.2 一次使用

    用户输入 /
      -> 菜单组「提示词」（最前）
      -> 选中一条
      -> 编辑确认弹窗（默认插入 / 可切系统层）
      -> 插入：setDraft 替换 /查询 token
      -> 系统层：addLayer -> chip + 系统提示词末尾段落
      -> 再选一条：重复；系统层到 3 条为止

### 7.3 系统层状态

    [无] --add--> [1 条] --add--> [2 条] --add--> [3 条]
      ^             |               |               |
      |             +--remove-------+---------------+---> [n-1]
      +--------------------------clear---------------------+
    第 4 条：拒绝（layer-limit），提示先关一条

## 8. 防偏离

### 8.1 验收映射

- AC-1..AC-12 见 requirements.md；每条在实施阶段有对应检查。
- 关键负向断言：
  - 无系统层时 `sectionText` 返回空串；系统提示词中不出现 `prompt-library` 段。
  - 第 4 条 addLayer 抛 `layer-limit`，层数仍为 3。
  - `/` 菜单不产生模型消息；只有用户点发送后才有 user 消息。
  - 库损坏时插件仍启动，坏文件存在 `.corrupt-*`，不抛到 boot。

### 8.2 测试

- 单测（host）：PromptStore（空/坏/原子写/备份）、LayerRegistry（加/重复/上限/删/清）、sectionText（空/一条/两条/顺序）。
- 单测（shared）：estimateTokens、schema 校验。
- 集成：用 stub context 跑 RPC manifest 注册（阶段 0）。
- 手工：真机菜单/弹窗/chip/设置页/重启。
- 回归：加层后触发 agent 重建 / `agent/disposed` / 压缩，`sectionText` 仍包含该层（系统层不是一条消息一次性的）。
- 真机：编辑弹窗在会话内容区内居中、不覆盖左右侧栏；chip 行与输入框左右边界对齐。

## 9. 边界

| 边界 | 行为 |
| --- | --- |
| 空库 | `/` 菜单无提示词组；设置页空态；不报错 |
| 库文件损坏 | 改名备份，空库启动，设置页提示；不阻塞 boot |
| 并发写 | host 串行队列 + 原子 rename；后写覆盖，客户端刷新 |
| 多窗口同时改 | 以最后写入为准；设置页保存后重新拉取（v0.1 不做 revision 冲突） |
| 第 4 条系统层 | 拒绝，toast “最多 3 条” |
| 同一提示词重复加层 | 视为更新正文，不新增 |
| 会话切换 | chips 按 sessionId 读；不串层 |
| agent 重建 / 压缩 / agent.disposed | 系统层保留（按 sessionId）；不得清理 |
| DSH 重启 | 库保留；系统层从会话目录读回，chip 与系统段一起恢复（0.2）；点过 × 的不会回来 |
| agent 组装无 session | section 返回空串 |
| 正文含 {{...}} | section 设 `interpolate: false`，原样保留 |
| 超长正文 | schema 拒绝（>20000 字），toast |
| RPC 不可用 | 菜单只读缓存；编辑/加层失败 toast；不影响发送 |
| 插件升级 | 库文件带 version；未知 version 只读 + 提示，不覆盖 |
| 失败方向 | 库读写失败 fail-closed（不写坏文件）；系统层失败 fail-open（不激活，提示），绝不静默半截 |

## 10. 实施计划

### 阶段 0：技术验证（先做，1 个最小客户端插件）

- 验证：typert manifest + 手写/装饰器 service 能通；client `$mount` + `reflect.get` 能调；
- 验证：trigger source 能读到 `menu.hit.span`；overlay 能拿到 `input`/`inputActions`；`setDraft` 能替换 `/查询`；
- 验证：dock 能拿到 `inputActions` 并渲染 chip；
- 通过标准：一个临时 `/demo` 源 + 弹窗 + “插入”按钮，真机可用。
- 不通过：降级方案——overlay 只读确认、插入改走 `onPick` 返回 text（无编辑）；系统层走 host command。

### 阶段 1：仓库与 host

- 建 `package.json` / `tsconfig` / `tsdown.config.ts` / `dsh.plugin.json` / `cordis.patch.yml` / `lib`；
- `PromptStore` + `LayerRegistry` + section + typert manifest/service；
- 单测通过。

### 阶段 2：客户端菜单 + 弹窗 + 插入

- source + overlay + setDraft + token 估算；
- 手工验证：单条、连续两条、取消、空库。

### 阶段 3：系统层 chips

- host add/remove/layers；dock chips；第 4 条拒绝；会话隔离；(0.2) 按会话持久化，重启后读回。

### 阶段 4：设置页 CRUD + 导入导出

- 列表/编辑/删除/导入/导出；坏文件提示；备份。

### 阶段 5：安装与验收

- `pnpm add file:...` / bundle 挂载；
- 重启 DSH（先报影响：在跑会话/作业）；
- 跑 AC-1..AC-12；记录 token 实测。

## 11. 风险与待验证

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| typert 手写 manifest / 装饰器不匹配 | RPC 不通 | 阶段 0 用 at-file 样板验证；备选 HTTP route |
| overlay 拿不到 inputActions / span | 无法编辑后插入 | 阶段 0 验证；降级 onPick 直插 |
| 触发源 `onPick` 不自动关菜单 | 弹窗叠菜单 | source 里 `controller.dismiss()` |
| 系统段 order 变化 | 排在别处 | 用 `getSectionOrder` 动态取，回退 10500 |
| 客户端 bundle loader 契约 | 不加载 | 照 navbar/at-file 的 ModuleLoader 包装 |
| 重启打断其他会话 | 用户不满 | 按用户规矩：先报影响，等确认 |
| 叠 3 条后 token 成本 | 用户误解 | chip 总 token + 3 条上限 + 用户点 × 关闭（0.2 起重启也不再清空，chip 本身就是提示） |

## 12. 交互规格（与已确认样机一致，新增叠层）

### 12.1 菜单

- `/` 打开；组顺序：提示词（最前）→ 添加 → 指令。
- 提示词行：标题 + token 估算；按标题/标签/正文过滤。
- 选中一行 → 编辑确认弹窗；菜单关闭。

### 12.2 弹窗

- 标题、标签、正文 textarea（可改）、投递方式（插入 / 系统层）、token、取消 / 确认。
- 默认插入；系统层选项显示“本会话生效、每轮计费、直到关掉”。
- 系统层已有 2 条时，选系统层显示“会再加一条，每轮约 +X tokens”。
- 已满 3 条：系统层选项禁用，提示“先关一条”。
- 弹窗在**会话内容区**内居中（左右侧栏展开时也不覆盖侧栏）；内容区不足时宽度收缩并保留 ≥16px 边距。

### 12.3 chips

- 输入框上方一行：每条 [标题 ×]；末尾“系统层 N 条 · 每轮 +X tokens”。
- chip 行与输入框同一内容列：左右边界对齐（同宽/同内边距），总 token 与 chip 同行。
- 点标题重新编辑该层正文；× 立即移除（可再加）。
- 重启/刷新后 chip 随会话读回（0.2；层文件在会话目录里）；点 × 后不再回来。

### 12.4 普通上下文多条

- 连续选两次；第一次插入后，光标在插入文本末尾，再打 `/` 选第二条；
- 第二次替换新的 `/查询` token，不覆盖已有正文；两条之间保留正文自带换行，用户可手动调。

### 12.5 设置页

- 列表 + 搜索 + 新增/编辑/删除 + 导入/导出；显示每条 token 估算。
- 存储路径只读展示；坏文件时顶部警告 + 备份文件名。
