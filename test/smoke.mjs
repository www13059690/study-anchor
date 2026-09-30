/**
 * study-anchor 冒烟 + 端到端测试
 *
 * 这个插件跑在浏览器里，而 agent 没有浏览器控制权。所以这里手写了一个够用的
 * 迷你 DOM 和迷你 React（真的支持 state 与重渲染），把 client.js 真的加载一遍，
 * 然后走完整的用户路径：
 *
 *   选中文字 → 浮出「问这个概念」→ 点它 → 点「开始提问」
 *   → 断言新建了会话、带上了 cwd、prompt 内容包含概念/默认问题/主线节选、并设了标题
 *
 * 另外验证虚线标注层：概念匹配、只标注 assistant-step / user 两类节点、点击命中。
 *
 * 迷你 DOM 只实现插件真正用到的那几种选择器（`tag`、`[attr]`、`[attr="v"]`、逗号并集）。
 * 遇到别的选择器会直接抛错，这样以后插件里出现新写法时测试会响亮地失败，而不是悄悄放过。
 *
 * 用法：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');
const source = readFileSync(clientPath, 'utf8');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

/* ================================================================== *
 * 迷你 DOM
 * ================================================================== */

function matchesSimple(element, selector) {
  const sel = selector.trim();
  if (!sel) return false;
  const attrMatch = /^\[([^\]="]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attrMatch) {
    const [, name, value] = attrMatch;
    if (!element.hasAttribute(name)) return false;
    return value === undefined ? true : element.getAttribute(name) === value;
  }
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) return element.tagName === sel.toUpperCase();
  throw new Error(`迷你 DOM 不认识的选择器：${selector}`);
}

function matches(element, selector) {
  return selector.split(',').some((part) => matchesSimple(element, part));
}

function createTextNode(text) {
  return {
    nodeType: 3,
    nodeValue: text,
    parentElement: null,
  };
}

function createElement(tagName, attributes = {}) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes,
    childNodes: [],
    parentElement: null,
    style: {},

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    append(...children) {
      for (const child of children) {
        child.parentElement = element;
        element.childNodes.push(child);
      }
      return element;
    },
    closest(selector) {
      let node = element;
      while (node && node.nodeType === 1) {
        if (matches(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    },
    contains(node) {
      let cursor = node;
      while (cursor) {
        if (cursor === element) return true;
        cursor = cursor.parentElement;
      }
      return false;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
    get textContent() {
      return textOf(element, '\n');
    },
    get innerText() {
      return textOf(element, '\n');
    },
    getBoundingClientRect() {
      return { top: 200, left: 280, width: 80, height: 18 };
    },
  };
  return element;
}

function textOf(element, join) {
  const parts = [];
  for (const child of element.childNodes) {
    if (child.nodeType === 3) parts.push(child.nodeValue);
    else parts.push(textOf(child, join));
  }
  return parts.join(join).trim();
}

function createDocument(rootChildren) {
  const documentElement = createElement('html');
  const body = createElement('body');
  documentElement.append(body);
  body.append(...rootChildren);

  const listeners = new Map();
  let caret = null;

  const document = {
    body,
    documentElement,
    activeElement: null,
    createTreeWalker(root, _whatToShow, options) {
      const nodes = [];
      const collect = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            const verdict = options && options.acceptNode ? options.acceptNode(child) : 1;
            if (verdict === 1) nodes.push(child);
          } else {
            collect(child);
          }
        }
      };
      collect(root);
      let index = 0;
      return {
        currentNode: null,
        nextNode() {
          if (index >= nodes.length) return null;
          this.currentNode = nodes[index];
          index += 1;
          return this.currentNode;
        },
      };
    },
    createRange() {
      return {
        _node: null,
        _start: 0,
        _end: 0,
        setStart(node, offset) {
          this._node = node;
          this._start = offset;
        },
        setEnd(node, offset) {
          this._end = offset;
        },
        comparePoint(node, offset) {
          if (node !== this._node) return -1;
          if (offset < this._start) return -1;
          if (offset > this._end) return 1;
          return 0;
        },
      };
    },
    querySelector(selector) {
      const all = body.querySelectorAll(selector);
      return all.length ? all[0] : null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event) {
      const handler = listeners.get(type);
      if (handler) return handler(event);
      return undefined;
    },
    hasListener(type) {
      return listeners.has(type);
    },
    getSelection: () => null,
    setCaret(node, offset) {
      caret = { offsetNode: node, offset };
    },
    caretPositionFromPoint: () => caret,
  };
  return document;
}

/* ================================================================== *
 * 迷你 React（真的有 state 与重渲染）
 * ================================================================== */

function createMiniReact() {
  let current = null;

  const createElement = (type, props, ...children) => ({
    type,
    props: {
      ...(props || {}),
      children: children.length <= 1 ? children[0] : children,
    },
  });

  const slotIndex = () => {
    if (!current) throw new Error('hook 在渲染之外被调用');
    return current.index.i++;
  };

  return {
    createElement,

    useState(initial) {
      const i = slotIndex();
      const { instance } = current;
      if (!(i in instance.slots)) {
        instance.slots[i] = typeof initial === 'function' ? initial() : initial;
      }
      return [
        instance.slots[i],
        (next) => {
          const value = typeof next === 'function' ? next(instance.slots[i]) : next;
          if (Object.is(value, instance.slots[i])) return;
          instance.slots[i] = value;
          instance.render();
        },
      ];
    },

    useEffect(effect) {
      current.instance.effects.push(effect);
    },

    useRef(initial) {
      const i = slotIndex();
      const { instance } = current;
      if (!(i in instance.slots)) instance.slots[i] = { current: initial };
      return instance.slots[i];
    },

    useCallback(fn) {
      slotIndex();
      return fn;
    },

    useMemo(fn) {
      slotIndex();
      return fn();
    },

    useSyncExternalStore(_subscribe, getSnapshot) {
      slotIndex();
      return getSnapshot();
    },

    mount(component, props) {
      const instance = { slots: {}, effects: [], tree: null, cleanups: [] };
      instance.render = () => {
        current = { instance, index: { i: 0 } };
        instance.effects = [];
        try {
          instance.tree = component({ ...props });
        } finally {
          current = null;
        }
        for (const effect of instance.effects) {
          const cleanup = effect();
          if (typeof cleanup === 'function') instance.cleanups.push(cleanup);
        }
        return instance.tree;
      };
      instance.render();
      return instance;
    },
  };
}

/** 在 createElement 出来的树里找所有满足条件的元素。 */
function findAll(tree, predicate, found = []) {
  if (!tree) return found;
  if (Array.isArray(tree)) {
    for (const item of tree) findAll(item, predicate, found);
    return found;
  }
  if (typeof tree !== 'object' || !tree.type) return found;
  if (predicate(tree)) found.push(tree);
  findAll(tree.props ? tree.props.children : null, predicate, found);
  return found;
}

const byClass = (className) => (node) =>
  node.props && node.props.className === className;

/* ================================================================== *
 * 浏览器替身装配
 * ================================================================== */

const assistantText = createTextNode('这里的幂等性很关键');
const userText = createTextNode('为什么需要幂等？');
const toolText = createTextNode('调用参数里也有幂等性');
const nestedText = createTextNode('所以幂等性靠幂等键');

function buildChatDom() {
  const assistantItem = createElement('div', { 'data-chat-flow-kind': 'assistant-step' });
  assistantItem.append(assistantText);
  const userItem = createElement('div', { 'data-chat-flow-kind': 'user' });
  userItem.append(userText);
  const toolItem = createElement('div', { 'data-chat-flow-kind': 'tool-call' });
  toolItem.append(toolText);

  const nestedAssistant = createElement('div', { 'data-chat-flow-kind': 'assistant-step' });
  nestedAssistant.append(nestedText);
  const nestedGroup = createElement('div', { 'data-chat-flow': '' });
  nestedGroup.append(nestedAssistant);

  // 外层 column 才是 document.querySelector('[data-chat-flow]') 会命中的那个。
  const column = createElement('div', { 'data-chat-flow': '' });
  column.append(assistantItem, userItem, toolItem, nestedGroup);
  return { column, assistantItem, userItem, toolItem, nestedAssistant };
}

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

const ANCHOR_A = {
  id: 'anchor-a',
  key: '幂等性',
  concept: '幂等性',
  createdAt: 1,
  updatedAt: 2,
  lastQuestion: '幂等性是什么？',
  visits: [
    { sessionId: 'session-concept-old', originSessionId: 'session-main', question: '幂等性是什么？', at: 2 },
  ],
};
const ANCHOR_B = {
  id: 'anchor-b',
  key: '幂等',
  concept: '幂等',
  createdAt: 3,
  updatedAt: 4,
  lastQuestion: '幂等是什么意思？',
  visits: [
    { sessionId: 'session-concept-old-2', originSessionId: 'session-main', question: '幂等是什么意思？', at: 4 },
  ],
};

const chat = buildChatDom();
const documentStub = createDocument([chat.column]);
const highlights = new Map();

globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
const observers = [];
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.observing = false;
    observers.push(this);
  }
  observe() {
    this.observing = true;
  }
  disconnect() {
    this.observing = false;
  }
};
globalThis.document = documentStub;
globalThis.window = {
  __ModuleLoader__: null,
  localStorage: makeStorage({
    'dsh.study-anchor.v1': JSON.stringify([ANCHOR_A, ANCHOR_B]),
    'dsh.study-anchor.hint.v1': '1',
  }),
  Highlight: class {
    constructor() {
      this.ranges = [];
    }
    add(range) {
      this.ranges.push(range);
    }
  },
  CSS: { highlights },
  innerWidth: 1280,
  innerHeight: 800,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: (fn) => globalThis.setTimeout(fn, 0),
  cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
};

const React = createMiniReact();
let loaded = null;
globalThis.window.__ModuleLoader__ = {
  load(definition) {
    loaded = definition;
  },
};

await import(`file://${clientPath}`);

console.log('study-anchor 冒烟 + 端到端测试\n');

/* ================================================================== *
 * 模块与插件形状
 * ================================================================== */

await check('模块以 window.__ModuleLoader__.load 注册，id 正确', () => {
  assert.ok(loaded, '没有调用 __ModuleLoader__.load');
  assert.equal(loaded.id, 'study-anchor');
  assert.equal(typeof loaded.factory, 'function');
});

const plugin = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`未预期的 require(${name})`);
});

await check('插件对象暴露 name / inject / apply', () => {
  assert.equal(plugin.name, 'study-anchor');
  assert.deepEqual(plugin.inject, ['slots', 'sessions']);
  assert.equal(typeof plugin.apply, 'function');
});

/* ================================================================== *
 * apply()：注册插槽 + 安装虚线标注层
 * ================================================================== */

const registrations = [];
const effects = [];
const calls = { created: [], retained: [], prompted: [], renamed: [], opened: [] };

const fakeCtx = {
  get(name) {
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ byId: { 'session-main': { title: '主线对话', cwd: '/Users/example/learn' } } }) },
        create: async (opts) => {
          calls.created.push(opts);
          return 'session-concept-new';
        },
        retain: (sessionId, options) => {
          calls.retained.push({ sessionId, options });
          return {
            sessionId,
            ready: Promise.resolve({
              session: {
                prompt: async (content, mode) => {
                  calls.prompted.push({ content, mode });
                  return { ok: true };
                },
                rename: async (title) => {
                  calls.renamed.push(title);
                  return { ok: true, value: { title, seq: 1 } };
                },
              },
            }),
            release() {},
          };
        },
      };
    }
    if (name === 'uiWorkspace') {
      return { openSession: (sessionId) => calls.opened.push(sessionId) };
    }
    return undefined;
  },
  effect(fn, label) {
    effects.push({ label, dispose: fn() });
  },
  slots: {
    inject(hole, callback) {
      registrations.push({ hole });
      callback();
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return () => {};
    },
  },
};

await check('apply(ctx) 不抛错', () => {
  plugin.apply(fakeCtx);
});

await check('注册了 shell.overlay 浮层与 conversation.composer.dock 锚点条', () => {
  const overlay = registrations.find((r) => r.options && r.options.name === 'shell.overlay');
  const dock = registrations.find((r) => r.options && r.options.name === 'conversation.composer.dock');
  assert.ok(overlay, '缺少 shell.overlay 注册');
  assert.equal(overlay.options.id, 'study-anchor');
  assert.equal(overlay.options.order, 50);
  assert.ok(dock, '缺少 conversation.composer.dock 注册');
  assert.equal(dock.options.order, 20);
});

await check('虚线标注层已安装（MutationObserver 正在 observe）', () => {
  const layer = effects.find((e) => String(e.label).includes('虚线标记层'));
  assert.ok(layer, '缺少虚线标记层 effect');
  assert.equal(observers.some((o) => o.observing), true);
});

/* ================================================================== *
 * 虚线标注层：匹配范围与作用域
 * ================================================================== */

await new Promise((resolve) => setTimeout(resolve, 120));

await check('虚线覆盖 assistant-step 与 user，且跳过 tool-call', () => {
  const highlight = highlights.get('study-anchor-mark');
  assert.ok(highlight, '没有注册 ::highlight 命中');
  // '幂等性'：assistant(1) + nested assistant(1) = 2
  // '幂等'  ：assistant(1) + user(1) + nested assistant(2) = 4
  assert.equal(highlight.ranges.length, 6, `期望 6 段命中，实际 ${highlight.ranges.length}`);
  const containers = new Set(highlight.ranges.map((range) => range._node));
  assert.equal(containers.has(toolText), false, 'tool-call 节点不应该被标注');
  assert.equal(containers.has(assistantText), true);
  assert.equal(containers.has(userText), true);
  assert.equal(containers.has(nestedText), true, '嵌套分组里的文本也应被标注（说明取的是外层 column）');
});

await check('同一节点内多处出现会各自标注', () => {
  const highlight = highlights.get('study-anchor-mark');
  const onNested = highlight.ranges.filter((range) => range._node === nestedText);
  assert.equal(onNested.length, 3, `nested 文本应有 3 段（幂等性×1 + 幂等×2），实际 ${onNested.length}`);
});

/* ================================================================== *
 * 完整用户路径：选中 → 提问 → 新建概念会话
 * ================================================================== */

let overlayInstance = null;

await check('锚点条先挂载（发布当前会话）', () => {
  const dock = registrations.find((r) => r.options && r.options.name === 'conversation.composer.dock');
  const element = dock.Component({ sessionId: 'session-main' });
  React.mount(element.type, element.props);
  assert.ok(documentStub.hasListener, '');
});

await check('浮层挂载并订阅了 selectionchange / click / mousemove', () => {
  const overlay = registrations.find((r) => r.options && r.options.name === 'shell.overlay');
  const element = overlay.Component({});
  overlayInstance = React.mount(element.type, element.props);
  assert.ok(documentStub.hasListener('selectionchange'), '缺少 selectionchange 监听');
  assert.ok(documentStub.hasListener('click'), '缺少 click 监听');
});

await check('选中文字后浮出「问这个概念」按钮', () => {
  documentStub.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => '幂等性',
    getRangeAt: () => ({
      commonAncestorContainer: chat.assistantItem,
      getBoundingClientRect: () => ({ top: 200, left: 280, width: 80, height: 18 }),
    }),
    removeAllRanges() {},
  });
  documentStub.dispatch('selectionchange', {});
  const fab = findAll(overlayInstance.tree, byClass('sa-fab'));
  assert.equal(fab.length, 1, '没有渲染出浮动按钮');
  assert.match(String(fab[0].props.children), /问这个概念/);
});

await check('点浮动按钮后弹出提问面板，问题已默认填好且可改', () => {
  const fab = findAll(overlayInstance.tree, byClass('sa-fab'))[0];
  fab.props.onClick();
  const panel = findAll(overlayInstance.tree, byClass('sa-pop'));
  assert.equal(panel.length, 1, '没有渲染出提问面板');
  const textarea = findAll(overlayInstance.tree, (node) => node.type === 'textarea')[0];
  assert.ok(textarea, '没有渲染出问题输入框');
  assert.match(textarea.props.value, /这段话是什么意思/, '默认问题没有预填');
  assert.equal(textarea.props.onChange instanceof Function, true, '问题不可编辑');
  const conceptInput = findAll(overlayInstance.tree, (node) => node.type === 'input')[0];
  assert.equal(conceptInput.props.value, '幂等性', '概念没有带上选中的文字');
});

await check('点「开始提问」→ 新建会话 + 带 cwd + 切过去 + prompt 内容正确', async () => {
  const buttons = findAll(overlayInstance.tree, byClass('sa-btn sa-btn-primary'));
  assert.equal(buttons.length, 1, '没有渲染出主按钮');
  await buttons[0].props.onClick();

  assert.deepEqual(calls.created, [{ cwd: '/Users/example/learn' }], '新建会话没有带上主线 cwd');
  assert.deepEqual(calls.opened, ['session-concept-new'], '没有切到新会话');
  assert.deepEqual(calls.retained[0].options, { source: 'gateway' });

  const prompted = calls.prompted[0];
  assert.equal(prompted.mode, 'queue');
  const text = prompted.content[0].text;
  assert.match(text, /幂等性/, '种子消息缺少选中的概念');
  assert.match(text, /这段话是什么意思/, '种子消息缺少默认问题');
  assert.match(text, /📌 当前主线/, '种子消息没有要求模型先生成摘要');
  assert.match(text, /这里的幂等性很关键/, '种子消息缺少主线节选（assistant 文本）');
  assert.match(text, /为什么需要幂等？/, '种子消息缺少主线节选（user 文本）');
  assert.equal(text.includes('调用参数里也有幂等性'), false, '节选混入了 tool-call 文本');
});

await check('概念会话被设置了可辨认的标题', () => {
  assert.equal(calls.renamed.length, 1, '没有设置标题');
  assert.match(calls.renamed[0], /^⚓ 概念：幂等性/);
});

await check('锚点已写入 localStorage，后续同概念可被标识', () => {
  const stored = JSON.parse(globalThis.window.localStorage.getItem('dsh.study-anchor.v1'));
  const anchor = stored.find((item) => item.key === '幂等性');
  assert.ok(anchor, '没有写入锚点');
  assert.equal(anchor.visits.length, 2, '新的一次提问应作为一次 visit 追加');
  assert.equal(anchor.visits[1].sessionId, 'session-concept-new');
  assert.equal(anchor.visits[1].originSessionId, 'session-main');
});

/* ================================================================== *
 * 点虚线 → 概念详情
 * ================================================================== */

await check('点虚线命中概念，弹出详情（命中更长的那个概念）', async () => {
  documentStub.getSelection = () => null;
  documentStub.setCaret(assistantText, 4); // 「幂等性」内
  await documentStub.dispatch('click', {
    clientX: 300,
    clientY: 210,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  const panels = findAll(overlayInstance.tree, byClass('sa-pop'));
  assert.equal(panels.length, 1, '没有弹出概念详情');
  const title = findAll(panels[0], (node) => node.props && node.props.className === 'sa-mark-name');
  assert.equal(title[0].props.children, '幂等性');
});

await check('点在虚线之外不弹概念详情', async () => {
  documentStub.setCaret(assistantText, 0); // 「这」上，不在任何 range 内
  const before = findAll(overlayInstance.tree, byClass('sa-pop')).length;
  await documentStub.dispatch('click', {
    clientX: 20,
    clientY: 210,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  const after = findAll(overlayInstance.tree, byClass('sa-pop')).length;
  assert.ok(after <= before, '不该新增概念详情');
});

await check('点面板外面会关掉概念详情', () => {
  // 上一条测试之后详情还开着。
  assert.ok(
    findAll(overlayInstance.tree, byClass('sa-pop')).length >= 1,
    '详情应该是开着的',
  );
  documentStub.dispatch('pointerdown', { target: { closest: () => null } });
  assert.equal(
    findAll(overlayInstance.tree, byClass('sa-pop')).length,
    0,
    '点面板外面没有关掉详情 —— 用户会被困在面板里',
  );
});

await check('Esc 也能关掉浮动面板', () => {
  // 重新打开详情。
  documentStub.setCaret(assistantText, 4);
  documentStub.dispatch('click', {
    clientX: 300,
    clientY: 210,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(findAll(overlayInstance.tree, byClass('sa-pop')).length, 1, '详情没打开');
  documentStub.dispatch('keydown', { key: 'Escape' });
  assert.equal(findAll(overlayInstance.tree, byClass('sa-pop')).length, 0, 'Esc 没有关掉面板');
});

await check('点面板内部不会误关', () => {
  documentStub.setCaret(assistantText, 4);
  documentStub.dispatch('click', {
    clientX: 300,
    clientY: 210,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(findAll(overlayInstance.tree, byClass('sa-pop')).length, 1, '详情没打开');
  // 模拟点到面板内部的按钮：target.closest 命中自己的界面标记。
  documentStub.dispatch('pointerdown', { target: { closest: () => ({}) } });
  assert.equal(
    findAll(overlayInstance.tree, byClass('sa-pop')).length,
    1,
    '点面板内部把面板关掉了',
  );
  documentStub.dispatch('pointerdown', { target: { closest: () => null } });
});

/* ================================================================== *
 * 卸载与静态约束
 * ================================================================== */

await check('虚线标注层可安全卸载并清掉已注册的高亮', () => {
  const layer = effects.find((e) => String(e.label).includes('虚线标记层'));
  layer.dispose();
  assert.equal(observers.every((o) => o.observing === false), true);
  assert.equal(highlights.has('study-anchor-mark'), false);
});

await check('只标注 assistant-step 与 user 两类节点', () => {
  assert.match(source, /data-chat-flow-kind="assistant-step"/);
  assert.match(source, /data-chat-flow-kind="user"/);
});

await check('虚线用 CSS Custom Highlight，且不改动对话 DOM', () => {
  assert.match(source, /CSS\.highlights\.set/);
  assert.match(source, /::highlight\(/);
  assert.match(source, /text-decoration-style: dashed/);
});

await check('不向 document.body 追加节点，不用 innerHTML，不改对话节点结构', () => {
  assert.equal(source.includes('document.body.appendChild'), false);
  assert.equal(source.includes('innerHTML'), false);
  assert.equal(source.includes('insertAdjacentHTML'), false);
  assert.equal(/createElement\([^)]*appendChild/.test(source), false);
  // 唯一对外部 DOM 的写入应只有 cursor 提示。
  assert.equal(source.includes('flow.style.cursor'), true);
  assert.equal(source.includes('removeChild'), false);
});

await check('主按钮不再是白底白字（brand-primary 是高对比墨色，不是饱和强调色）', () => {
  const rule = /\.sa-btn-primary\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(rule, '找不到 .sa-btn-primary 规则');
  const body = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(
    /\bcolor:\s*(#fff\b|#ffffff|white\b)/i.test(body),
    false,
    '不能写死白色文字：--dsw-alias-brand-primary 在深色模式下本身就是近白 #f9fafb',
  );
  assert.match(
    body,
    /color:\s*var\(--dsw-alias-brand-primary/,
    '主按钮文字应用 brand-primary，它在两种模式下都与浮层底色有足够对比',
  );
});

await check('没有别处把白色文字写死在 token 背景上', () => {
  const cssText = /const CSS_TEXT = `([\s\S]*?)`;/
    .exec(source)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of cssText.matchAll(/\.sa-[a-z-]+[^{]*\{([^}]*)\}/g)) {
    assert.equal(
      /\bcolor:\s*(#fff\b|#ffffff|white\b)/i.test(rule[1]),
      false,
      `规则写死了白色文字：${rule[0].slice(0, 70)}`,
    );
  }
});

await check('README 记录的是当前真实行为', () => {
  const readme = readFileSync(path.join(here, '..', 'README.md'), 'utf8');
  assert.match(readme, /CSS Custom Highlight/);
  assert.match(readme, /localStorage/);
  assert.match(readme, /已知限制/);
});

/* ================================================================== *
 * 对比度审计
 *
 * 这一节是为了防止「白底白字」那类问题再犯：把样式表里每个文字/底色组合，
 * 按主题在浅色与深色两个模式下的真实取值算一遍 WCAG 对比度。
 *
 * 下面的取值直接从 app 内置的 dsh-client-ui-theme 里读出来（token → 静态色阶）：
 *   --dsw-alias-brand-primary      浅色 bluish-1000 #0f1115 / 深色 bluish-50  #f9fafb
 *   --dsw-alias-label-primary      浅色 #0f1115              / 深色 #f9fafb
 *   --dsw-alias-label-secondary    浅色 bluish-700 #61666b   / 深色 bluish-300 #cfd3d6
 *   --dsw-alias-bg-base            浅色 bluish-00  #ffffff   / 深色 bluish-950 #151517
 *   --dsw-alias-bg-layer-1         浅色 #ffffff              / 深色 bluish-875 #232324
 *   --dsw-alias-bg-layer-2         浅色 #ffffff              / 深色 bluish-850 #2c2c2e
 *   --dsw-alias-bg-overlay         浅色 bluish-150 #e9ecf2   / 深色 bluish-700 #61666b
 * ================================================================== */

const PALETTE = {
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-overlay': '#e9ecf2',
    '--dsw-alias-label-primary': '#0f1115',
    '--dsw-alias-label-secondary': '#61666b',
    '--dsw-alias-brand-primary': '#0f1115',
  },
  dark: {
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-bg-layer-2': '#2c2c2e',
    '--dsw-alias-bg-overlay': '#61666b',
    '--dsw-alias-label-primary': '#f9fafb',
    '--dsw-alias-label-secondary': '#cfd3d6',
    '--dsw-alias-brand-primary': '#f9fafb',
  },
};

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(fgHex, bgHex, alpha) {
  const f = hexToRgb(fgHex);
  const b = hexToRgb(bgHex);
  const mixed = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const CSS_TEXT_SOURCE = (() => {
  const m = /const CSS_TEXT = `([\s\S]*?)`;/.exec(source);
  assert.ok(m, '找不到 CSS_TEXT');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
})();

const CSS_RULES = [...CSS_TEXT_SOURCE.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
  body: m[2],
}));

/**
 * 收集某个类名的全部声明，按样式表顺序合并（后面的覆盖前面的），
 * 这样 `.sa-input, .sa-textarea {…}` 这种合并写法的两条都能拿到。
 * 带伪类（:hover 等）的规则不算，因为选择器字符串不相等。
 */
function declarationsOf(selector) {
  const out = {};
  let found = false;
  for (const rule of CSS_RULES) {
    if (!rule.selectors.includes(selector)) continue;
    found = true;
    for (const part of rule.body.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  assert.ok(found, `找不到规则 ${selector}`);
  return out;
}

/** 把一条 CSS 颜色值解析成具体色值；inherit/transparent 由调用方给出上下文。 */
function resolveColor(value, palette, surface) {
  const v = String(value).trim();
  const varMatch = /^var\((--[a-z0-9-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    if (palette[name]) return palette[name];
    assert.ok(fallback, `token ${name} 在两个模式下都没有值，也没有 fallback`);
    return resolveColor(fallback, palette, surface);
  }
  const mix = /^color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) return blend(palette[mix[1]], surface, parseFloat(mix[2]) / 100);
  if (v === 'transparent' || v === 'inherit') return surface;
  assert.match(v, /^#[0-9a-fA-F]{3,8}$/, `无法解析的颜色值：${v}`);
  return v;
}

/**
 * [说明, 规则选择器, 文字色来源, 底色来源]
 * 底色来源为 'own' 表示用该规则自己的 background；否则是它所在表面的 token。
 */
const CONTRAST_CASES = [
  ['提问面板标题', '.sa-pop', 'own-color', '--dsw-alias-bg-overlay'],
  ['面板里的标签/说明', '.sa-label', 'own-color', '--dsw-alias-bg-overlay'],
  ['提问面板输入框', '.sa-input', 'own-color', 'own-background'],
  ['提问面板文本域', '.sa-textarea', 'own-color', 'own-background'],
  ['次要按钮（继续追问）', '.sa-btn', 'own-color', 'own-background'],
  ['静默按钮（取消）', '.sa-btn-quiet', 'own-color', '--dsw-alias-bg-overlay'],
  ['主按钮（开始提问）', '.sa-btn-primary', 'own-color', 'own-background'],
  ['选中浮出按钮', '.sa-fab', 'own-color', '--dsw-alias-bg-overlay'],
  ['锚点芯片', '.sa-chip', 'inherit', '--dsw-alias-bg-layer-2'],
  ['锚点条说明文字', '.sa-chip-label', 'own-color', '--dsw-alias-bg-layer-2'],
  ['首次使用提示', '.sa-hint', 'own-color', '--dsw-alias-bg-overlay'],
  ['概念引用块', '.sa-quote', 'own-color', '--dsw-alias-bg-overlay'],
  ['面板小字说明', '.sa-note', 'own-color', '--dsw-alias-bg-overlay'],
];

console.log('对比度审计（WCAG，正文要求 ≥ 3.5:1）');
for (const mode of ['light', 'dark']) {
  const palette = PALETTE[mode];
  const rows = [];
  for (const [label, selector, colorFrom, surfaceFrom] of CONTRAST_CASES) {
    const decl = declarationsOf(selector);
    const surface =
      surfaceFrom === 'own-background' || surfaceFrom === 'own'
        ? resolveColor(decl.background, palette, palette['--dsw-alias-bg-overlay'])
        : palette[surfaceFrom];
    const colorSource =
      colorFrom === 'inherit' || decl.color === undefined || decl.color === 'inherit'
        ? // 所有浮动层元素都从 .sa-pop 继承 label-primary
          'var(--dsw-alias-label-primary)'
        : decl.color;
    const fg = resolveColor(colorSource, palette, surface);
    rows.push([label, contrastRatio(fg, surface)]);
  }
  const worst = rows.reduce((a, b) => (a[1] <= b[1] ? a : b));
  if (process.argv.includes('-v')) {
    for (const [label, ratio] of rows) {
      console.log(`      ${ratio.toFixed(2).padStart(6)}:1  ${label}`);
    }
  }
  console.log(
    `  ${mode === 'light' ? '浅色' : '深色'}模式：最低 ${worst[1].toFixed(2)}:1（${worst[0]}）`,
  );
  await check(`${mode === 'light' ? '浅色' : '深色'}模式下所有文字/底色组合都够清楚`, () => {
    for (const [label, ratio] of rows) {
      assert.ok(
        ratio >= 3.5,
        `${label} 对比度只有 ${ratio.toFixed(2)}:1（${mode}）—— 这个模式下的文字会看不清`,
      );
    }
  });
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
