/**
 * study-anchor — browser half.
 *
 * 学习锚点：当你在一段 AI 讲解里遇到看不懂的词句时，选中它、点「问这个概念」，
 * 插件会另开一个独立会话专门解释这个概念（带入主线上下文摘要 + 默认问题，可改），
 * 你可以随时切回原来的主线。问过的概念会在原句和后续出现的同一处留下虚线标记，
 * 点虚线即可回到那个概念会话复习或继续追问。
 *
 * 设计要点
 * - 只用官方 Client 服务：`ctx.sessions`（新建会话 / 发消息）、`ctx.uiWorkspace`
 *   （切会话）、`ctx.slots`（挂 UI）。没有任何 Host 侧面逻辑。
 * - 虚线标记用浏览器的 CSS Custom Highlight API 绘制：它只“上色”，不改动 DOM，
 *   因此不会和 React 的渲染对账打架。官方对话渲染没有内联文本扩展点，这是唯一
 *   能画出“句内虚线”的办法。若浏览器不支持，会自动退化为输入框上方的锚点条。
 * - 锚点记录存在 localStorage（纯前端方案，按浏览器 profile 保存）。
 *
 * This file is intentionally plain JavaScript with no build step: the module
 * loader evaluates it directly and React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'study-anchor',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    const NS = 'study-anchor';

    /** localStorage key：锚点记录。 */
    const STORAGE_KEY = 'dsh.study-anchor.v1';
    /** localStorage key：首次使用提示是否已读。 */
    const HINT_KEY = 'dsh.study-anchor.hint.v1';

    /** 注册到 CSS.highlights 的名字，同时也是 ::highlight() 的参数。 */
    const HIGHLIGHT_NAME = 'study-anchor-mark';

    /** 选中超过这个长度就不当作“概念”处理（避免整段选）。 */
    const MAX_SELECTION_CHARS = 200;
    /** 主线上下文节选的字符预算。 */
    const EXCERPT_BUDGET = 5000;
    /** 单条消息在节选里的最大长度。 */
    const EXCERPT_PER_MESSAGE = 1500;
    /** 高亮重算的最小间隔（毫秒），流式输出时不至于每帧重算。 */
    const RECOMPUTE_INTERVAL_MS = 250;

    /** 官方对话流容器：所有 Chat 节点都在这里。 */
    const CHAT_FLOW_SELECTOR = '[data-chat-flow]';
    /** 只在这两种节点里找文本：助手回答与用户消息，避开工具调用参数等。 */
    const TEXT_SCOPE_SELECTOR =
      '[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="user"]';
    /** 我们自己的 UI 容器标记：标了它的子树一律跳过。 */
    const OWN_UI_ATTR = 'data-study-anchor-ui';

    const DEFAULT_QUESTION =
      '这段话是什么意思？请结合我当前的学习主线，用我能听懂的方式解释一下。';

    /** 所有面向用户的文案集中在这里，方便以后接入 ctx.locale。 */
    const TEXT = {
      askButton: '问这个概念',
      askTitle: '问这个概念',
      conceptLabel: '概念 / 词句',
      questionLabel: '我想问',
      submit: '开始提问',
      cancel: '取消',
      submitting: '正在新建概念会话…',
      backToMain: '回到主 session',
      conceptSessionBadge: '概念会话',
      openConceptSession: '回到这个概念 session',
      askAgain: '继续追问（新开一个 session）',
      askAgainSubmit: '追问',
      removeAnchor: '删除锚点',
      conceptTitlePrefix: '概念：',
      askedTimes: (n, at) => `已问过 ${n} 次 · 最近 ${at}`,
      anchorRow: (n) => `⚓ 本会话问过 ${n} 个概念`,
      noSession: '还没有打开任何会话，先进入一个会话再试。',
      hint: '选中对话里的词句，即可点「问这个概念」单独开一个会话搞懂它。',
      hintDismiss: '知道了',
      noHighlight:
        '当前浏览器不支持 CSS Custom Highlight，句内虚线不可用；可在输入框上方「学习锚点」条里回到概念会话。',
    };

    /** 默认问题文本。 */
    const defaultQuestion = () => DEFAULT_QUESTION;

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    function mintId() {
      return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /** 概念的归一化键：折叠空白 + 小写，用于“同一个概念”的判定。 */
    function conceptKey(text) {
      return String(text || '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function formatTime(ts) {
      try {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
          d.getHours(),
        )}:${pad(d.getMinutes())}`;
      } catch {
        return '';
      }
    }

    /* ------------------------------------------------------------------ *
     * 锚点仓库（localStorage）
     *
     * anchor = {
     *   id, key, concept, createdAt, updatedAt, lastQuestion,
     *   visits: [{ sessionId, originSessionId, originTitle, question, at }]  // 旧 → 新
     * }
     * ------------------------------------------------------------------ */

    let registryCache = null;
    const registryListeners = new Set();

    function isAnchor(value) {
      return (
        value &&
        typeof value === 'object' &&
        typeof value.id === 'string' &&
        typeof value.key === 'string' &&
        typeof value.concept === 'string' &&
        Array.isArray(value.visits)
      );
    }

    function readRegistry() {
      if (registryCache !== null) return registryCache;
      let list = [];
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw === null ? [] : JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed.filter(isAnchor);
      } catch (error) {
        console.warn(`[${NS}] 读取锚点记录失败，将以空记录启动。`, error);
        list = [];
      }
      registryCache = list;
      return registryCache;
    }

    function writeRegistry(next) {
      registryCache = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (error) {
        console.warn(`[${NS}] 保存锚点记录失败（可能超出配额）。`, error);
      }
      for (const listener of [...registryListeners]) {
        try {
          listener();
        } catch (error) {
          console.warn(`[${NS}] 锚点订阅者抛错。`, error);
        }
      }
    }

    function subscribeRegistry(listener) {
      registryListeners.add(listener);
      return () => {
        registryListeners.delete(listener);
      };
    }

    const listAnchors = () => readRegistry();

    function findAnchorByConcept(concept) {
      const key = conceptKey(concept);
      return readRegistry().find((anchor) => anchor.key === key) || null;
    }

    /** 这个会话是不是某个概念的“概念会话”？返回 { anchor, visit }。 */
    function findConceptVisit(sessionId) {
      for (const anchor of readRegistry()) {
        for (let i = anchor.visits.length - 1; i >= 0; i -= 1) {
          if (anchor.visits[i].sessionId === sessionId) {
            return { anchor, visit: anchor.visits[i] };
          }
        }
      }
      return null;
    }

    /** 某个主线会话里问过的所有概念。 */
    function anchorsAskedFrom(originSessionId) {
      return readRegistry().filter((anchor) =>
        anchor.visits.some((visit) => visit.originSessionId === originSessionId),
      );
    }

    function latestVisit(anchor) {
      return anchor.visits.length ? anchor.visits[anchor.visits.length - 1] : null;
    }

    function upsertAnchor({ concept, question, visit }) {
      const key = conceptKey(concept);
      const next = readRegistry().slice();
      const index = next.findIndex((anchor) => anchor.key === key);
      const now = Date.now();
      if (index >= 0) {
        const existing = next[index];
        next[index] = {
          ...existing,
          concept,
          lastQuestion: question,
          updatedAt: now,
          visits: [...existing.visits, visit],
        };
      } else {
        next.push({
          id: mintId(),
          key,
          concept,
          createdAt: now,
          updatedAt: now,
          lastQuestion: question,
          visits: [visit],
        });
      }
      writeRegistry(next);
    }

    function removeAnchorById(id) {
      writeRegistry(readRegistry().filter((anchor) => anchor.id !== id));
    }

    function useAnchors() {
      return useSyncExternalStore(subscribeRegistry, listAnchors, listAnchors);
    }

    /* ------------------------------------------------------------------ *
     * “当前会话”共享 store
     *
     * shell.overlay 是 root 作用域，拿不到 sessionId；而挂在
     * conversation.composer.dock 上的入口是 session 作用域，标准 props 里就有
     * sessionId。让后者把值发布出来，浮层再订阅。
     * ------------------------------------------------------------------ */

    let currentSessionId = null;
    const sessionListeners = new Set();

    function publishCurrentSession(sessionId) {
      if (currentSessionId === sessionId) return;
      currentSessionId = sessionId;
      for (const listener of [...sessionListeners]) {
        try {
          listener();
        } catch (error) {
          console.warn(`[${NS}] 会话订阅者抛错。`, error);
        }
      }
    }

    function subscribeCurrentSession(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    }

    const readCurrentSession = () => currentSessionId;

    function useCurrentSessionId() {
      return useSyncExternalStore(subscribeCurrentSession, readCurrentSession, readCurrentSession);
    }

    /* ------------------------------------------------------------------ *
     * 虚线标记层（CSS Custom Highlight API）
     *
     * ::highlight() 只改变绘制结果，不改 DOM、不插节点，因此不会和 React 打架。
     * 代价是需要读对话区域的文本节点（官方没有内联文本扩展点，这是唯一办法）。
     * ------------------------------------------------------------------ */

    const highlightSupported =
      typeof window !== 'undefined' &&
      typeof window.Highlight === 'function' &&
      typeof window.CSS !== 'undefined' &&
      Boolean(window.CSS.highlights);

    /** [{ anchorId, range }]，当前已注册的高亮，同时用于点击命中判定。 */
    let marks = [];
    let recomputeTimer = 0;
    let lastRecomputeAt = 0;

    function collectTextNodes(root) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(`[${OWN_UI_ATTR}]`)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) nodes.push(walker.currentNode);
      return nodes;
    }

    /** 在一个文本节点里找出 needle 的所有出现位置，返回 Range。 */
    function rangesInTextNode(node, needle) {
      const ranges = [];
      const haystack = node.nodeValue.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        from = at + needle.length;
      }
      return ranges;
    }

    /** 重新计算全部虚线标记。只读 DOM，不写入。 */
    function recomputeMarks() {
      if (!highlightSupported) return;

      const flow = document.querySelector(CHAT_FLOW_SELECTOR);
      if (!flow) {
        marks = [];
        if (window.CSS.highlights.has(HIGHLIGHT_NAME)) window.CSS.highlights.delete(HIGHLIGHT_NAME);
        return;
      }

      const scoped = flow.querySelectorAll(TEXT_SCOPE_SELECTOR);
      const scopes = scoped.length ? Array.from(scoped) : [flow];

      const next = [];
      const ranges = [];
      for (const anchor of readRegistry()) {
        const needle = anchor.concept.toLowerCase();
        if (!needle) continue;
        for (const scope of scopes) {
          for (const node of collectTextNodes(scope)) {
            for (const range of rangesInTextNode(node, needle)) {
              ranges.push(range);
              next.push({ anchorId: anchor.id, range });
            }
          }
        }
      }

      marks = next;
      if (ranges.length === 0) {
        if (window.CSS.highlights.has(HIGHLIGHT_NAME)) window.CSS.highlights.delete(HIGHLIGHT_NAME);
      } else {
        // 用 add() 逐个加入而不是 new Highlight(...ranges)：避免展开运算符的参数个数上限。
        const highlight = new window.Highlight();
        for (const range of ranges) highlight.add(range);
        window.CSS.highlights.set(HIGHLIGHT_NAME, highlight);
      }
    }

    /** 节流重算：流式输出时最多每 RECOMPUTE_INTERVAL_MS 跑一次。 */
    function scheduleRecompute() {
      if (!highlightSupported) return;
      const wait = Math.max(0, RECOMPUTE_INTERVAL_MS - (Date.now() - lastRecomputeAt));
      if (recomputeTimer) return;
      recomputeTimer = window.setTimeout(() => {
        recomputeTimer = 0;
        lastRecomputeAt = Date.now();
        try {
          recomputeMarks();
        } catch (error) {
          console.warn(`[${NS}] 重新计算虚线标记失败。`, error);
        }
      }, wait);
    }

    /** 命中判定：这个视口坐标落在某个已标记的 Range 里吗？ */
    function hitTestMark(clientX, clientY) {
      if (!highlightSupported || marks.length === 0) return null;
      let node = null;
      let offset = 0;
      if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(clientX, clientY);
        if (position) {
          node = position.offsetNode;
          offset = position.offset;
        }
      } else if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (range) {
          node = range.startContainer;
          offset = range.startOffset;
        }
      }
      if (!node) return null;
      for (const mark of marks) {
        try {
          if (mark.range.comparePoint(node, offset) === 0) return mark;
        } catch {
          /* 节点不在同一棵树里：忽略这个候选 */
        }
      }
      return null;
    }

    /* ------------------------------------------------------------------ *
     * 主线上下文节选
     *
     * 直接取对话流里已经渲染出来的文本（innerText 会跳过折叠/隐藏的推理块），
     * 这比从 session 事件重构更准：折叠、重放、surfaceOp 都由对话层处理好了。
     * 代价是只覆盖“当前已加载的窗口”，对“最近在学什么”这个用途刚好够。
     * ------------------------------------------------------------------ */

    function visibleTextOf(element) {
      const raw =
        typeof element.innerText === 'string' && element.innerText
          ? element.innerText
          : element.textContent || '';
      return raw.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
    }

    function collectTurns() {
      const flow = document.querySelector(CHAT_FLOW_SELECTOR);
      if (!flow) return [];
      const turns = [];
      for (const element of flow.querySelectorAll(TEXT_SCOPE_SELECTOR)) {
        const text = visibleTextOf(element);
        if (!text) continue;
        const kind = element.getAttribute('data-chat-flow-kind');
        turns.push({ role: kind === 'user' ? 'user' : 'assistant', text });
      }
      return turns;
    }

    function buildExcerpt() {
      const turns = collectTurns();
      const kept = [];
      let used = 0;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        const text =
          turn.text.length > EXCERPT_PER_MESSAGE
            ? `…${turn.text.slice(-EXCERPT_PER_MESSAGE)}`
            : turn.text;
        if (used + text.length > EXCERPT_BUDGET) break;
        used += text.length;
        kept.unshift({ role: turn.role, text });
      }
      return kept
        .map((turn) => `${turn.role === 'user' ? '我' : '助手'}：${turn.text}`)
        .join('\n\n');
    }

    /* ------------------------------------------------------------------ *
     * 会话操作
     * ------------------------------------------------------------------ */

    function openSession(ctx, sessionId) {
      const uiWorkspace = ctx.get('uiWorkspace');
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        uiWorkspace.openSession(sessionId);
        return true;
      }
      console.warn(
        `[${NS}] uiWorkspace.openSession 不可用，概念会话 ${sessionId} 已创建但没有自动切换过去。`,
      );
      return false;
    }

    /** 主线会话的标题 / cwd，用于让新会话落进同一个工作区分组。 */
    function originSessionInfo(ctx, originSessionId) {
      const sessions = ctx.get('sessions');
      const store = sessions && sessions.list;
      if (!store || typeof store.getSnapshot !== 'function') return {};
      const snapshot = store.getSnapshot();
      const row = snapshot && snapshot.byId ? snapshot.byId[originSessionId] : undefined;
      if (!row) return {};
      return { cwd: typeof row.cwd === 'string' && row.cwd ? row.cwd : undefined, title: row.title };
    }

    /**
     * 概念会话的第一条消息。
     *
     * 用户选择的是「用模型先生成摘要」：这里把主线节选交给概念会话自己的模型，
     * 并要求它先用 3-5 句写出「当前主线」再回答问题。摘要因此是模型生成的、
     * 并且成为该会话的长期背景；代价是节选原文也留在该会话历史里。
     */
    function buildSeed({ concept, question, excerpt }) {
      const lines = [
        '【学习锚点 · 概念提问】',
        '',
        '我在主线对话里遇到一个没搞懂的概念。为了不打断主线，我单独开了这个会话问你。',
        '',
        `我选中的概念 / 词句：「${concept}」`,
        '',
        '我的问题：',
        question,
      ];
      if (excerpt) {
        lines.push(
          '',
          '下面是我那条主线对话最近的内容（节选），请把它当作背景：',
          '<<< 主线上下文',
          excerpt,
          '主线上下文 >>>',
        );
      }
      lines.push(
        '',
        '请这样回复：',
        '1. 先用 3-5 句话写出「📌 当前主线」，概括我在上面这段学习里正在做什么。这部分我会当作本会话的长期背景，之后的追问都不必再重复。',
        '2. 然后另起一段，专门回答我的问题。不要复述我的问题，直接讲清楚。',
      );
      return lines.join('\n');
    }

    /**
     * 新建概念会话、切过去、并把种子消息发进去。
     * @returns {Promise<{ sessionId: string, opened: boolean }>}
     */
    async function createConceptSession(ctx, { concept, question, excerpt, originSessionId }) {
      const sessions = ctx.get('sessions');
      if (!sessions || typeof sessions.create !== 'function') {
        throw new Error('ctx.sessions.create 不可用，无法新建概念会话。');
      }

      const origin = originSessionInfo(ctx, originSessionId);
      const sessionId = await sessions.create(origin.cwd ? { cwd: origin.cwd } : {});

      // 先把视图切过去，用户立刻能看到新会话与正在生成的回答。
      const opened = openSession(ctx, sessionId);

      // 自己持有一份引用，保证 prompt 的往返期间这个 generation 不会被回收。
      const reference = sessions.retain(sessionId, { source: 'gateway' });
      try {
        const binding = await reference.ready;
        const result = await binding.session.prompt(
          [
            {
              type: 'text',
              text: buildSeed({ concept, question, excerpt }),
            },
          ],
          'queue',
        );
        if (!result || result.ok !== true) {
          const detail = result && result.error
            ? `${result.error.code}: ${result.error.message}`
            : '未知原因';
          throw new Error(`发言被拒绝（${detail}）。`);
        }

        // 给概念会话一个能一眼认出来的标题，否则侧栏里每条都是
        // 「【学习锚点 · 概念提问】」。尽力而为：失败不影响主流程。
        try {
          const title = `⚓ ${TEXT.conceptTitlePrefix}${concept}`.slice(0, 60);
          const renamed = await binding.session.rename(title);
          if (!renamed || renamed.ok !== true) {
            console.warn(`[${NS}] 概念会话标题设置被拒绝（不影响功能）。`);
          }
        } catch (error) {
          console.warn(`[${NS}] 概念会话标题设置失败（不影响功能）。`, error);
        }
      } finally {
        reference.release();
      }

      return { sessionId, opened };
    }

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    const CSS_TEXT = `
::highlight(${HIGHLIGHT_NAME}) {
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--dsw-alias-brand-primary, #4b7bf5);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
}
.sa-layer { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.sa-pop, .sa-fab, .sa-chip-row, .sa-hint {
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary, #1b2433);
}
.sa-pop {
  position: fixed;
  box-sizing: border-box;
  width: 344px;
  max-height: 70vh;
  overflow: auto;
  padding: 12px 13px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}
.sa-pop * { box-sizing: border-box; }
.sa-fab {
  position: fixed;
  transform: translateX(-50%);
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
  cursor: pointer;
  white-space: nowrap;
  font-weight: 600;
}
.sa-fab:hover { border-color: var(--dsw-alias-brand-primary, #4b7bf5); }
.sa-title { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
.sa-title .sa-mark-name {
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-color: var(--dsw-alias-brand-primary, #4b7bf5);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
}
.sa-label { display: block; margin: 8px 0 4px; color: var(--dsw-alias-label-secondary, #5b6478); font-size: 12px; }
.sa-input, .sa-textarea {
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: var(--dsw-alias-bg-base, #ffffff);
  color: inherit;
  font: inherit;
  resize: vertical;
}
.sa-textarea { min-height: 62px; }
.sa-input:focus, .sa-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4b7bf5); outline-offset: -1px; }
.sa-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
/* 次要按钮做成描边而不是填充：不然它比「品牌色淡底」的主按钮更抢眼，
 * 详情面板里就会出现「继续追问」比「回到这个概念 session」更突出的倒挂。 */
.sa-btn {
  padding: 5px 11px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.sa-btn:hover { border-color: var(--dsw-alias-brand-primary, #4b7bf5); }
.sa-btn:disabled { opacity: 0.6; cursor: default; }
/* 注意：--dsw-alias-brand-primary 不是「饱和强调色」，而是这个主题里对比度最高的
 * 「墨色／表面色」——深色模式下它近白（#f9fafb），浅色模式下它近黑（#0f1115）。
 * 所以它绝不能被当成填充色再配白色文字（那样深色模式就是白底白字，实测踩过），
 * 也不该配 label-secondary（深色模式下它同样近白，对比度只有 1.2:1）。
 * 官方 token 里没有「brand-primary 填充上的前景色」，说明它本来就不是给填充用的。
 * 这里改成品牌色描边 + 极淡品牌色底：文字用 brand-primary，在两个模式下都必然
 * 与浮层底色 bg-overlay 形成足够对比；即使 color-mix 不被支持而回退到 .sa-btn 的
 * bg-layer-1，对比度依然充足（深色 14:1 / 浅色 19:1）。 */
.sa-btn-primary {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  border-color: var(--dsw-alias-brand-primary, #4b7bf5);
  color: var(--dsw-alias-brand-primary, #4b7bf5);
  font-weight: 650;
}
.sa-btn-quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary, #5b6478); }
.sa-error { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(190, 18, 60, 0.1); color: var(--dsw-alias-state-error-primary, #be123c); font-size: 12px; }
.sa-note { margin-top: 6px; color: var(--dsw-alias-label-secondary, #5b6478); font-size: 12px; }
.sa-quote { margin: 0; padding: 6px 9px; border-left: 3px dashed var(--dsw-alias-brand-primary, #4b7bf5); color: var(--dsw-alias-label-secondary, #5b6478); font-size: 12px; max-height: 96px; overflow: auto; white-space: pre-wrap; }
.sa-chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 auto 6px; width: fit-content; max-width: 92%; padding: 5px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #eef0f5); }
.sa-chip {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px dashed var(--dsw-alias-brand-primary, #4b7bf5);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-chip:hover { background: var(--dsw-alias-bg-overlay, #ffffff); }
.sa-chip-label { color: var(--dsw-alias-label-secondary, #5b6478); font-size: 12px; }
.sa-hint { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.14)); box-shadow: 0 6px 18px rgba(0,0,0,0.16); max-width: 320px; }
`;

    function Style() {
      return h('style', { [`data-${NS}-style`]: '' }, CSS_TEXT);
    }

    /* ------------------------------------------------------------------ *
     * 弹出层定位
     * ------------------------------------------------------------------ */

    function placePopover(x, y, width, estimatedHeight, preferAbove) {
      const pad = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = x - width / 2;
      let top = preferAbove ? y - estimatedHeight - 14 : y + 14;
      if (top + estimatedHeight > viewportHeight - pad) top = y - estimatedHeight - 14;
      if (top < pad) top = clamp(y + 14, pad, Math.max(pad, viewportHeight - estimatedHeight - pad));
      left = clamp(left, pad, Math.max(pad, viewportWidth - width - pad));
      return { left: Math.round(left), top: Math.round(top) };
    }

    /* ------------------------------------------------------------------ *
     * 浮层：选中 → 提问；点虚线 → 回概念会话
     * ------------------------------------------------------------------ */

    function Overlay({ ctx }) {
      const anchors = useAnchors();
      const sessionId = useCurrentSessionId();

      const [selection, setSelection] = useState(null); // { text, x, y, above }
      const [compose, setCompose] = useState(null); // { concept, question, x, y }
      const [detail, setDetail] = useState(null); // { anchorId, x, y, followUp }
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [hintVisible, setHintVisible] = useState(() => {
        try {
          return window.localStorage.getItem(HINT_KEY) !== '1';
        } catch {
          return false;
        }
      });

      const busyRef = useRef(false);
      busyRef.current = busy;

      /* --- 选中文本 → 浮动按钮 --- */
      useEffect(() => {
        let hideTimer = 0;

        const hideSoon = () => {
          if (hideTimer) window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            setSelection(null);
          }, 220);
        };

        const onSelectionChange = () => {
          if (busyRef.current) return;
          const active = document.activeElement;
          if (active && active.closest && active.closest(`[${OWN_UI_ATTR}]`)) return;

          const sel = document.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            hideSoon();
            return;
          }
          const text = String(sel.toString()).replace(/\s+/gu, ' ').trim();
          if (!text || text.length > MAX_SELECTION_CHARS) {
            hideSoon();
            return;
          }
          const range = sel.getRangeAt(0);
          const flow = document.querySelector(CHAT_FLOW_SELECTOR);
          if (!flow || !flow.contains(range.commonAncestorContainer)) {
            hideSoon();
            return;
          }
          const rect = range.getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            hideSoon();
            return;
          }
          if (hideTimer) {
            window.clearTimeout(hideTimer);
            hideTimer = 0;
          }
          setSelection({
            text,
            x: rect.left + rect.width / 2,
            y: rect.top,
            above: rect.top < 120,
          });
        };

        document.addEventListener('selectionchange', onSelectionChange);
        return () => {
          document.removeEventListener('selectionchange', onSelectionChange);
          if (hideTimer) window.clearTimeout(hideTimer);
        };
      }, []);

      /* --- 点虚线 → 概念详情 --- */
      useEffect(() => {
        const onClick = (event) => {
          const target = event.target;
          if (target && target.closest) {
            if (target.closest(`[${OWN_UI_ATTR}]`)) return;
            if (target.closest('a, button, input, textarea, select, [contenteditable="true"]')) {
              return;
            }
          }
          const mark = hitTestMark(event.clientX, event.clientY);
          if (!mark) return;
          setSelection(null);
          setCompose(null);
          setDetail({ anchorId: mark.anchorId, x: event.clientX, y: event.clientY, followUp: null });
        };
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
      }, []);

      /* --- 鼠标移到虚线上时给出手型提示 --- */
      useEffect(() => {
        if (!highlightSupported) return undefined;
        let raf = 0;
        let lastMark = null;
        const onMove = (event) => {
          if (raf) return;
          raf = window.requestAnimationFrame(() => {
            raf = 0;
            const flow = document.querySelector(CHAT_FLOW_SELECTOR);
            if (!flow) return;
            const mark = hitTestMark(event.clientX, event.clientY);
            if (mark === lastMark) return;
            lastMark = mark;
            flow.style.cursor = mark ? 'pointer' : '';
          });
        };
        document.addEventListener('mousemove', onMove, { passive: true });
        return () => {
          document.removeEventListener('mousemove', onMove);
          if (raf) window.cancelAnimationFrame(raf);
          const flow = document.querySelector(CHAT_FLOW_SELECTOR);
          if (flow) flow.style.cursor = '';
        };
      }, []);

      /* --- 点面板外面 / 按 Esc 关掉浮动面板 --- */
      useEffect(() => {
        // 我自己的界面元素都带 OWN_UI_ATTR，所以「点到面板里」会在这里被放过。
        const isOwnUi = (target) =>
          Boolean(target && target.closest && target.closest(`[${OWN_UI_ATTR}]`));

        // 已经是 null 时这几个 setter 都是 no-op（Object.is 相等，React 会跳过重渲染），
        // 所以可以无条件全关一遍。
        const closeAll = () => {
          setCompose(null);
          setDetail(null);
          setSelection(null);
        };

        const onPointerDown = (event) => {
          // 点对话里的虚线本身是「换一个面板显示」，真正的打开交给下面的 click 处理。
          if (isOwnUi(event.target)) return;
          closeAll();
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          closeAll();
        };

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      const dismissHint = useCallback(() => {
        setHintVisible(false);
        try {
          window.localStorage.setItem(HINT_KEY, '1');
        } catch {
          /* 忽略 */
        }
      }, []);

      const openCompose = useCallback(() => {
        setError(null);
        setCompose({
          concept: selection ? selection.text : '',
          question: defaultQuestion(),
          x: selection ? selection.x : window.innerWidth / 2,
          y: selection ? selection.y : 160,
        });
        setSelection(null);
      }, [selection]);

      const cancelCompose = useCallback(() => {
        setCompose(null);
        setError(null);
        setBusy(false);
      }, []);

      const submitCompose = useCallback(async () => {
        if (!compose) return;
        if (!sessionId) {
          setError(TEXT.noSession);
          return;
        }
        const concept = compose.concept.replace(/\s+/gu, ' ').trim();
        const question = compose.question.trim() || defaultQuestion();
        if (!concept) {
          setError('请填写要提问的概念。');
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const excerpt = buildExcerpt();
          const origin = originSessionInfo(ctx, sessionId);
          const created = await createConceptSession(ctx, {
            concept,
            question,
            excerpt,
            originSessionId: sessionId,
          });
          upsertAnchor({
            concept,
            question,
            visit: {
              sessionId: created.sessionId,
              originSessionId: sessionId,
              originTitle: origin.title,
              question,
              at: Date.now(),
            },
          });
          setCompose(null);
          const sel = document.getSelection();
          if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges();
          scheduleRecompute();
        } catch (err) {
          console.warn(`[${NS}] 新建概念会话失败。`, err);
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, [compose, ctx, sessionId]);

      const detailAnchor = detail
        ? anchors.find((anchor) => anchor.id === detail.anchorId) || null
        : null;

      const submitFollowUp = useCallback(async () => {
        if (!detail || !detailAnchor) return;
        const question = String(detail.followUp || '').trim();
        if (!question) return;
        setBusy(true);
        setError(null);
        try {
          const origin = originSessionInfo(ctx, detailAnchor.visits[0].originSessionId);
          const created = await createConceptSession(ctx, {
            concept: detailAnchor.concept,
            question,
            excerpt: buildExcerpt(),
            originSessionId: sessionId || detailAnchor.visits[0].originSessionId,
          });
          upsertAnchor({
            concept: detailAnchor.concept,
            question,
            visit: {
              sessionId: created.sessionId,
              originSessionId: sessionId || detailAnchor.visits[0].originSessionId,
              originTitle: origin.title,
              question,
              at: Date.now(),
            },
          });
          setDetail(null);
        } catch (err) {
          console.warn(`[${NS}] 追问会话创建失败。`, err);
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, [ctx, detail, detailAnchor, sessionId]);

      const removeDetail = useCallback(() => {
        if (!detailAnchor) return;
        removeAnchorById(detailAnchor.id);
        setDetail(null);
        scheduleRecompute();
      }, [detailAnchor]);

      const openConcept = useCallback(
        (targetSessionId) => {
          if (!targetSessionId) return;
          openSession(ctx, targetSessionId);
          setDetail(null);
        },
        [ctx],
      );

      /* --- 渲染 --- */
      const nodes = [h(Style, { key: 'style' })];

      if (selection && !compose && !detail) {
        nodes.push(
          h(
            'button',
            {
              key: 'fab',
              type: 'button',
              className: 'sa-fab',
              [OWN_UI_ATTR]: '',
              style: {
                left: `${Math.round(clamp(selection.x, 70, window.innerWidth - 70))}px`,
                top: `${Math.round(
                  selection.above ? selection.y + 26 : selection.y - 38,
                )}px`,
              },
              onMouseDown: (event) => event.preventDefault(),
              onClick: openCompose,
            },
            `⚓ ${TEXT.askButton}`,
          ),
        );
      }

      if (compose) {
        const width = 344;
        const height = 300;
        const position = placePopover(compose.x, compose.y, width, height, false);
        nodes.push(
          h(
            'div',
            {
              key: 'compose',
              className: 'sa-pop',
              [OWN_UI_ATTR]: '',
              style: { left: `${position.left}px`, top: `${position.top}px`, width: `${width}px` },
            },
            h('p', { className: 'sa-title' }, `⚓ ${TEXT.askTitle}`),
            h('label', { className: 'sa-label' }, TEXT.conceptLabel),
            h('input', {
              className: 'sa-input',
              value: compose.concept,
              [OWN_UI_ATTR]: '',
              onChange: (event) => setCompose({ ...compose, concept: event.target.value }),
            }),
            h('label', { className: 'sa-label' }, TEXT.questionLabel),
            h('textarea', {
              className: 'sa-textarea',
              value: compose.question,
              [OWN_UI_ATTR]: '',
              onChange: (event) => setCompose({ ...compose, question: event.target.value }),
            }),
            h(
              'div',
              { className: 'sa-note' },
              '会新开一个会话，并把这条主线最近的内容作为背景一起带过去。',
            ),
            error ? h('div', { className: 'sa-error' }, error) : null,
            h(
              'div',
              { className: 'sa-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'sa-btn sa-btn-quiet',
                  [OWN_UI_ATTR]: '',
                  disabled: busy,
                  onClick: cancelCompose,
                },
                TEXT.cancel,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sa-btn sa-btn-primary',
                  [OWN_UI_ATTR]: '',
                  disabled: busy,
                  onClick: submitCompose,
                },
                busy ? TEXT.submitting : TEXT.submit,
              ),
            ),
          ),
        );
      }

      if (detail && detailAnchor) {
        const width = 344;
        const height = detail.followUp === null ? 220 : 320;
        const position = placePopover(detail.x, detail.y, width, height, true);
        const latest = latestVisit(detailAnchor);
        const lastQuestion = latest ? latest.question : detailAnchor.lastQuestion;
        nodes.push(
          h(
            'div',
            {
              key: 'detail',
              className: 'sa-pop',
              [OWN_UI_ATTR]: '',
              style: { left: `${position.left}px`, top: `${position.top}px`, width: `${width}px` },
            },
            h(
              'p',
              { className: 'sa-title' },
              '⚓ ',
              h('span', { className: 'sa-mark-name' }, detailAnchor.concept),
            ),
            h(
              'div',
              { className: 'sa-note' },
              TEXT.askedTimes(detailAnchor.visits.length, formatTime(detailAnchor.updatedAt)),
            ),
            lastQuestion ? h('p', { className: 'sa-quote' }, lastQuestion) : null,
            error ? h('div', { className: 'sa-error' }, error) : null,
            h(
              'div',
              { className: 'sa-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'sa-btn sa-btn-quiet',
                  [OWN_UI_ATTR]: '',
                  onClick: removeDetail,
                },
                TEXT.removeAnchor,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sa-btn',
                  [OWN_UI_ATTR]: '',
                  onClick: () =>
                    setDetail(
                      detail.followUp === null ? { ...detail, followUp: '' } : { ...detail, followUp: null },
                    ),
                },
                TEXT.askAgain,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sa-btn sa-btn-primary',
                  [OWN_UI_ATTR]: '',
                  onClick: () => openConcept(latest ? latest.sessionId : null),
                },
                TEXT.openConceptSession,
              ),
            ),
            detail.followUp !== null
              ? h(
                  'div',
                  null,
                  h('label', { className: 'sa-label' }, TEXT.questionLabel),
                  h('textarea', {
                    className: 'sa-textarea',
                    value: detail.followUp,
                    [OWN_UI_ATTR]: '',
                    onChange: (event) => setDetail({ ...detail, followUp: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'sa-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sa-btn sa-btn-primary',
                        [OWN_UI_ATTR]: '',
                        disabled: busy || !String(detail.followUp || '').trim(),
                        onClick: submitFollowUp,
                      },
                      TEXT.askAgainSubmit,
                    ),
                  ),
                )
              : null,
          ),
        );
      }

      if (hintVisible && highlightSupported) {
        nodes.push(
          h(
            'div',
            { key: 'hint', className: 'sa-hint', [OWN_UI_ATTR]: '' },
            h('span', null, TEXT.hint),
            h(
              'button',
              {
                type: 'button',
                className: 'sa-btn sa-btn-quiet',
                [OWN_UI_ATTR]: '',
                onClick: dismissHint,
              },
              TEXT.hintDismiss,
            ),
          ),
        );
      }

      return h('div', { className: 'sa-layer', [OWN_UI_ATTR]: '' }, nodes);
    }

    /* ------------------------------------------------------------------ *
     * 输入框上方的锚点条（session 作用域）
     *
     * 两个职责：
     *  1. 把当前 sessionId 发布给浮层（浮层是 root 作用域，拿不到）；
     *  2. 当自己在“概念会话”里时给出「回到主 session」；否则列出本会话问过的概念。
     * ------------------------------------------------------------------ */

    function AnchorDock({ ctx, sessionId }) {
      const anchors = useAnchors();

      useEffect(() => {
        publishCurrentSession(sessionId);
        return () => {
          if (readCurrentSession() === sessionId) publishCurrentSession(null);
        };
      }, [sessionId]);

      const here = anchors.find((anchor) =>
        anchor.visits.some((visit) => visit.sessionId === sessionId),
      );
      if (here) {
        const visit = [...here.visits].reverse().find((item) => item.sessionId === sessionId);
        return h(
          'div',
          { className: 'sa-chip-row', [OWN_UI_ATTR]: '' },
          h(Style, {}),
          h('span', { className: 'sa-chip-label' }, '⚓ 概念会话：'),
          h('span', { className: 'sa-mark-name' }, here.concept),
          visit && visit.originSessionId
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sa-chip',
                  [OWN_UI_ATTR]: '',
                  onClick: () => openSession(ctx, visit.originSessionId),
                },
                `← ${TEXT.backToMain}${visit.originTitle ? `「${visit.originTitle}」` : ''}`,
              )
            : null,
        );
      }

      const mine = anchorsAskedFrom(sessionId);
      if (mine.length === 0) return h(Style, {});

      return h(
        'div',
        { className: 'sa-chip-row', [OWN_UI_ATTR]: '' },
        h(Style, {}),
        h('span', { className: 'sa-chip-label' }, TEXT.anchorRow(mine.length)),
        ...mine.map((anchor) => {
          const latest = latestVisit(anchor);
          return h(
            'button',
            {
              key: anchor.id,
              type: 'button',
              className: 'sa-chip',
              [OWN_UI_ATTR]: '',
              title: latest ? latest.question : anchor.concept,
              onClick: () => latest && openSession(ctx, latest.sessionId),
            },
            anchor.concept,
          );
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */

    return {
      name: NS,
      inject: ['slots', 'sessions'],

      apply(ctx) {
        // 虚线标记层：观察对话流的增量变化，节流重算；卸载时清干净。
        ctx.effect(() => {
          if (!highlightSupported) {
            console.warn(`[${NS}] ${TEXT.noHighlight}`);
            return undefined;
          }

          const observer = new MutationObserver((records) => {
            for (const record of records) {
              const target = record.target;
              const element =
                target && target.nodeType === 1 ? target : target ? target.parentElement : null;
              if (element && element.closest && element.closest(`[${OWN_UI_ATTR}]`)) continue;
              scheduleRecompute();
              return;
            }
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
          });

          const unsubscribe = subscribeRegistry(scheduleRecompute);
          scheduleRecompute();

          return () => {
            observer.disconnect();
            unsubscribe();
            if (recomputeTimer) {
              window.clearTimeout(recomputeTimer);
              recomputeTimer = 0;
            }
            marks = [];
            if (window.CSS.highlights.has(HIGHLIGHT_NAME)) {
              window.CSS.highlights.delete(HIGHLIGHT_NAME);
            }
          };
        }, `${NS}: 虚线标记层`);

        // 浮层：选中文案的浮动按钮、提问面板、概念详情。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: NS, order: 50, label: '学习锚点' },
            () => h(Overlay, { ctx }),
          ),
        );

        // 锚点条：发布当前会话 + 「回到主 session」入口 + 概念芯片（无高亮时的退路）。
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: NS, order: 20, label: '学习锚点' },
            ({ sessionId }) => h(AnchorDock, { ctx, sessionId }),
          ),
        );
      },
    };
  },
});
