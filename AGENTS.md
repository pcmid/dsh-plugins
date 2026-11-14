# AGENTS.md — dsh-plugins

本仓库存放自研 DSH 插件，并发布插件市场索引 `index.json`。

- 每个插件是 `plugins/<name>/` 下的一个独立 bundle 包，包名用 `@pcmid/<name>`。
- `package.json` 必须声明 `dsh.bundle.patch` 和 `engines.dsh`；导出 `./locale/*.json`（`meta.title`、`meta.description`，至少 `en` 和 `zh`）和 `./icon`，并把运行所需文件都列进 `files`，因为从 Git 安装时只会打包 `files` 里的内容。
- 新插件要在 `catalog.json` 的 `plugins` 里登记：`{ "path": "plugins/<name>", "category": "<已声明的分类>", "labels": ["own"] }`。第三方插件写成 `{ "npm": "<包名>", "version": "<精确版本>", ... }`；我们 fork 的第三方插件写成 `{ "git": "<https 仓库地址>", "commit": "<40 位提交号>", ... }`，该提交必须带构建产物，因为 DSH 从 Git 原样安装。
- `index.json` 由 `scripts/build-index.mjs` 生成，不要手改。插件目录里有未提交的改动时脚本会报错；索引会把每个插件固定到最后一次修改它目录的提交。
- 发布新版本时提高插件 `package.json` 的 `version`。
- 没有 CI。推送前运行 `npm run check:index`；改了带测试的插件时，在其目录运行 `npm install --no-save --no-package-lock && npm test`。

## 提交流程：worktree + PR

- 不要在主检出目录里改，也不要直接往 `main` 提交或推送。用 `create_worktree({ name: "<任务名>", from: "main" })` 新建分支和 worktree，所有改动都在里面做。
- PR 提到 GitHub 的 `pcmid/dsh-plugins`（remote `origin`），基线 `main`。`id`（git.shabi.id）是镜像，不往它推功能分支。
- 涉及发布时，按顺序在同一个分支里做：提交插件改动 → `git push -u origin <分支>` → `npm run build:index` → 提交 `index.json` → 再推送 → `gh pr create --base main`。先推送是为了让索引固定的提交已在远端，否则脚本会警告。
- 合并 PR 必须用 merge commit，不能 squash 或 rebase：那样会改写提交号，`index.json` 里固定的提交就不在 `main` 上了。
- 不要自己合并 PR，把链接交给用户。合并后由用户把 `main` 同步到 `id` 镜像。
