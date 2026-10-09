/**
 * content.js
 * 职责：在 GitHub 页面为「源码压缩包 / Release 资产」链接追加一个轻量的加速按钮，
 *点击后通过消息交给 service worker 触发下载。
 * 仅做增强，不改动 GitHub 原有 DOM 行为；非目标链接一律不注入任何节点。
 */
(() => {
  'use strict';
  if (!window.GH_ACCEL) return;

  const MARK_ATTR = 'data-gh-accel-enhanced';
  let defaultPrefix = GH_ACCEL.FALLBACK_PREFIX;
  let known = false;

  /** 主动向 background 询问当前默认前缀 */
  function loadPrefix() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GH_ACCEL_GET_PREFIX' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            resolve(GH_ACCEL.FALLBACK_PREFIX);
            return;
          }
          resolve(res.prefix || GH_ACCEL.FALLBACK_PREFIX);
        });
      } catch (_) {
        resolve(GH_ACCEL.FALLBACK_PREFIX);
      }
    });
  }

  function sendDownload(url) {
    try {
      chrome.runtime.sendMessage({ type: 'GH_ACCEL_DOWNLOAD', url });
    } catch (_) {
      console.warn('[GH加速] 无法唤起下载，请检查扩展是否启用');
    }
  }

  /** 为单个 <a> 注入加速按钮（幂等） */
  function enhance(anchor) {
    if (!anchor || anchor.hasAttribute(MARK_ATTR)) return;
    const href = anchor.getAttribute('href') || '';
    if (!GH_ACCEL.isAcceleratable(anchor.href || href)) return;

    anchor.setAttribute(MARK_ATTR, '1');

    const btn = document.createElement('a');
    btn.className = 'gh-accel-btn';
    btn.href = '#';
    btn.textContent = '⇣';
    btn.title = `GitHub 加速下载（${defaultPrefix}）`;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'GitHub 加速下载');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendDownload(anchor.href);
    });

    // 样式全部内联，避免污染 GitHub 页面且不依赖外部 CSS 注入
    btn.style.cssText = [
      'display:inline-block',
      'margin-left:6px',
      'padding:0 6px',
      'font-size:12px',
      'line-height:16px',
      'text-decoration:none',
      'color:#0969da',
      'border:1px solid #d0d7de',
      'border-radius:6px',
      'background:#f6f8fa',
      'cursor:pointer',
      'vertical-align:middle',
      'user-select:none',
    ].join(';');

    anchor.parentNode && anchor.parentNode.insertBefore(btn, anchor.nextSibling);
  }

  function scan(root) {
    const scope = root || document;
    if (scope.nodeType !== 1 && scope.nodeType !== 9 && scope.nodeType !== 11) return;
    if (!GH_ACCEL.isGitHubPage(location.href)) return;

    if (scope.matches && scope.matches('a[href]')) enhance(scope);
    let anchors = [];
    try {
      anchors = scope.querySelectorAll('a[href]');
    } catch (_) {
      return;
    }
    for (const a of anchors) enhance(a);
  }

  async function init() {
    if (!GH_ACCEL.isGitHubPage(location.href)) return;
    defaultPrefix = await loadPrefix();
    known = true;
    scan(document);
    if (known) observe();
  }

  /** Release 页 / 折叠区为异步渲染，用 MutationObserver 兜住动态插入的链接 */
  let timer = null;
  function observe() {
    const mo = new MutationObserver((mutations) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const m of mutations) {
          for (const node of m.addedNodes) scan(node);
        }
      }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();