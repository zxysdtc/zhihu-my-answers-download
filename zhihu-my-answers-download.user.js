// ==UserScript==
// @name         知乎-用户回答增量下载
// @namespace    https://github.com/zxysdtc/zhihu-my-answers-download
// @version      3.1.0
// @description  下载任意知乎用户的回答为 Markdown：面板内输入/自动识别目标用户，弹出原生文件夹选择器选择保存目录，文件直接写入该目录；目录句柄持久化，下次打开自动恢复无需重选；增量更新（只下新增/改动），按用户分别记录。浏览器不支持时回退 GM_download。无外部依赖库。
// @author       you
// @match        *://www.zhihu.com/*
// @match        *://zhuanlan.zhihu.com/*
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log('%c[知乎回答下载] 脚本已加载 v3.1.0', 'color:#0066ff;font-weight:bold');

  // ===================== 可配置项 =====================
  const CONFIG = {
    fallbackSubDir: 'zhihu-answers', // 不支持文件夹选择器时，回退到“浏览器默认下载目录/该子目录”
    pageLimit: 20,                   // 每页拉取数量（知乎上限 20）
    pageDelayMs: 700,                // 翻页延迟（毫秒）
    writeDelayMs: 120,               // 文件之间的写入间隔（毫秒）
  };
  // ====================================================

  const STORE_KEY = 'zhihu_synced_map_v3';   // { [urlToken]: { [answerId]: updatedTime } }
  let running = false;
  let dirHandle = null;                       // File System Access 目录句柄（本会话）

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const supportFS = typeof window.showDirectoryPicker === 'function';

  // ---------- IndexedDB：持久化目录句柄（FileSystemHandle 可被结构化克隆存储） ----------
  const IDB_NAME = 'zhihu_dl_db';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'dir';
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(handle) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (e) { console.warn('[知乎回答下载] 保存目录句柄失败', e); }
  }
  async function idbGet() {
    try {
      const db = await idbOpen();
      const h = await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(IDB_KEY);
        r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      });
      db.close();
      return h;
    } catch (_) { return null; }
  }
  async function idbClear() {
    try {
      const db = await idbOpen();
      await new Promise((res) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_KEY); tx.oncomplete = res;
      });
      db.close();
    } catch (_) {}
  }

  // 查询/请求目录的读写权限。query=true 时只查询不弹窗
  async function ensurePermission(handle, query) {
    if (!handle || !handle.queryPermission) return true;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (query) return false; // 仅查询，不弹授权
    return (await handle.requestPermission(opts)) === 'granted';
  }

  function getStore() { try { return GM_getValue(STORE_KEY, {}) || {}; } catch (_) { return {}; } }
  function setStore(o) { try { GM_setValue(STORE_KEY, o); } catch (_) {} }
  function getUserStore(token) { const s = getStore(); return s[token] || {}; }
  function setUserStore(token, map) { const s = getStore(); s[token] = map; setStore(s); }

  function sanitize(name) {
    return (name || 'untitled')
      .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  function fmtDate(ms) {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function notify(title, text) {
    try { GM_notification({ title: `知乎回答下载 · ${title}`, text, timeout: 4000 }); } catch (_) {}
  }

  // 从当前页面 URL 识别正在浏览的用户 url_token（/people/xxx 或 /org/xxx）
  function detectTokenFromUrl() {
    const m = location.pathname.match(/\/(people|org)\/([^/]+)/);
    return m ? decodeURIComponent(m[2]) : '';
  }

  // ---------- 内置 HTML -> Markdown（无外部依赖） ----------
  function htmlToMarkdown(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString('<div id="__root">' + html + '</div>', 'text/html');
    const root = doc.getElementById('__root');
    const imgSrc = (el) => el.getAttribute('data-original') || el.getAttribute('data-actualsrc') || el.getAttribute('src') || '';

    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue.replace(/​/g, '');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const inner = () => Array.from(node.childNodes).map(walk).join('');
      switch (tag) {
        case 'br': return '\n';
        case 'hr': return '\n\n---\n\n';
        case 'p': return '\n\n' + inner() + '\n\n';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          return '\n\n' + '#'.repeat(+tag[1]) + ' ' + inner().trim() + '\n\n';
        case 'strong': case 'b': { const t = inner(); return t.trim() ? '**' + t + '**' : t; }
        case 'em': case 'i': { const t = inner(); return t.trim() ? '*' + t + '*' : t; }
        case 'del': case 's': return '~~' + inner() + '~~';
        case 'a': { const href = node.getAttribute('href') || ''; const t = inner().trim() || href; return href ? `[${t}](${href})` : t; }
        case 'img': { const s = imgSrc(node); return s ? `\n\n![](${s})\n\n` : ''; }
        case 'figure': {
          const img = node.querySelector('img'); const cap = node.querySelector('figcaption');
          if (img) { const s = imgSrc(img); if (s) return `\n\n![${cap ? sanitize(cap.textContent) : ''}](${s})\n\n`; }
          return '';
        }
        case 'figcaption': return '';
        case 'ul': case 'ol': {
          const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li');
          const ordered = tag === 'ol';
          return '\n\n' + items.map((li, i) => (ordered ? `${i + 1}. ` : '- ') + walk(li).trim().replace(/\n/g, '\n  ')).join('\n') + '\n\n';
        }
        case 'li': return inner();
        case 'blockquote': return '\n\n' + inner().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        case 'code': { if (node.closest('pre')) return inner(); return '`' + node.textContent + '`'; }
        case 'pre': {
          const code = node.querySelector('code');
          const lang = (node.getAttribute('lang') || (code && code.getAttribute('class') || '')).replace(/language-/, '').trim();
          return '\n\n```' + (lang || '') + '\n' + (code ? code.textContent : node.textContent) + '\n```\n\n';
        }
        default: return inner();
      }
    }
    return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ---------- 知乎 API ----------
  async function fetchUser(token) {
    const inc = 'name,url_token,answer_count';
    const r = await fetch(`https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}?include=${inc}`,
      { credentials: 'include', headers: { 'x-requested-with': 'fetch' } });
    if (!r.ok) throw new Error(`获取用户失败（HTTP ${r.status}），请确认 url_token 正确`);
    const u = await r.json();
    if (!u || !u.url_token) throw new Error('未找到该用户，请检查 url_token');
    return u;
  }
  async function fetchMe() {
    const r = await fetch('https://www.zhihu.com/api/v4/me?include=name,url_token',
      { credentials: 'include', headers: { 'x-requested-with': 'fetch' } });
    if (!r.ok) throw new Error('未登录或获取当前账号失败');
    return await r.json();
  }
  async function fetchAllAnswers(token, onProgress) {
    const inc = 'data[*].content,voteup_count,created_time,updated_time,question,comment_count';
    let offset = 0; const all = [];
    while (true) {
      const url = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}/answers` +
        `?include=${encodeURIComponent(inc)}&offset=${offset}&limit=${CONFIG.pageLimit}&order_by=created`;
      const r = await fetch(url, { credentials: 'include', headers: { 'x-requested-with': 'fetch' } });
      if (!r.ok) throw new Error(`拉取回答失败（HTTP ${r.status}）`);
      const json = await r.json();
      const list = json.data || [];
      all.push(...list);
      onProgress && onProgress(all.length, json.paging?.totals ?? null);
      if (!list.length || json.paging?.is_end) break;
      offset += list.length;
      await sleep(CONFIG.pageDelayMs);
    }
    return all;
  }

  function answerToMarkdown(a) {
    const title = a.question?.title ?? '未知问题';
    const created = a.created_time ? fmtDate(a.created_time * 1000) : '';
    const updated = a.updated_time ? fmtDate(a.updated_time * 1000) : created;
    const link = `https://www.zhihu.com/question/${a.question?.id}/answer/${a.id}`;
    return `# ${title}\n\n> 发布：${created}　更新：${updated}　赞同：${a.voteup_count ?? 0}　评论：${a.comment_count ?? 0}\n> 原文：${link}\n\n---\n\n` + htmlToMarkdown(a.content || '');
  }

  // ---------- 写文件：优先 FS Access，回退 GM_download ----------
  async function writeFile(filename, text) {
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return true;
    }
    return new Promise((resolve) => {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      GM_download({
        url, name: `${CONFIG.fallbackSubDir}/${filename}`, saveAs: false,
        onload: () => { URL.revokeObjectURL(url); resolve(true); },
        onerror: () => {
          try { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); } catch (_) {}
          setTimeout(() => URL.revokeObjectURL(url), 1000); resolve(true);
        },
      });
    });
  }

  // ---------- 选择文件夹（并持久化） ----------
  async function chooseDir() {
    if (!supportFS) { notify('不支持', '当前浏览器不支持文件夹选择器，将使用浏览器默认下载目录'); return; }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await idbSet(dirHandle);                 // 持久化，下次自动恢复
      setDirLabel(dirHandle.name);
    } catch (e) {
      if (e && e.name !== 'AbortError') notify('选择目录失败', e.message || String(e));
    }
  }

  // 点「恢复目录」：对已存句柄请求一次写权限（需用户手势）
  async function reauthDir() {
    if (!dirHandle) return;
    const ok = await ensurePermission(dirHandle, false);
    setDirLabel(dirHandle.name, ok);
  }

  // ---------- 主流程：增量同步指定用户 ----------
  async function sync() {
    if (running) return;
    running = true;
    const statusEl = document.getElementById('zmad-status');
    const set = (t) => { if (statusEl) statusEl.textContent = t; };
    try {
      let token = (document.getElementById('zmad-token')?.value || '').trim();
      // 允许直接粘贴主页链接
      const linkMatch = token.match(/zhihu\.com\/(?:people|org)\/([^/?#]+)/);
      if (linkMatch) token = decodeURIComponent(linkMatch[1]);
      if (!token) { set('请先填写目标用户 url_token'); running = false; return; }

      if (supportFS && !dirHandle) { set('请先点「选择文件夹」'); running = false; return; }
      // 已恢复的句柄可能权限被降级，写入前确保拿到写权限（需用户手势——本次点击即是）
      if (dirHandle && !(await ensurePermission(dirHandle, false))) {
        set('目录写入权限被拒绝，请重新点「选择文件夹」'); running = false; return;
      }

      set('获取用户信息…');
      const user = await fetchUser(token);

      set('检查回答 0…');
      const answers = await fetchAllAnswers(user.url_token, (g, t) => set(`检查回答 ${g}${t ? '/' + t : ''}…`));

      const map = getUserStore(user.url_token);
      const changed = answers.filter((a) => String(map[a.id]) !== String(a.updated_time || a.created_time || 0));

      if (!changed.length) { set(`✓ 已是最新（共 ${answers.length} 条）`); running = false; return; }

      for (let i = 0; i < changed.length; i++) {
        const a = changed[i];
        set(`写入 ${i + 1}/${changed.length}…`);
        const fname = `${sanitize(user.name)}_${sanitize(a.question?.title)}_${a.id}.md`;
        await writeFile(fname, answerToMarkdown(a));
        map[a.id] = String(a.updated_time || a.created_time || 0);
        setUserStore(user.url_token, map);
        await sleep(CONFIG.writeDelayMs);
      }
      set(`✓ 完成，新增/更新 ${changed.length} 条`);
      notify('完成', `${user.name}：新增/更新 ${changed.length} 条`);
    } catch (e) {
      console.error('[知乎回答下载]', e);
      set('✗ ' + (e.message || String(e)));
      notify('出错', e.message || String(e));
    } finally {
      running = false;
    }
  }

  // ---------- 面板 UI ----------
  function setDirLabel(name, granted) {
    const el = document.getElementById('zmad-dir');
    const reauth = document.getElementById('zmad-reauth');
    if (el) {
      if (name) el.textContent = `📁 ${name}` + (granted === false ? '（需恢复授权）' : '');
      else el.textContent = supportFS ? '未选择目录' : '默认下载目录/' + CONFIG.fallbackSubDir;
    }
    // 已恢复了目录但权限未授予时，显示「恢复目录」按钮
    if (reauth) reauth.style.display = (name && granted === false) ? 'block' : 'none';
  }
  function mountPanel() {
    if (document.getElementById('zmad-panel')) return;
    const box = document.createElement('div');
    box.id = 'zmad-panel';
    Object.assign(box.style, {
      position: 'fixed', right: '20px', bottom: '90px', zIndex: 99999, width: '260px',
      background: '#fff', border: '1px solid #e5e5e5', borderRadius: '10px', padding: '12px',
      boxShadow: '0 4px 16px rgba(0,0,0,.15)', fontSize: '13px', color: '#222',
      fontFamily: 'system-ui, sans-serif',
    });
    box.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">知乎回答下载</div>' +
      '<input id="zmad-token" placeholder="用户 url_token 或主页链接" ' +
      'style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"/>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      '<button id="zmad-pick" style="flex:1;padding:6px;border:1px solid #0066ff;background:#fff;color:#0066ff;border-radius:6px;cursor:pointer">选择文件夹</button>' +
      '<button id="zmad-go" style="flex:1;padding:6px;border:none;background:#0066ff;color:#fff;border-radius:6px;cursor:pointer">下载</button>' +
      '</div>' +
      '<div id="zmad-dir" style="color:#888;margin-bottom:4px;word-break:break-all"></div>' +
      '<button id="zmad-reauth" style="display:none;width:100%;padding:6px;margin-bottom:6px;border:1px solid #ff9800;background:#fff;color:#ff9800;border-radius:6px;cursor:pointer">恢复上次目录授权</button>' +
      '<div id="zmad-status" style="color:#555;min-height:16px"></div>';
    (document.body || document.documentElement).appendChild(box);

    document.getElementById('zmad-pick').onclick = chooseDir;
    document.getElementById('zmad-go').onclick = sync;
    document.getElementById('zmad-reauth').onclick = reauthDir;
    setDirLabel('');

    // 恢复上次持久化的目录句柄
    if (supportFS) {
      idbGet().then(async (h) => {
        if (!h) return;
        dirHandle = h;
        const granted = await ensurePermission(h, true); // 仅查询，不弹窗
        setDirLabel(h.name, granted);
      }).catch(() => {});
    }

    // 自动识别当前主页用户；否则尝试填入当前登录账号
    const urlToken = detectTokenFromUrl();
    const input = document.getElementById('zmad-token');
    if (urlToken) {
      input.value = urlToken;
    } else {
      fetchMe().then(me => { if (me?.url_token && !input.value) input.value = me.url_token; }).catch(() => {});
    }
  }

  // 路由变化时刷新自动识别的 token
  let lastPath = location.pathname;
  function watchRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const t = detectTokenFromUrl();
    const input = document.getElementById('zmad-token');
    if (t && input && !running) input.value = t;
  }

  try {
    GM_registerMenuCommand('清空全部增量记录（重新下载）', () => {
      setStore({}); notify('已重置', '增量记录已清空，下次同步会重新下载');
    });
    GM_registerMenuCommand('忘记已保存的下载目录', async () => {
      await idbClear(); dirHandle = null; setDirLabel('');
      notify('已清除', '下次需重新选择文件夹');
    });
  } catch (_) {}

  function init() {
    mountPanel();
    setInterval(mountPanel, 3000); // SPA 切换后补挂
    setInterval(watchRoute, 1000);
  }
  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
