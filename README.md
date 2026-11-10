# dsh-plugins

DeepSeek Harness（DSH）插件仓库：存放自研插件的源码，并发布一个 DSH 插件市场索引 [`index.json`](index.json)（格式 1），其中同时收录自研插件和我们在用的第三方插件。

## 在 DSH 里使用这个索引

在 DSH 的插件「发现」页打开「管理索引源…」，把下面的地址填入「索引 URL」并添加：

```
https://raw.githubusercontent.com/pcmid/dsh-plugins/main/index.json
```

之后即可在「发现」页浏览和安装这里的插件。

> DSH 读取索引和从 Git 安装插件时都不携带 GitHub 凭据，所以仓库需要是公开的。私有仓库下索引地址会返回 404，「发现」页会提示无法读取此索引。

## 收录的插件

| 插件 | 来源 | 分类 | 说明 |
|---|---|---|---|
| [`@pcmid/dsh-model-defaults`](plugins/dsh-model-defaults) | 本仓库 | 模型与接入 | 在模型设置页顶部设置新会话默认值（模型、智能体、权限）和小模型 |
| [`@pcmid/dsh-retry-advisor`](plugins/dsh-retry-advisor) | 本仓库 | 模型与接入 | 内置机制不再重试的模型请求失败，交给模型分析是否值得重发 |
| [`@pcmid/dsh-web-search-native`](plugins/dsh-web-search-native) | 本仓库 | 工具与能力 | 用模型接口自带的网页搜索（目前是 Anthropic Messages）为 `web_search` 提供后端 |
| [`@pcmid/dsh-auto-restart`](plugins/dsh-auto-restart) | 本仓库 | 工具与能力 | agent 运行中 Harness 被退出、重启或崩溃时，下次启动后自动继续这些会话 |
| [`@pcmid/dsh-remote-relay`](plugins/dsh-remote-relay) | 本仓库 | 工具与能力 | 通过自建的 OpenChamber relay 从手机或其他电脑远程使用 DSH，端到端加密 |
| [`@pcmid/dsh-todo-guard`](plugins/dsh-todo-guard) | 本仓库 | 工具与能力 | agent 连续多步没更新 `todo_write` 任务列表时提醒它更新；可选在回合结束时把剩余任务标为完成 |
| [`@0imzero/dsh-workspace-menu`](https://github.com/0imzero/dsh-workspace-menu) | npm `2.1.0` | 界面增强 | 主页工作区/会话的右键与双击增强菜单 |
| [`@laoyuehanni/dsh-token-usage`](https://github.com/LaoYueHanNi/dsh-token-usage) | npm `0.4.15` | 用量与计费 | 记录每次请求的 token 用量与费用，提供统计页 |

`@pcmid/dsh-web-search-native` 会优先使用 `@pcmid/dsh-model-defaults` 提供的小模型，两者建议一起安装。

不经过索引也可以直接安装本仓库的插件：在插件管理里安装下面这种固定到提交的 Git 地址（提交号见 `index.json` 里对应版本的 `source.commit`）：

```
git+https://github.com/pcmid/dsh-plugins.git#<commit>&path:/plugins/dsh-retry-advisor
```

## 目录结构

```
catalog.json            索引的手写部分：标题、分类、标签，以及要收录哪些插件
index.json              由 scripts/build-index.mjs 生成，不要手改
plugins/<name>/         自研插件，每个目录都是一个独立的 DSH bundle 包
scripts/build-index.mjs 索引生成脚本（无运行时依赖，Node 22+）
```

## 维护

先 `npm install` 一次，它会装上 DSH 自己的索引校验器 `@deepseek-ai/dsh-plugin-market-index`，生成脚本用它校验结果。

**修改自研插件**

1. 修改 `plugins/<name>/`，需要发布新版本时提高其 `package.json` 的 `version`。
2. 提交插件改动。
3. 运行 `npm run build:index`，提交生成的 `index.json`，然后推送。

索引里的自研插件固定在「最后一次修改该目录的提交」，所以必须先提交插件再生成索引；目录里有未提交的改动时脚本会报错，提交还没推送时会给出警告。

**新增自研插件**：把 bundle 目录放到 `plugins/` 下（`package.json` 必须声明 `dsh.bundle.patch` 和 `engines.dsh`），在 `catalog.json` 的 `plugins` 里加一项 `{ "path": "plugins/<name>", "category": "...", "labels": ["own"] }`，再按上面的步骤生成索引。

**收录或升级第三方插件**：在 `catalog.json` 里加一项或改版本号，例如 `{ "npm": "<包名>", "version": "<版本>", "category": "...", "labels": ["external"] }`，然后 `npm run build:index`。第三方插件固定到这里写的版本；标题、描述和图标从该版本在 npm 上的包里读取，下载的包会按 registry 记录的完整性哈希校验。

`npm run check:index` 只检查 `index.json` 是否与当前生成结果一致，CI 在每次推送时运行它，并运行 `dsh-retry-advisor`、`dsh-auto-restart` 和 `dsh-todo-guard` 的离线测试。

## 生成规则

- 自研插件以 Git 来源发布（`source.type: git`，固定提交 + `path`），`publishTimestamp` 取该提交的提交时间；第三方插件以 npm 来源发布，`publishTimestamp` 取 npm 的发布时间。
- 标题和描述取自插件导出的 `locale/*.json` 的 `meta.title` / `meta.description`，缺英文时用包名或 `package.json` 的 `description` 补上；图标不超过 32 KiB 时内联为 `data:` URL。
- `engines.dsh` 原样复制插件 `package.json` 的声明。两个第三方插件没有在顶层声明 `engines.dsh`，因此索引里没有版本范围，「发现」页把它们显示为兼容；实际安装时 DSH 仍会按包里声明的 `@deepseek-ai/dsh-*` peerDependencies 检查兼容性。
- 自研插件使用 `@pcmid/` 包名，但没有发布到 npm，只能从本仓库的 Git 地址安装。
