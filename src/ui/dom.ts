/**
 * HTML 字符串 → DOM 节点的转换工具。
 *
 * ## 为什么需要这个模块
 *
 * Obsidian 社区目录的审核明确点名 `innerHTML` / `outerHTML` / `insertAdjacentHTML`
 * 为代码质量问题：前两者会**连同子节点上已绑定的事件监听一起丢弃**，往里重新塞
 * HTML 时容易出现「监听莫名失效」的坑；而项目里这些HTML 片段大量是「先拼字符串、
 * 再整体插入、随后再绑事件」的写法，踩坑概率不低。
 *
 * 思源没有这套审查，所以移植过来的代码保留着 innerHTML 习惯。提交社区目录必须改。
 *
 * ## 为什么不是全部重写成 createEl
 *
 * 这里的模板动辄上百行（编辑器表单、分类管理列表），逐个改成 `createDiv` 链式调用
 * 会让「界面长什么样」与「DOM 怎么搭」两类信息混在一起，重构成本高且极易改坏布局。
 * 故保留 HTML 模板，只把**插入方式**换掉：用 `DOMParser` 在惰性文档中解析，
 * 再把节点搬进真实文档。
 *
 * 与 innerHTML 的实质差别：
 *  1. 解析发生在独立的惰性文档里，不触碰当前文档的既有结构；
 *  2. 节点是「搬进去」而不是「重新解析」，节点自身挂好的监听不会丢；
 *  3. 不执行脚本（`DOMParser` 不会跑`<script>`，innerHTML 同样不跑，但少一条路径）。
 *
 * ⚠️ **XSS 防护仍靠调用方的 `escape()`** —— 本模块不做转义，与 innerHTML 一样，
 * 插值必须先过 `escape()`（见 `view-common.ts`）。
 */

/** 把 HTML 字符串解析成惰性文档里的节点数组（已脱离源文档，可安全搬走） */
function parseNodes(html: string): Node[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return Array.from(doc.body.childNodes);
}

/** 把 HTML 字符串解析成 `DocumentFragment`，供 appendChild / replaceChildren 使用 */
export function fragFromHtml(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const n of parseNodes(html)) frag.appendChild(n);
  return frag;
}

/**
 * 用 HTML 字符串替换 `el` 的全部内容。
 *
 * 等价于 `el.innerHTML = html`，但走 DOMParser，且不会连带丢弃 `el` 自身的事件监听
 * —— 这点比 innerHTML 更安全，因为调用方常在替换后立刻重新查询子节点并绑定交互。
 */
export function setHtml(el: HTMLElement, html: string): void {
  el.replaceChildren(fragFromHtml(html));
}

/** 把 HTML 字符串**追加**到 `el` 末尾，替代 `insertAdjacentHTML("beforeend", …)` */
export function appendHtml(el: HTMLElement, html: string): void {
  el.appendChild(fragFromHtml(html));
}

/**
 * 按 `html` 重置 `el` 的内容，并返回其中的节点副本数组。
 *
 * 用途：「保存一份初始状态 → 之后反复恢复」。比innerHTML 常见写法
 * `const idle = el.innerHTML; … el.innerHTML = idle` 好在——恢复出来的是
 * 独立节点，不会与当前已挂载的节点共享引用。
 */
export function setHtmlSnapshot(el: HTMLElement, html: string): Node[] {
  setHtml(el, html);
  return snapshot(el);
}

/** 取当前内容的深拷贝，用于稍后恢复（见 `setHtmlSnapshot`） */
export function snapshot(el: HTMLElement): Node[] {
  return Array.from(el.childNodes).map((n) => n.cloneNode(true));
}

/** 用 `nodes` 的内容覆盖 `el`（内部按节点深拷贝，可反复复用同一份快照） */
export function restoreNodes(el: HTMLElement, nodes: Node[]): void {
  el.replaceChildren(...nodes.map((n) => n.cloneNode(true)));
}
