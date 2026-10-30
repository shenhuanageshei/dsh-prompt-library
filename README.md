# dsh-prompt-library

给 DSH 用的提示词库和会话系统层。

- 常用长提示词存本地，在输入框里用 `/` 选，改完再插入。
- 想让一段话长期影响当前会话：在弹窗里选「注入系统提示词」，最多 3 条；输入框上方会出现 chip。
- 系统层按会话存在本地，DSH 重启或刷新页面后自己回来；点 × 才移除。

不激活系统层时不占 token，也不会改你的系统提示词。

## 怎么用

1. 输入 `/`，第一组是「提示词」；按标题/标签/正文过滤。
2. 选中 → 编辑 → 插入。`/查询` 会被替换，前后文字保留；可以连续选。
3. 想让它进系统提示词：在弹窗里选「注入系统提示词」。chip 出现在输入框上方，最多 3 条。
4. 点 chip 的 × 移除；重启或刷新后，没移除的层会回来。

设置 → 提示词库：增删改查、导入/导出 JSON。

## 系统层存在哪

- 提示词库：`$DSH_HOME/prompt-library/prompts.json`，首次保存时创建；原子写 + 一份备份；坏文件改名隔离，不阻塞启动。
- 系统层：`$DSH_HOME/sessions/<项目>/<会话 id>/prompt-library-layers.json`，上一版留在 `prompt-library-layers.bak.json`。
- 会话目录还不存在时，先写 `$DSH_HOME/prompt-library/sessions/<会话 id>.json` 兜底；目录出现后自动搬进去，并删掉兜底。
- 打开会话只读层文件，不写盘、不改名、不清理；只有你加/删层，或会话目录出现后搬入兜底文件，才写盘。
- 读失败先试备份、再试兜底；都不可用就按「没有层」处理：chip 空、系统段空，不影响会话/侧边栏。
- 写失败会提示，不会出现假 chip；层文件不随导入导出/换机走，换机后需要重新加层。

## 已知限制

- 如果兜底文件搬进会话目录失败，0.2.0 在同一个进程里不会自己反复重试；下一次文件变化、你加/删层或重启时会再试。这是 0.2.1 的候选改进。
- 最多 3 条；第 4 条会被拒绝。

## 已验证 / 未验证

真机跑过的：重启后层文件还在、chip 回来、系统提示词含层正文；加层、第 4 条被拒、× 删除、F5 读回。

只有单测、未做真机破坏性测试的：空会话兜底搬入、损坏文件、10 MiB 超大文件、只读目录。

未测的：单次读取新增耗时的计时（p95 100ms 的预算）；目前只有单测里的机械断言。

两会话隔离：存储路径独立、单测覆盖；真机上两个会话的层内容相同，正文无法区分串层，所以没有把它记成「真机通过」。

## 安装

需要 DSH 0.2.1-rc.2 或更高。

方式一（推荐）：在 DSH 插件管理里用 GitHub 源安装 `https://github.com/shenhuanageshei/dsh-prompt-library`（DSH 版本支持时）。

方式二（手动）：

1. `git clone https://github.com/shenhuanageshei/dsh-prompt-library`
2. 在 desktop profile 里 `pnpm add link:<仓库路径>`
3. 把 `dsh-prompt-library` 加进 profile `package.json` 的 `dsh.profile.bundles`
4. 重启 DSH

## 开发

- `npm install`
- `npm run build`（tsc + tsdown）
- `npm run typecheck`
- `npm test`（node --test）
- 目录：`src/`（host + client）、`tests/`、`lib/`（构建产物）。

## 兼容性

- DSH 0.2.1-rc.2+（desktop profile）。
- TypeScript + tsdown 构建；客户端单文件 bundle。

## 许可证

MIT。
