# study-anchor · 学习锚点

> 在 DeepSeek Harness 里，选中一段看不懂的讲解 → 另开一个独立会话专门搞懂它 → 不打断主线。

## 它解决什么问题

跟 AI 学习时，一段输出里经常夹着几个不懂的词。**抓着它当场追问，主线就断了**：解释越滚越长，回到原来那一步要翻半天。

这个插件把「搞懂一个概念」这件事挪出主线：

1. 在主线的回答里**选中**那个词或那句话；
2. 浮出「⚓ 问这个概念」，点它 → 弹出面板，**问题已经默认填好**（「这段话是什么意思？请结合我当前的学习主线……」），你可以直接发，也可以改成自己想问的；
3. 插件在**同一个 cwd 下新开一个会话**，把主线最近的内容节选 + 你选中的概念 + 你的问题一起带过去，专门解释这一个概念，并把会话标题设成「⚓ 概念：xxx」，方便以后在侧栏里一眼认出来；
4. 你在这个**概念会话**里可以继续追问，它记得上下文；
5. 想回主线：概念会话输入框上方有一条「⚓ 概念会话：xxx ← 回到主 session」，点一下切回去；
6. 你问过的那个概念，**在原句下面会留下一条虚线**；**后续对话里再出现同一个概念，也会自动带上虚线**；
7. 点虚线 → 弹出这个概念的信息，可以「回到这个概念 session」复习、「继续追问」另开一个追问会话，或者「删除锚点」。不想操作的话，**点面板外面或按 Esc 就关掉**。

## 界面速览

| 位置 | 出现时机 | 作用 |
|---|---|---|
| `⚓ 问这个概念` 浮动按钮 | 在对话里选中 ≤200 字 | 打开提问面板 |
| 提问面板 | 点浮动按钮后 | 概念（可改）+ 问题（默认已填，可改）→ 开始提问 |
| 虚线（句内） | 该概念被问过之后，原句与后续同概念处 | 点它打开概念详情 |
| 概念详情面板 | 点虚线后 | 回到概念 session / 继续追问 / 删除锚点；**点面板外面或按 Esc 关闭** |
| `⚓ 概念会话：… ← 回到主 session` | 你正处在某个概念会话里 | 一键切回原来的主线会话 |
| `⚓ 本会话问过 N 个概念` | 当前主线会话里有锚点时 | 概念芯片，点一下回到对应概念会话 |
| 右下角首次使用提示 | 第一次 | 提示可以选中文字提问，点「知道了」永久关闭 |

## 安装情况

已经装进 **desktop** profile。落盘的接线在 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "study-anchor": "link:/absolute/path/to/study-anchor" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "study-anchor"] } }
}
```

因为装的是 `link:`，`node_modules/study-anchor` 是指向你源码目录的符号链接 —— **改完文件不需要重新安装**，刷新页面即可；被缓存时重启 DSH。对已安装的同一个包再跑一次 `install_bundle` 会返回 `{"changed":false,"application":"failed","error":{"code":"ambiguous-install"}}`，这是「已经装好、无需变更」的提示，不是故障。

运行中已确认两个插槽条目都是 `active`：

- `shell.overlay` → `study-anchor`（order 50）
- `conversation.composer.dock` → `study-anchor`（order 20）

卸载：

```bash
dsh plugin --profile desktop remove study-anchor
```

## 验证情况

| 项目 | 怎么验的 | 结果 |
|---|---|---|
| 安装接线 | 直接读 profile 的 `package.json` / `cordis.patch.yml` | ✅ `link:` + `dsh.profile.bundles` 已落盘 |
| 浏览器半边加载 | `cordis_inspect_query` 查 Client `Slots` 实时占用 | ✅ 两个插槽条目 `active: true` |
| `apply()` 不抛错 | 两个插槽都注册成功（若抛错则第二个不会执行） | ✅ |
| 完整提问链路 | `node test/smoke.mjs` 用迷你 DOM + 迷你 React 真跑 | ✅ 28/28 通过 |
| 虚线匹配与作用域 | 同上，断言命中数量与排除 tool-call | ✅ |
| 点击虚线命中概念 | 同上，注入 caret 位置后派发 click | ✅ |
| 面板能关掉 | 同上，派发 `pointerdown` / Esc 后断言面板消失；点面板内部不误关 | ✅ |
| 文字可读性 | 按主题真实取值算 13 组文字/底色的 WCAG 对比度 | ✅ 浅色最低 4.90:1 / 深色最低 3.85:1 |
| 浏览器 API 可用性 | 读 app 内置 Electron 44 / Chromium 152.0.7977.54 | ✅ 两个 API 都够新 |
| **虚线的实际视觉呈现** | **需要你的眼睛** | ⏳ 我无法截图 |

关于最后一项：CSS Custom Highlight API 需要 Chromium 105+，`document.caretPositionFromPoint` 需要 128+。app 内置的是 **Chromium 152**，两者都满足；但这只能证明 API 存在，**画出来什么样、点击手感如何，得你实际看一眼**。如果哪里不对，把浏览器控制台里 `[study-anchor]` 开头的告警贴出来即可。

## 实现方式与取舍

### 句内虚线是怎么画出来的

官方对话渲染**没有内联文本扩展点**。我逐个确认过 `dsh-client-ui-conversation`、`dsh-client-ui-chat`、`dsh-client-ui-renderer`，以及最接近的 `dsh-client-ui-message-feedback`：官方插件只能往「消息下方按钮行」（`conversation.chat.assistant-actions`）或「输入框内浮层」（`conversation.input.overlay`）这类**位置**里加东西，画不出句内标记。要替换消息渲染器就等于重写整个 assistant 节点视图，不可行。

所以这里用的是浏览器的 **CSS Custom Highlight API**：

```css
::highlight(study-anchor-mark) {
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--dsw-alias-brand-primary);
  text-underline-offset: 3px;
}
```

它**只改绘制结果，不插节点、不改 DOM**，所以不会和 React 的渲染对账冲突 —— 这是它能稳定工作的关键。点击命中用 `document.caretPositionFromPoint`（拿不到时退回 `caretRangeFromPoint`）拿到坐标下的文本位置，再和已注册的 `Range` 做 `comparePoint` 判定。

**代价（需要知道）：** 为了知道「哪些文本出现了这个概念」，插件必须读对话区域（`[data-chat-flow]` 里 `data-chat-flow-kind="assistant-step"` / `"user"` 两类节点）的文本节点。这偏离了「插件不读别的插件的 DOM」这条规范。插件只读不写（唯一例外是给对话容器加 `cursor: pointer` 的手型提示，卸载时会还原），也不碰 `document.body`、不用 `innerHTML`。冒烟测试里对这两点有断言。

如果浏览器不支持 CSS Custom Highlight，句内虚线会静默降级，功能改由输入框上方的概念芯片承担。

### 踩过的坑：`--dsw-alias-brand-primary` 不是强调色

第一版我把主按钮写成 `background: var(--dsw-alias-brand-primary); color: #ffffff`，以为 brand-primary 是个饱和蓝。结果深色模式下按钮变成了**白底白字**，完全看不清 —— 你截图红框指出的就是这个。

查了 app 内置的 `dsh-client-ui-theme` 才发现这个 token 的真实语义：

| token | 浅色模式 | 深色模式 |
|---|---|---|
| `--dsw-alias-brand-primary` | `#0f1115`（近黑） | `#f9fafb`（近白） |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |

也就是说 **brand-primary 是这个主题里对比度最高的「墨色／表面色」**：浅色模式下近黑，深色模式下近白。它还跟 `label-primary` 同值，所以拿它当填充再配白字必然翻车；`brand-primary-invert` 也**不是**它的反色（实测两者同值）。官方那 14 个 token 里没有「brand-primary 填充上的前景色」，说明它本来就不是给填充用的。

所以主按钮改成「品牌色描边 + 14% 品牌色淡底 + 品牌色文字」：文字用 brand-primary，两个模式下都必然与浮层底色 `bg-overlay` 形成足够对比；即使 `color-mix` 不被支持而回退到 `bg-layer-1`，对比度依然充足（深色 15.03:1 / 浅色 18.90:1）。现在主按钮实测**深色 4.09:1 / 浅色 11.86:1**（原来约 1.0:1）。

这也是为什么测试里多了三条断言：主按钮不得出现写死的白色文字、任何 `.sa-*` 规则都不许把白色写死、以及 13 组组合在深浅两个模式下的对比度审计。

### 带入概念会话的上下文

按你选的策略：**用模型先生成摘要**。做法是把主线最近的对话节选交给**概念会话自己的模型**，并要求它先写出「📌 当前主线」（3-5 句）再回答问题。于是：

- 摘要是**模型生成**的，而且是该会话第一条回复的一部分，之后所有追问都能用上；
- 只多花**一次**模型调用的钱（不像「先摘要再提问」要两次）；
- **取舍**：节选原文也留在概念会话历史里，所以 token 占用比「Host 侧一次性摘要、只把摘要写进去」要高。后者需要自建 Host 侧模型调用通道（`ctx.llm.stream` 不是 Remote，客户端调不到；自建 typert Remote 或 HTTP 路由都属于另一个量级的复杂度），所以这版没做。

节选来源是**已渲染出来的对话文本**（`innerText`，会跳过折叠/隐藏的推理块）。这比从 session 事件重构更准 —— 折叠、重放、`surfaceOp` 增量都由对话层处理好了；代价是只覆盖当前已加载的窗口（虚拟滚动下就是最近这部分），对「我最近在学什么」这个用途刚好合适。预算 5000 字，单条消息最多 1500 字。

### 锚点记录存在哪

浏览器的 `localStorage`（键 `dsh.study-anchor.v1`）。纯前端方案，没有 Host 侧逻辑 —— `index.js` 只有一个空的 `apply()`，`cordis.patch.yml` 只有一行 Host row，存在的唯一理由是：bundle 的浏览器半边是通过 Host row 加载的。

数据结构：

```js
{
  id, key, concept, createdAt, updatedAt, lastQuestion,
  visits: [{ sessionId, originSessionId, originTitle, question, at }]
}
```

- `key` 是归一化后的概念文本（折叠空白 + 小写），用来判定「同一个概念」，所以后续对话里同样的词会自动带虚线；
- `visits` 是问过的每一次，所以「继续追问」会新开会话而不覆盖历史；
- 换设备/换浏览器 profile 不同步，agent 也读不到这份记录。清空：在页面控制台执行 `localStorage.removeItem('dsh.study-anchor.v1')`。

## 开发循环

```bash
# 语法检查
node --check client.js

# 冒烟 + 端到端测试
node test/smoke.mjs
```

`test/smoke.mjs` 手写了一个只实现插件真正用到的那几种选择器（`tag`、`[attr]`、`[attr="v"]`、逗号并集）的迷你 DOM，以及一个**真的支持 state 与重渲染**的迷你 React。于是它能真跑完整路径：

> 加载 `client.js` → `apply(ctx)` → 挂载锚点条与浮层 → 派发 `selectionchange` → 点「问这个概念」→ 点「开始提问」→ 断言新建了会话、带上了主线 `cwd`、切了过去、`prompt` 文本包含概念/默认问题/主线节选（且不含 tool-call 文本）、并设了标题

它同时验证虚线层：命中数量、只标注 `assistant-step` / `user`、跨嵌套分组也能标、注入 caret 后的点击命中与未命中。

遇到迷你 DOM 不认识的选择器它会**直接抛错**，所以以后插件里出现新写法，测试会响亮地失败，而不是悄悄放过。

最后还会做一次**对比度审计**：把样式表里 13 组文字/底色组合，按主题在浅色与深色两个模式下的真实取值算一遍 WCAG 对比度，低于 3.5:1 就失败。加 `-v` 会打印每一组的实测值：

```bash
node test/smoke.mjs -v
```

这一节是因为下面那个坑才加的。

改完 `client.js` 之后刷新页面即可（装的是符号链接）。如果页面缓存了旧模块，重启 DSH Desktop。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（浏览器半边从 `exports["./client"]` 加载） |
| `cordis.patch.yml` | 一行 Host row |
| `index.js` | Host 半边，空 `apply()` |
| `client.js` | **全部功能**：选中浮层、提问面板、概念会话创建、虚线标注层、锚点条 |
| `locale/zh.json`、`locale/en.json` | 插件在插件管理里的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/smoke.mjs` | 冒烟 + 端到端测试 + 双模式对比度审计（28 项） |

## 已知限制

1. **句内虚线依赖 CSS Custom Highlight API**。app 内置 Chromium 152 支持；不支持的环境会降级为概念芯片。
2. **UI 文案硬编码中文**，没有走 `ctx.locale`。当前是单语言个人插件；要国际化需要把 `client.js` 顶部的 `TEXT` 表接到 `ctx.locale.register(ns, locale, dict)`。
3. **上下文节选只覆盖当前已加载的对话窗口**（虚拟滚动 + 分页），不是整条会话历史。
4. **概念判定是字面匹配**（归一化后的大小写/空白不敏感），不做词形还原或同义扩展：「幂等」和「幂等性」会被当成两个概念 —— 这也是为什么测试里那个例子里两个概念各自画了虚线。
5. **节选里可能混入少量按钮文案**（复制/重试等），因为 `innerText` 取的是整个消息节点。对「我最近在学什么」影响很小。
6. **点击虚线会拦截这次点击**（阻止冒泡），如果某个概念恰好出现在链接文字里，链接会被拦掉。
7. **会话标题是尽力而为**：依赖 `binding.session.rename()`，被拒绝时只打一条 `console.warn`，不影响提问流程。标题截断到 60 字符。
8. **概念会话是按主线的 `cwd` 新建的**，不是「同一个工作区分组」的严格复制。取不到 `cwd` 时就新建一个未分组会话。

## 下一步可以做的

- 把摘要改成 Host 侧一次性生成（需要自建客户端→Host 调用通道），省掉概念会话里的节选原文；
- 概念归一化加词形/别名合并，或在概念详情里提供「与另一个概念合并」；
- 锚点记录改存 Host 存储域，并暴露成一个 agent 工具，让主线 agent 也知道你问过哪些概念。
