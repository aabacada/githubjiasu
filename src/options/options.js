/**
 * options.js —— 设置页逻辑
 * 数据流：UI 事件 → 归一化校验 → chrome.storage.local 持久化 → 重新渲染
 * background.js 监听 storage.onChanged 会自动重建右键菜单，无需额外通知。
 */
(() => {
  'use strict';

  const KEY = GH_ACCEL.STORAGE_KEY;
  const MAX_COUNT = 20;

  /* ---------------- 测速相关配置 ---------------- */
  const SPEED_KEY = 'ghAccelSpeedTarget';
  const DEFAULT_TARGET = 'https://github.com/qingjian-team/qingjian/archive/refs/tags/v0.1.4.zip';
  const MAX_BYTES = 4 * 1024 * 1024;  // 单次最多取 4MB，够测速又不至于久等
  const TIMEOUT_MS = 15000;            // 单个前缀超时时间
  const GAP_MS = 150;                  // 两次测试之间的间隔，避免连续请求被判为滥用

  const $ = (id) => document.getElementById(id);
  const urlInput = $('urlInput');
  const labelInput = $('labelInput');
  const defaultInput = $('defaultInput');
  const formError = $('formError');
  const formTitle = $('formTitle');
  const saveBtn = $('saveBtn');
  const cancelBtn = $('cancelBtn');
  const listEl = $('prefixList');
  const emptyTip = $('emptyTip');
  const resetBtn = $('resetBtn');
  const testInput = $('testInput');
  const testOutput = $('testOutput');
  const saveState = $('saveState');
  const speedTarget = $('speedTarget');
  const testAllBtn = $('testAllBtn');
  const sortBtn = $('sortBtn');

  let list = [];
  let editingId = null; // 非空表示处于编辑态
  let results = {};      // { prefixId: {speed, ttfb, bytes, ok, error} }
  let sortBySpeed = false;

  /* -------------------- 存储 -------------------- */

  async function load() {
    try {
      const bag = await chrome.storage.local.get(KEY);
      const raw = bag[KEY];
      list = Array.isArray(raw)
        ? raw.filter((i) => i && i.url).map(normalizeItem).filter(Boolean)
        : [];
    } catch (e) {
      console.warn('[设置] 读取失败', e);
      list = [];
    }
    render();
  }

  async function persist() {
    await chrome.storage.local.set({ [KEY]: list });
    render();
    refreshHostsPreview();
    toast('已保存');
  }

  /** 存储层数据的统一归一化，防止历史脏数据 */
  function normalizeItem(it) {
    const url = GH_ACCEL.normalizePrefix(it.url);
    if (!url) return null;
    return {
      id: it.id || 'p_' + Math.random().toString(36).slice(2, 9),
      url,
      label: (it.label || '').trim() || GH_ACCEL.prefixLabel(url),
      isDefault: !!it.isDefault,
    };
  }

  /* -------------------- 校验 -------------------- */

  function validate(rawUrl, ignoreId) {
    const value = (rawUrl || '').replace(/[\s\u3000]+/g, '');
    if (!value) return '请填写加速前缀';
    const url = GH_ACCEL.normalizePrefix(value);
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '前缀必须以 http:// 或 https:// 开头';
      if (!u.hostname) return '前缀缺少有效域名';
    } catch (_) {
      return '前缀格式不合法';
    }
    const dup = list.some((i) => i.url === url && i.id !== ignoreId);
    if (dup) return '该前缀已存在，请勿重复添加';
    return null;
  }

  /* -------------------- 渲染 -------------------- */

  function render() {
    listEl.innerHTML = '';
    emptyTip.hidden = list.length > 0;
    resetBtn.hidden = list.length === 0;
    testAllBtn.hidden = list.length === 0;
    // 有测速结果后才出现排序开关
    sortBtn.hidden = !Object.keys(results).length;
    sortBtn.textContent = sortBySpeed ? '恢复默认排序' : '按速度排序';

    // 默认项置顶，方便确认生效的是哪个
    // 排序：默认项置顶；开启「按速度排序」后按测速结果从快到慢
    const sorted = list.slice().sort((a, b) => {
      if (sortBySpeed) {
        const ra = results[a.id], rb = results[b.id];
        const sa = ra && ra.ok ? ra.speed : -1;
        const sb = rb && rb.ok ? rb.speed : -1;
        if (sa !== sb) return sb - sa;          // 测过的按速度降序
        if ((sa < 0) !== (sb < 0)) return sa < 0 ? 1 : -1; // 未测/失败的沉底
        if ((sa < 0) && (sb < 0)) return 0;
      }
      return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0);
    });

    // 找出本次测速最快的项，额外标一个绿色徽标
    const bestId = (() => {
      let best = null;
      sorted.forEach((i) => {
        const r = results[i.id];
        if (r && r.ok && (!best || r.speed > best.speed)) best = r;
      });
      if (!best) return null;
      for (const k in results) if (results[k] === best) return k;
      return null;
    })();

    sorted.forEach((item) => {
      const result = results[item.id];
      const li = document.createElement('li');
      li.className = 'item' + (item.isDefault ? ' default' : '');

      const main = document.createElement('div');
      main.className = 'item-main';

      const url = document.createElement('div');
      url.className = 'item-url';
      url.textContent = item.url;

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const name = document.createElement('span');
      name.textContent = item.label;
      meta.appendChild(name);
      if (item.isDefault) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '默认';
        meta.appendChild(badge);
      }
      if (sortBySpeed && item.id === bestId) {
        const badge = document.createElement('span');
        badge.className = 'badge fast';
        badge.textContent = '最快';
        meta.appendChild(badge);
      }

      main.appendChild(url);
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const defBtn = document.createElement('button');
      defBtn.type = 'button';
      defBtn.className = 'btn small' + (item.isDefault ? '' : ' ghost');
      defBtn.textContent = item.isDefault ? '当前默认' : '设为默认';
      defBtn.disabled = item.isDefault;
      defBtn.addEventListener('click', () => setDefault(item.id));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn small ghost';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => startEdit(item));

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn small ghost';
      testBtn.textContent = result && result.running ? '测速中…' : '测速';
      testBtn.disabled = !!(result && result.running);
      testBtn.addEventListener('click', () => onTestOne(item));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn small ghost danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => remove(item.id));

      actions.appendChild(defBtn);
      actions.appendChild(editBtn);
      actions.appendChild(testBtn);
      actions.appendChild(delBtn);

      // 测速结果行
      if (result) {
        const sp = document.createElement('div');
        sp.className = 'speed' + (result.running ? ' running' : result.ok ? '' : ' failed');
        if (result.running) {
          sp.textContent = '测速中…';
        } else if (result.ok) {
          const s1 = document.createElement('span');
          s1.innerHTML = '速度 <span class="num">' + fmtSpeed(result.speed) + '</span>';
          const s2 = document.createElement('span');
          s2.innerHTML = '首包 <span class="num">' + fmtMs(result.ttfb) + '</span>';
          const s3 = document.createElement('span');
          s3.textContent = '已取 ' + fmtBytes(result.bytes) + (result.partial ? '（超时前）' : '');
          sp.appendChild(s1);
          sp.appendChild(s2);
          sp.appendChild(s3);
        } else {
          sp.textContent = '测速失败：' + (result.error || '未知错误');
        }
        main.appendChild(sp);
      }

      li.appendChild(main);
      li.appendChild(actions);
      listEl.appendChild(li);
    });
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }
  function clearError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    saveState.textContent = msg;
    saveState.className = 'state show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      saveState.className = 'state';
    }, 1800);
  }

  /* -------------------- 操作 -------------------- */

  async function setDefault(id) {
    list = list.map((i) => ({ ...i, isDefault: i.id === id }));
    await persist();
  }

  function remove(id) {
    const target = list.find((i) => i.id === id);
    if (!target) return;
    if (!confirm(`确定删除前缀「${target.label}」？`)) return;
    list = list.filter((i) => i.id !== id);
    delete results[id]; // 清掉该前缀的历史测速数据，避免影响排序与「最快」标记
    // 删除默认项后，把第一项顶上，避免出现「无默认」的中间态
    if (list.length && !list.some((i) => i.isDefault)) list[0].isDefault = true;
    persist();
  }

  function startEdit(item) {
    editingId = item.id;
    formTitle.textContent = '编辑前缀';
    saveBtn.textContent = '更新';
    cancelBtn.hidden = false;
    urlInput.value = item.url;
    labelInput.value = item.label === GH_ACCEL.prefixLabel(item.url) ? '' : item.label;
    defaultInput.checked = item.isDefault;
    urlInput.focus();
    clearError();
  }

  function resetForm() {
    editingId = null;
    formTitle.textContent = '新增前缀';
    saveBtn.textContent = '保存';
    cancelBtn.hidden = true;
    urlInput.value = '';
    labelInput.value = '';
    defaultInput.checked = false;
    clearError();
  }

  async function onSave() {
    clearError();
    const raw = urlInput.value;
    const err = validate(raw, editingId);
    if (err) {
      showError(err);
      return;
    }
    if (!editingId && list.length >= MAX_COUNT) {
      showError(`最多可配置 ${MAX_COUNT} 个前缀`);
      return;
    }
    const url = GH_ACCEL.normalizePrefix(raw);
    const label = (labelInput.value || '').trim() || GH_ACCEL.prefixLabel(url);

    if (editingId) {
      list = list.map((i) => (i.id === editingId ? { ...i, url, label } : i));
    } else {
      const existedDefault = list.some((i) => i.isDefault);
      list.push({
        id: 'p_' + Math.random().toString(36).slice(2, 9),
        url,
        label,
        isDefault: defaultInput.checked || !existedDefault,
      });
    }

    if (defaultInput.checked) {
      const id = editingId || list[list.length - 1].id;
      list = list.map((i) => ({ ...i, isDefault: i.id === id }));
    }

    resetForm();
    await persist();
  }

  async function onReset() {
    if (!confirm('恢复为内置前缀列表（会清空当前列表，确定继续？）')) return;
    list = GH_ACCEL.builtinPrefixes();
    resetForm();
    await persist();
  }

  /* -------------------- 转换测试 -------------------- */

  function onTest() {
    const target = testInput.value.trim();
    if (!target) {
      testOutput.textContent = '—';
      return;
    }
    const supported = GH_ACCEL.isGitHubDownloadLink(target);
    const def = list.find((i) => i.isDefault) || list[0];
    const prefix = def ? def.url : GH_ACCEL.normalizePrefix(GH_ACCEL.FALLBACK_PREFIX);
    const finalUrl = GH_ACCEL.buildAcceleratedUrl(prefix, target);

    const lines = [
      `支持类型：${supported ? '✓ 命中加速规则' : '✗ 非受支持的链接（菜单不会注入）'}`,
      `使用前缀：${prefix}`,
      '',
      '原始链接：',
      target,
      '',
      '加速后：',
      finalUrl,
    ];
    testOutput.textContent = lines.join('\n');
  }

  /* -------------------- 测速 -------------------- */

  function fmtSpeed(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(2) + ' MB/s';
    return Math.round(bytesPerSec / 1024) + ' KB/s';
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function fmtMs(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms';
  }

  /**
   * 为一批前缀域名申请主机权限。
   * 扩展页面要 fetch 外部域名必须有主机权限；这里用 optional_host_permissions
   * 按需申请，避免安装时就弹出「读取所有网站数据」的警告。
   * 注意：chrome.permissions.request 必须在用户手势中调用，所以要由点击事件直接触发。
   */
  async function requestOrigins(items) {
    if (!chrome.permissions || !chrome.permissions.request) return true;
    const origins = [];
    items.forEach((it) => {
      try {
        const o = new URL(GH_ACCEL.normalizePrefix(it.url)).origin + '/*';
        if (origins.indexOf(o) === -1) origins.push(o);
      } catch (_) { /* 前缀非法，跳过 */ }
    });
    if (!origins.length) return false;
    // 注意：permissions.contains 返回的是 { origins: [...] } 对象，不是数组
    const res = await chrome.permissions.contains({ origins });
    const granted = (res && res.origins) || [];
    const missing = origins.filter((o) => granted.indexOf(o) === -1);
    if (!missing.length) return true;
    try {
      return await chrome.permissions.request({ origins: missing });
    } catch (e) {
      return false;
    }
  }

  /**
   * 实际下载一小段数据来测速：记录首包延迟与平均速度。
   * 用 AbortController + 流式读取，拿到 ~4MB 或超时即止，不会把整个包下完。
   */
  async function measureOne(item, targetUrl) {
    const url = GH_ACCEL.buildAcceleratedUrl(item.url, targetUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    let bytes = 0;
    let ttfb = null;
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      ttfb = performance.now() - t0;

      const reader = resp.body && resp.body.getReader();
      if (!reader) {
        // 无流式支持（个别服务会这样）时退化为一次性读取
        const buf = await resp.arrayBuffer();
        bytes = buf.byteLength;
      } else {
        while (bytes < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
        try { reader.cancel(); } catch (_) { /* 已结束 */ }
      }

      const elapsed = (performance.now() - t0) / 1000;
      if (bytes < 1024) throw new Error('响应过小，可能是代理返回了错误页');
      // 扣掉首包等待，测的是稳态带宽
      const netSeconds = Math.max(elapsed - (ttfb ? (performance.now() - ttfb) / 1000 : 0), 0.001);
      const speed = bytes / Math.max(elapsed - (ttfb || 0) / 1000, 0.001);
      return { ok: true, speed, ttfb, bytes, seconds: netSeconds };
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      if (aborted && bytes >= 1024) {
        const elapsed = (performance.now() - t0) / 1000;
        return { ok: true, speed: bytes / Math.max(elapsed - (ttfb || 0) / 1000, 0.001), ttfb, bytes, seconds: elapsed, partial: true };
      }
      return { ok: false, error: aborted ? '超时（' + TIMEOUT_MS / 1000 + 's）' : (e && e.message) || '请求失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runSpeedTest(item, targetUrl) {
    results[item.id] = { running: true };
    render();
    const r = await measureOne(item, targetUrl);
    results[item.id] = r;
    render();
  }

  async function onTestOne(item) {
    const target = (speedTarget.value || '').trim();
    if (!target) { toast('请先填写测速目标链接', true); speedTarget.focus(); return; }
    if (!GH_ACCEL.isGitHubDownloadLink(target)) {
      toast('测速目标必须是 GitHub 下载链接（压缩包或 Release 资产）', true);
      return;
    }
    const granted = await requestOrigins([item]);
    if (!granted) { toast('未获得访问权限，无法测速', true); return; }
    await runSpeedTest(item, target);
    const r = results[item.id];
    toast(r && r.ok ? item.label + '：' + fmtSpeed(r.speed) : (r && r.error) || '测速失败', !(r && r.ok));
  }

  async function onTestAll() {
    const target = (speedTarget.value || '').trim();
    if (!target) { toast('请先填写测速目标链接', true); return; }
    if (!GH_ACCEL.isGitHubDownloadLink(target)) {
      toast('测速目标必须是 GitHub 下载链接（压缩包或 Release 资产）', true);
      return;
    }
    if (!list.length) return;

    // 必须先拿到权限再开始，否则所有请求都会被 CORS 拦掉
    const granted = await requestOrigins(list);
    if (!granted) {
      toast('未获得访问权限，无法测速', true);
      return;
    }

    testAllBtn.disabled = true;
    testAllBtn.textContent = '测速中…';
    // 逐个串行测，避免并发互相抢带宽导致结果失真
    for (const item of list) {
      await runSpeedTest(item, target);
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    testAllBtn.disabled = false;
    testAllBtn.textContent = '全部测速';

    // 测速目标持久化，下次打开无需重填
    try { await chrome.storage.local.set({ [SPEED_KEY]: target }); } catch (_) { /* 忽略 */ }

    const ok = Object.values(results).filter((r) => r && r.ok).length;
    toast(
      ok
        ? '测速完成：' + ok + '/' + list.length + ' 个前缀可用'
        : '全部前缀测速失败，原因见各行提示',
      !ok
    );
  }

  function onSortBySpeed() {
    sortBySpeed = !sortBySpeed;
    render();
  }

  /* -------------------- GitHub520 Host -------------------- */

  const hostsOpenBtn = $('hostsOpenBtn');
  const hostsUrlPreview = $('hostsUrlPreview');

  /** 用当前默认前缀拼出 GitHub520 的 hosts 地址 */
  function currentHostsUrl() {
    const def = list.find((i) => i.isDefault) || list[0];
    const prefix = def ? def.url : GH_ACCEL.normalizePrefix(GH_ACCEL.FALLBACK_PREFIX);
    return GH_ACCEL.buildAcceleratedUrl(prefix, GH_ACCEL.HOSTS520_URL);
  }

  function refreshHostsPreview() {
    if (hostsUrlPreview) hostsUrlPreview.textContent = currentHostsUrl();
  }

  function openHostsPage() {
    chrome.tabs.create({ url: currentHostsUrl(), active: true });
  }

  /* -------------------- 绑定 -------------------- */

  saveBtn.addEventListener('click', onSave);
  cancelBtn.addEventListener('click', resetForm);
  resetBtn.addEventListener('click', onReset);
  testAllBtn.addEventListener('click', onTestAll);
  sortBtn.addEventListener('click', onSortBySpeed);
  hostsOpenBtn.addEventListener('click', openHostsPage);
  testInput.addEventListener('input', onTest);
  testInput.addEventListener('blur', onTest);
  speedTarget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onTestAll();
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSave();
  });
  testInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onTest();
  });

  // 测速目标：优先用上次保存的，否则用默认值
  (async function initSpeedTarget() {
    try {
      const bag = await chrome.storage.local.get(SPEED_KEY);
      speedTarget.value = bag[SPEED_KEY] || DEFAULT_TARGET;
    } catch (_) {
      speedTarget.value = DEFAULT_TARGET;
    }
    if (!speedTarget.value) speedTarget.value = DEFAULT_TARGET;
  })();

  // GitHub520 Host：预览当前默认前缀拼出的地址
  refreshHostsPreview();

  // 版本徽标：直接读 manifest，保证与实际发布版本一致，不会出现两处版本号不同步
  (function renderVersion() {
    const el = $('versionBadge');
    if (!el) return;
    let v = '';
    try {
      v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    } catch (_) {
      v = '';
    }
    el.textContent = v ? 'v' + v : '';
    el.hidden = !v;
  })();

  load();
})();