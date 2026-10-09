/**
 * background.js (Service Worker)
 * 职责：
 *  1. 存储加速前缀列表（chrome.storage.local），首次安装写入默认值
 *  2. 依据前缀列表动态重建右键菜单：默认前缀 → 主菜单项；其余前缀 → 子菜单项
 *  3. 命中点击时生成加速地址并调用 chrome.downloads 触发下载（而非页面跳转）
 *  4. 接收 content script 发来的「用户点击页面内加速按钮」消息，走同一条下载通道
 */
importScripts('shared.js');

const MENU_ITEM_PREFIX = 'gh-accel-item:';
const MAX_PREFIX_COUNT = 20;

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

/** 读取全部前缀，返回 [{ id, label, url, isDefault }] */
async function readPrefixes() {
  const fallback = GH_ACCEL.builtinPrefixes();
  try {
    const bag = await chrome.storage.local.get(GH_ACCEL.STORAGE_KEY);
    const list = bag[GH_ACCEL.STORAGE_KEY];
    if (!Array.isArray(list) || list.length === 0) return fallback;
    return list
      .filter((it) => it && typeof it.url === 'string' && it.url.trim())
      .map((it) => ({
        id: String(it.id || Math.random().toString(36).slice(2)),
        label: String(it.label || GH_ACCEL.prefixLabel(it.url)),
        url: GH_ACCEL.normalizePrefix(it.url),
        isDefault: !!it.isDefault,
      }));
  } catch (e) {
    console.warn('[GH加速] 读取前缀失败，使用内置配置', e);
    return fallback;
  }
}

async function writePrefixes(list) {
  await chrome.storage.local.set({ [GH_ACCEL.STORAGE_KEY]: list.slice(0, MAX_PREFIX_COUNT) });
}

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 菜单重建任务队列。
 *
 * 为什么要串行：onInstalled 会写入 storage，这会触发 storage.onChanged，
 * 而 onChanged 与 onInstalled 自身都会调用 rebuildMenus()。两次调用若交错执行，
 * 会出现「A 已 removeAll 并 create，B 又removeAll 后用相同 id 再次 create」，
 * Chrome 直接报 Cannot create item with duplicate id。
 * 把重建串到同一条Promise 链上，任何时刻只会有一次重建在进行。
 */
let rebuildChain = Promise.resolve();

function queueRebuildMenus() {
  rebuildChain = rebuildChain
    .then(() => rebuildMenus())
    .catch((e) => console.warn('[GH加速] 重建右键菜单失败', e));
  return rebuildChain;
}

async function rebuildMenus() {
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  const prefixes = await readPrefixes();
  if (!prefixes.length) return;

  // 保证有且仅有一个默认项；没有则把第一项设为默认
  const defaults = prefixes.filter((p) => p.isDefault);
  if (defaults.length === 0) prefixes[0].isDefault = true;
  else if (defaults.length > 1) defaults.forEach((p, i) => (p.isDefault = i === 0));

  // 限制在 GitHub 页面，且只对「下载类链接」显示：linkPattern 过滤 zip/tar.gz/releases/download
  const linkPatterns = [
    '*://github.com/*/archive/*',
    '*://github.com/*/archive/*/*.zip',
    '*://github.com/*/archive/*/*.tar.gz',
    '*://github.com/*/releases/download/*',
    '*://github.com/*/releases/latest/download/*',
    '*://*.github.com/*/archive/*',
    '*://*.github.com/*/releases/download/*',
    '*://*.github.com/*/releases/latest/download/*',
    '*://codeload.github.com/*',
  ];

  // 一级平铺：默认在最上，其余紧随其后，中间以分隔线区分 —— 不再嵌套子菜单
  GH_ACCEL.buildMenuSpec(prefixes, MENU_ITEM_PREFIX).forEach((item) => {
    const option = {
      id: item.id,
      contexts: ['link'],
      targetUrlPatterns: linkPatterns,
    };
    if (item.type === 'separator') {
      chrome.contextMenus.create(Object.assign(option, { type: 'separator' }));
    } else {
      chrome.contextMenus.create(Object.assign(option, { title: item.title }));
    }
  });
}

/* ------------------------------------------------------------------ */
/* 下载触发                                                            */
/* ------------------------------------------------------------------ */

/**
 * 用指定（或默认）前缀加速下载。
 * 关键点：用 chrome.downloads.download 触发浏览器下载，避免 location 跳转把当前标签页带走。
 */
async function triggerDownload(originalUrl, prefixId) {
  // 非目标链接：不静默失败，明确告知用户
  if (!GH_ACCEL.isGitHubDownloadLink(originalUrl)) {
    console.info('[GH加速] 忽略非受支持的链接：', originalUrl);
    return false;
  }
  const prefixes = await readPrefixes();
  const target =
    prefixes.find((p) => p.id === prefixId) ||
    prefixes.find((p) => p.isDefault) ||
    prefixes[0];
  if (!target) return false;

  const url = GH_ACCEL.buildAcceleratedUrl(target.url, originalUrl);
  await chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' });
  return true;
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await readPrefixes();
  // 仅在从未配置过时写入默认项，避免覆盖用户设置
  const bag = await chrome.storage.local.get(GH_ACCEL.STORAGE_KEY);
  const isFirstRun = !Array.isArray(bag[GH_ACCEL.STORAGE_KEY]);
  if (isFirstRun) {
    await writePrefixes(existing);
    // 这次写入已触发 storage.onChanged 完成重建，无需再排一次队
    return;
  }
  // 升级场景：配置已存在，onChanged 不会触发，这里主动重建一次
  await queueRebuildMenus();
});

chrome.runtime.onStartup.addListener(() => queueRebuildMenus());

chrome.contextMenus.onClicked.addListener((info) => {
  if (!info.menuItemId || !String(info.menuItemId).startsWith(MENU_ITEM_PREFIX)) return;
  const prefixId = String(info.menuItemId).slice(MENU_ITEM_PREFIX.length);
  // 分隔线不可点击，理论上不会走到这里；兜底挡掉占位 id
  if (!prefixId || prefixId === GH_ACCEL.SEPARATOR_KEY) return;
  const linkUrl = info.linkUrl || info.srcUrl;
  if (linkUrl) triggerDownload(linkUrl, prefixId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && GH_ACCEL.STORAGE_KEY in changes) {
    queueRebuildMenus();
  }
});

// content script 请求加速：默认前缀 + 直接下载
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'GH_ACCEL_DOWNLOAD' && msg.url) {
    triggerDownload(msg.url, msg.prefixId).then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
  if (msg && msg.type === 'GH_ACCEL_GET_PREFIX') {
    readPrefixes().then((list) => {
      const def = list.find((p) => p.isDefault) || list[0];
      sendResponse({ ok: true, prefix: def ? def.url : GH_ACCEL.FALLBACK_PREFIX, count: list.length });
    });
    return true;
  }
  return false;
});

// 供 options 页的「测试」按钮复用同一套前缀解析与拼接逻辑
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'GH_ACCEL_PREVIEW' && msg.url) {
    const prefixes = readPrefixes().then((list) => {
      const def = list.find((p) => p.isDefault) || list[0];
      sendResponse({
        ok: !!def,
        prefix: def ? def.url : GH_ACCEL.FALLBACK_PREFIX,
        finalUrl: def ? GH_ACCEL.buildAcceleratedUrl(def.url, msg.url) : '',
        supported: GH_ACCEL.isGitHubDownloadLink(msg.url),
      });
    });
    prefixes.catch(() => sendResponse({ ok: false }));
    return true; // 异步响应
  }
  return false;
});

// 点击工具栏图标打开设置页
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());