# dsh-prompt-library

给 DeepSeek Harness（DSH）用的提示词库：把常用的长提示词存起来，在输入框里用 `/` 选，改完再插入；也可以把最多 3 条叠加到当前会话的系统提示词末尾。

不用时不占 token；系统层 chip 常显、可单独关；DSH 重启后层清空，库保留。

## 功能

- `/` 菜单第一组「提示词」，按标题/标签/正文过滤，显示 token 估算。
- 选中后先编辑、再插入：`/查询` 被替换，前后文字保留；连续选可叠加。
- 系统层：当前会话最多 3 条，每条一个 chip，显示总 token；可单独移除；DSH 重启清空。
- 设置页：增删改查、搜索、导入/导出 JSON；库文件损坏自动隔离，不阻塞启动。
- 只存本地：`$DSH_HOME/prompt-library/prompts.json`；不联网、不上传。

## 安装

需要 DSH 0.2.1-rc.2 或更高。

方式一（推荐）：在 DSH 插件管理里用 GitHub 源安装本仓库（DSH 版本支持时）。

方式二（手动）：

1. `git clone https://github.com/shenhuanageshei/dsh-prompt-library`
2. 在 desktop profile 里 `pnpm add link:<仓库路径>`
3. 把 `dsh-prompt-library` 加进 profile `package.json` 的 `dsh.profile.bundles`
4. 重启 DSH

## 使用

- 输入 `/`，第一组「提示词」；选中 → 编辑 → 插入。
- 想长期生效：在弹窗里选「注入系统提示词」；chip 出现在输入框上方；最多 3 条；DSH 重启清空。
- 设置 → 提示词库：管理提示词、导入/导出。

## 数据与隐私

- 库文件：`$DSH_HOME/prompt-library/prompts.json`；首次保存时创建。
- 原子写 + 备份；坏文件改名隔离。
- 系统层只在进程内存，不落盘；DSH 重启清空。
- 不联网、不上传。

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
