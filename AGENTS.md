# AGENTS.md — dsh-plugins

本仓库存放自研 DSH 插件，并发布插件市场索引 `index.json`。

- 每个插件是 `plugins/<name>/` 下的一个独立 bundle 包，包名用 `@pcmid/<name>`。
- `package.json` 必须声明 `dsh.bundle.patch` 和 `engines.dsh`；导出 `./locale/*.json`（`meta.title`、`meta.description`，至少 `en` 和 `zh`）和 `./icon`，并把运行所需文件都列进 `files`，因为从 Git 安装时只会打包 `files` 里的内容。
- 新插件要在 `catalog.json` 的 `plugins` 里登记：`{ "path": "plugins/<name>", "category": "<已声明的分类>", "labels": ["own"] }`。第三方插件写成 `{ "npm": "<包名>", "version": "<精确版本>", ... }`。
- `index.json` 由 `scripts/build-index.mjs` 生成，不要手改。顺序是：提交插件改动 → `npm run build:index` → 提交 `index.json` → 推送。插件目录里有未提交的改动时脚本会报错；索引会把每个插件固定到最后一次修改它目录的提交。
- 发布新版本时提高插件 `package.json` 的 `version`。
- 没有 CI。推送前运行 `npm run check:index`；改了带测试的插件时，在其目录运行 `npm install --no-save --no-package-lock && npm test`。
