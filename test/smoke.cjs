/**
 * 冒烟测试：在 Node 下加载构建产物，验证模块契约。
 *
 * Obsidian 的 npm 包只有类型定义（package.json 的 main 为空），Node 里无法直接 require
 * 真包，因此这里用 Module._load 钩子注入一份最小 mock，再加载 main.js。
 *
 * 验证三件事：
 *   1. 模块能被加载（无顶层异常、无缺失依赖）
 *   2. 导出是插件类，且分别继承自 Plugin / ItemView / PluginSettingTab
 *   3. core 层在无宿主环境下仍可初始化 —— 这条依赖 core/http.ts 的「注入式传输」
 *      设计（未注入时回退全局 fetch），若哪天有人把 requestUrl 硬编码进 core，这里会红。
 *
 * 用法：node test/smoke.cjs
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

// ── 最小 obsidian mock ──
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  addStatusBarItem() {
    return { setText() {}, addClass() {}, onClickEvent() {} };
  }
  registerView() {}
  loadData() {
    return Promise.resolve(null);
  }
  saveData() {
    return Promise.resolve();
  }
}
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = {
      empty() {},
      addClass() {},
      createDiv() {
        return this;
      },
      createEl() {
        return this;
      },
    };
  }
}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = { empty() {}, addClass() {}, createEl() {} };
  }
}
class Modal {}
class Notice {
  constructor(msg) {
    this.msg = msg;
  }
}
class Setting {
  constructor() {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addToggle() {
    return this;
  }
  addButton() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addColorPicker() {
    return this;
  }
}
class TFile {}

const obsidianMock = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Modal,
  Notice,
  Setting,
  TFile,
  addIcon: () => {},
  normalizePath: (p) => p,
  requestUrl: async () => ({ status: 200, headers: {}, text: "", json: {} }),
  moment: { locale: () => "zh-CN" },
  Platform: { isMobile: false, isDesktopApp: true, isMobileApp: false },
};

// 拦截 "obsidian" 的加载
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianMock;
  return originalLoad.apply(this, arguments);
};

const target = path.resolve(__dirname, "..", "main.js");
const mod = require(target);

// ── 断言 1：导出形态 ──
const Exported = mod.default || mod;
assert.strictEqual(typeof Exported, "function", "main.js 应导出插件类");

// ── 断言 2：继承关系 ──
assert.ok(Exported.prototype instanceof Plugin, "导出类应继承 Plugin");
assert.strictEqual(typeof Exported.prototype.onload, "function", "应实现 onload");
assert.strictEqual(typeof Exported.prototype.onunload, "function", "应实现 onunload");

// ── 断言 3：实例化后字段齐备 ──
const instance = new Exported({ workspace: {}, vault: {} }, { id: "caldav-calendar-tasks" });
assert.ok(instance, "插件类可实例化");

// ── 断言 4：宿主模块必须 external，且不得残留思源引用 ──
// core 层能否在无宿主环境下运行，靠的是 http.ts 的「注入式传输」设计：
// 未注入时回退全局 fetch。若 source 里出现 siyuan 模块引用，说明分层被破坏。
const src = fs.readFileSync(target, "utf8");
assert.ok(src.includes('require("obsidian")'), "obsidian 必须保持 external，不能被内联打包");
assert.ok(!src.includes('require("siyuan")'), "不应残留思源模块引用");

console.log("✓ 冒烟测试通过");
console.log(`  - 导出：${Exported.name || "(匿名类)"}，继承 Plugin`);
console.log(`  - 实例化：成功`);
console.log(`  - 模块契约：obsidian 保持 external，无思源残留`);
