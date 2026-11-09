# @local/dsh-model-defaults

在“模型”设置页的供应商列表上方增加两组配置，选中后立即保存。

## 新会话

| 配置 | 控件 | 保存位置 |
|---|---|---|
| 模型 | 模型和推理强度下拉框 | `agent-default-model` |
| 智能体 | 下拉框 | `agent-preset-registry.selectedDefault` |
| 权限 | 分段控件，选项来自 Harness 的权限目录 | `permission.defaultPreset` |

这些都是 Harness 已有的配置，和“通用”“智能体”设置页写的是同一份，所以任何一处改了，其他地方都会同步。

- **完全权限需要确认。** 选它会弹出和 Harness 相同的风险确认，勾选后才能启用。
- **切换默认智能体时**，当前打开的空白新会话会一起切换，和 Harness 自己的智能体设置页一致。
- **开发者工具关闭时**，PTC 和 Minimal 两个内置智能体不显示，也和 Harness 一致。

## 其他模型

| 配置 | 控件 | 保存位置 |
|---|---|---|
| 使用默认小模型 | 复选框 | `model-defaults.enabled` |
| 小模型 | 模型和推理强度下拉框 | `model-defaults` 的 `provider`、`model`、`reasoningEffort` |

关闭复选框时，小模型的选择会保留，重新打开不用再选。目前只有 `@local/dsh-web-search-native` 读取小模型。

## 行为说明

- **输入框切换模型只影响当前会话，不会改默认模型。** 新会话始终使用这里设置的模型。Harness 原本会把输入框的选择写成默认模型，本插件拦截了这一步。还没有默认模型时例外：第一次选择仍会保存，否则新会话没有模型可用。
- **列表里已不存在的模型**会显示为“（不可用）”，配置保持不变，直到你另选一个。

## 给其他插件用

```js
const small = ctx.get('smallModel')?.currentSelection()
// { provider, model, reasoningEffort? }；未设置或复选框关闭时为 undefined
```

## 已知限制

- **拦截的是 Harness 的内部方法。** Harness 没有提供关闭“输入框写默认值”的扩展点，所以本插件替换了 `agentDefaultModel.saveSelection`，卸载时还原。如果以后 Harness 改了这个方法名，插件会记一条警告，输入框又会开始改默认模型。卸载本插件也会恢复原有行为。
- **没发送的空白草稿会保留它自己的选择。** 在空白新会话里切换了模型但没有发送，这个草稿还是你选的模型；下一个新会话才回到默认模型。
- **页面位置靠 CSS 实现。** 模型页只提供列表下方的 `settings.models.footer` 插槽，所以这些配置用 CSS `order` 排到列表上方。如果以后页面布局变了，它们会退回页面底部，功能不受影响。
- **键盘 Tab 顺序和视觉顺序不一致。** DOM 里这些配置仍在列表之后。要彻底解决，需要 Harness 在列表上方增加一个插槽。
- **依赖 Chromium 的 Popover 和 CSS 锚点定位**，Harness 自带的菜单也依赖后者。
- **文案只有中文和英文**，其他语言显示英文；智能体和权限的选项名称沿用 Harness 自带的多语言文案。
- **没有提供给 agent 的工具。** 这些配置只能在设置页修改。
