/**
 * shared.js —— 纯函数工具层，被 background / content script / options 页共用。
 * 不依赖任何 chrome.* API，因此可同时用于 Service Worker（importScripts）、
 * 内容脚本（manifest 声明）与普通页面（<script src>）。
 */
const GH_ACCEL = (() => {
  'use strict';

  /** 兜底前缀：用户未配置任何前缀、且内置配置也缺失时使用，保证功能开箱可用。 */
  const FALLBACK_PREFIX = 'https://v4.gh-proxy.org/';

  /**
   * 内置加速前缀（首次安装 / 「恢复默认」时写入）。
   * 同一加速服务提供的不同 CDN 节点，可按本地网络状况在设置页测速挑选。
   */
  const BUILTIN_PREFIXES = [
    { label: 'Cloudflare v4', url: 'https://v4.gh-proxy.org/' },
    { label: 'Cloudflare v4/v6', url: 'https://v6.gh-proxy.org/' },
    { label: 'Fastly v4', url: 'https://cdn.gh-proxy.org/' },
    { label: 'AxisNow v4', url: 'https://axisnow.gh-proxy.org/' },
  ];

  /** 存储键名（chrome.storage.local 与 options 页 localStorage 保持一致）。 */
  const STORAGE_KEY = 'ghAccelPrefixes';

  /** GitHub520 加速 IP 列表的获取地址（会拼在当前默认前缀之后） */
  const HOSTS520_URL =
    'https://raw.githubusercontent.com/521xueweihan/GitHub520/refs/heads/main/hosts';

  /** 默认项在菜单中的标题前缀（其余项只显示备注名） */
  const MENU_DEFAULT_TITLE = '默认';

  /** 分隔线占位用的伪 id（保证与真实前缀 id 不冲突） */
  const SEPARATOR_KEY = '__separator__';

  const HOSTS = ['github.com', 'www.github.com', 'codeload.github.com', 'raw.githubusercontent.com'];

  /**
   * 归一化加速前缀，处理用户手输的脏数据：
   * - 首尾空白 / 全角空格
   - 缺少协议头
   - 结尾多余斜杠（统一收敛为恰好一个 "/"，保证与原始 URL 拼接不出现 "//"）
   */
  function normalizePrefix(raw) {
    if (typeof raw !== 'string') return '';
    let v = raw.replace(/[\s\u3000]+/g, '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    // 去掉结尾所有斜杠，再补一个标准斜杠
    v = v.replace(/\/+$/, '') + '/';
    return v;
  }

  /** 从前缀中提取展示用短名，如 https://v4.gh-proxy.org/ -> gh-proxy.org */
  function prefixLabel(prefix) {
    try {
      const u = new URL(normalizePrefix(prefix));
      return u.host;
    } catch (_) {
      return prefix;
    }
  }

  /** 是否为 GitHub 页面（用于限制右键菜单 / content script 生效范围） */
  function isGitHubPage(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'github.com' || host.endsWith('.github.com');
    } catch (_) {
      return false;
    }
  }

  /**
   * 判断是否为「GitHub 可加速的下载链接」：
   * 1. 源码压缩包  /{owner}/{repo}/archive/....zip|.tar.gz|.tgz
   * 2. Release 资产 /{owner}/{repo}/releases/download/{tag}/{asset}
   * 3. codeload 直链/{owner}/{repo}/zip|tar.gz/{ref}
   */
  function isGitHubDownloadLink(url) {
    if (typeof url !== 'string' || !url) return false;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (HOSTS.indexOf(host) === -1 && !host.endsWith('.github.com')) return false;

    const p = u.pathname;
    // /owner/repo/archive/refs/tags/v1.zip 或 /owner/repo/zipball/master
    if (/^\/[^/]+\/[^/]+\/(archive|zipball|tarball)\//i.test(p)) return true;
    // /owner/repo/releases/download/... 与 /releases/latest/download/...
    if (/^\/[^/]+\/[^/]+\/releases\/(latest\/)?download\//i.test(p)) return true;
    // codeload: /owner/repo/zip/ref、/owner/repo/legacy.zip/ref
    if (/^\/[^/]+\/[^/]+\/(legacy\.)?(zip|tar\.gz)\//i.test(p)) return true;
    return false;
  }

  /** 是否为应当被「加速下载」拦截的普通外链（用于 content script 标注） */
  function isAcceleratable(url) {
    return isGitHubDownloadLink(url);
  }

  /**
   * 拼接最终加速地址：前缀(末尾恰好一个 /) + 原始链接(去掉前导 /)。
   * 若原始链接本身已带该前缀则原样返回，避免二次套娃。
   */
  function buildAcceleratedUrl(prefix, targetUrl) {
    const base = normalizePrefix(prefix) || normalizePrefix(FALLBACK_PREFIX);
    const target = String(targetUrl || '').trim();
    if (!target) return '';
    if (target.startsWith(base)) return target;
    return base + target.replace(/^\/+/, '');
  }

  /**
   * 生成右键菜单条目规格。
   *
   * 目录结构：一级平铺，不使用子菜单 —— 默认前缀排在最上方，
   * 其余非默认前缀紧随其下，中间用一条分隔线隔开。
   * 这样右键一次即可看到全部可用前缀，无需再展开二级/三级目录。
   *
   * 返回 [{ id, prefixId, title, type }]，type 为 'normal' | 'separator'。
   */
  function buildMenuSpec(prefixes, idPrefix) {
    const list = (prefixes || []).filter((p) => p && p.url);
    if (!list.length) return [];

    const def = list.find((p) => p.isDefault) || list[0];
    const others = list.filter((p) => p.id !== def.id);
    // 默认项标注「默认（备注名）」，其余项只显示备注名，避免同一菜单内文案重复冗长
    const wrap = (p, isDefault) => ({
      id: idPrefix + p.id,
      prefixId: p.id,
      title: (isDefault ? MENU_DEFAULT_TITLE + '（' : '') + (p.label || prefixLabel(p.url)) + (isDefault ? '）' : ''),
      type: 'normal',
      isDefault,
    });

    const items = [wrap(def, true)];
    if (others.length) {
      items.push({ id: idPrefix + SEPARATOR_KEY, prefixId: '', title: '', type: 'separator' });
      others.forEach((p) => items.push(wrap(p, false)));
    }
    return items;
  }

  /**
   * 生成内置前缀列表（带稳定 id，便于「恢复默认」与识别）。
   * 第一项为默认项。
   */
  function builtinPrefixes() {
    return BUILTIN_PREFIXES.map((p, i) => ({
      id: 'builtin_' + i,
      url: normalizePrefix(p.url),
      label: p.label,
      isDefault: i === 0,
    }));
  }

  return {
    FALLBACK_PREFIX,
    BUILTIN_PREFIXES,
    STORAGE_KEY,
    HOSTS520_URL,
    MENU_DEFAULT_TITLE,
    SEPARATOR_KEY,
    normalizePrefix,
    prefixLabel,
    isGitHubPage,
    isGitHubDownloadLink,
    isAcceleratable,
    builtinPrefixes,
    buildAcceleratedUrl,
    buildMenuSpec,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GH_ACCEL;