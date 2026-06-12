// ==UserScript==
// @name         知乎-我的回答增量下载
// @namespace    https://github.com/zxysdtc/zhihu-my-answers-download
// @version      2.0.0
// @description  打开知乎时自动增量下载当前登录账号的回答：每条回答单独存为 Markdown 文件到指定子目录，只下载新增/有改动的，已下过且未改的自动跳过。无需任何外部依赖库。
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

  console.log('%c[知乎回答下载] 脚本已加载 v2.0.0', 'color:#0066ff;font-weight:bold');

  // ===================== 可配置项 =====================
  const CONFIG = {
    subDir: 'zhihu-answers',        // 下载子目录（相对浏览器默认下载目录；把默认下载目录指向坚果云同步盘即可同步上云）
    autoRunOnOpen: true,            // 打开知乎时是否自动增量同步
    minAutoRunGapMinutes: 10,       // 自动同步的最小间隔（分钟），避免频繁刷新时重复打 API；手动按钮不受限制
    pageLimit: 20,                  // 每页拉取数量（知乎上限 20）
    pageDelayMs: 700,               // 翻页延迟（毫秒）
    downloadDelayMs: 400,           // 文件之间的下载间隔（毫秒）
  };
  // ====================================================

  const STORE_KEY = 'zhihu_synced_map';   // { [answerId]: updatedTime }
  const LASTRUN_KEY = 'zhihu_last_autorun';

  let didAutoRun = false;
  let running = false;

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getStore() {
    try { return GM_getValue(STORE_KEY, {}) || {}; } catch (_) { return {}; }
  }
  function setStore(obj) {
    try { GM_setValue(STORE_KEY, obj); } catch (_) {}
  }

  function sanitize(name) {
    return (name || 'untitled')
      .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function notify(title, text) {
    try { GM_notification({ title: `知乎回答下载 · ${title}`, text, timeout: 4000 }); } catch (_) {}
  }

  // ---------- 内置 HTML -> Markdown（无外部依赖） ----------
  function htmlToMarkdown(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString('<div id="__root">' + html + '</div>', 'text/html');
    const root = doc.getElementById('__root');

    function imgSrc(el) {
      return el.getAttribute('data-original') || el.getAttribute('data-actualsrc') || el.getAttribute('src') || '';
    }

    function walk(node) {
      // 文本节点
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
        case 'strong': case 'b': {
          const t = inner(); return t.trim() ? '**' + t + '**' : t;
        }
        case 'em': case 'i': {
          const t = inner(); return t.trim() ? '*' + t + '*' : t;
        }
        case 'del': case 's': return '~~' + inner() + '~~';
        case 'a': {
          const href = node.getAttribute('href') || '';
          const t = inner().trim() || href;
          return href ? `[${t}](${href})` : t;
        }
        case 'img': {
          const src = imgSrc(node);
          return src ? `\n\n![](${src})\n\n` : '';
        }
        case 'figure': {
          const img = node.querySelector('img');
          const cap = node.querySelector('figcaption');
          let out = '';
          if (img) { const s = imgSrc(img); if (s) out += `\n\n![${cap ? sanitize(cap.textContent) : ''}](${s})\n\n`; }
          return out;
        }
        case 'figcaption': return '';
        case 'ul': case 'ol': {
          const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li');
          const ordered = tag === 'ol';
          return '\n\n' + items.map((li, i) => {
            const prefix = ordered ? `${i + 1}. ` : '- ';
            return prefix + walk(li).trim().replace(/\n/g, '\n  ');
          }).join('\n') + '\n\n';
        }
        case 'li': return inner();
        case 'blockquote':
          return '\n\n' + inner().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        case 'code': {
          // 行内 code（pre 内的 code 由 pre 处理）
          if (node.closest('pre')) return inner();
          return '`' + node.textContent + '`';
        }
        case 'pre': {
          const code = node.querySelector('code');
          const lang = (node.getAttribute('lang') || (code && code.getAttribute('class') || '')).replace(/language-/, '').trim();
          return '\n\n```' + (lang || '') + '\n' + (code ? code.textContent : node.textContent) + '\n```\n\n';
        }
        default:
          return inner();
      }
    }

    return walk(root)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  }

  // ---------- 获取当前登录账号 ----------
  async function fetchMe() {
    const r = await fetch(
      'https://www.zhihu.com/api/v4/me?include=name,url_token',
      { credentials: 'include', headers: { 'x-requested-with': 'fetch' } }
    );
    if (!r.ok) throw new Error(`未能获取当前账号（HTTP ${r.status}），请确认已登录知乎`);
    const me = await r.json();
    if (!me || !me.url_token) throw new Error('未能识别当前登录账号，请先登录知乎');
    return me;
  }

  // ---------- 分页拉取全部回答 ----------
  async function fetchAllAnswers(urlToken, onProgress) {
    const include =
      'data[*].content,voteup_count,created_time,updated_time,question,comment_count';
    let offset = 0;
    const all = [];
    while (true) {
      const url =
        `https://www.zhihu.com/api/v4/members/${urlToken}/answers` +
        `?include=${encodeURIComponent(include)}` +
        `&offset=${offset}&limit=${CONFIG.pageLimit}&order_by=created`;
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

  // ---------- 单条回答 -> Markdown 文本 ----------
  function answerToMarkdown(a) {
    const title = a.question?.title ?? '未知问题';
    const created = a.created_time ? fmtDate(a.created_time * 1000) : '';
    const updated = a.updated_time ? fmtDate(a.updated_time * 1000) : created;
    const link = `https://www.zhihu.com/question/${a.question?.id}/answer/${a.id}`;
    const body = htmlToMarkdown(a.content || '');
    return (
      `# ${title}\n\n` +
      `> 发布：${created}　更新：${updated}　赞同：${a.voteup_count ?? 0}　评论：${a.comment_count ?? 0}\n` +
      `> 原文：${link}\n\n` +
      `---\n\n` +
      body
    );
  }

  // ---------- 下载一段文本为文件 ----------
  function downloadText(filename, text) {
    return new Promise((resolve) => {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      GM_download({
        url,
        name: `${CONFIG.subDir}/${filename}`,
        saveAs: false,
        onload: () => { URL.revokeObjectURL(url); resolve(true); },
        onerror: () => {
          // 回退：a 标签（落到下载目录根部，不带子目录）
          try {
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
          } catch (_) {}
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          resolve(false);
        },
      });
    });
  }

  // ---------- 主流程：增量同步 ----------
  async function sync(isAuto) {
    if (running) return;
    running = true;
    try {
      setBtn('获取账号…');
      const me = await fetchMe();

      setBtn('检查回答 0…');
      const answers = await fetchAllAnswers(me.url_token, (got, total) => {
        setBtn(`检查回答 ${got}${total ? '/' + total : ''}…`);
      });

      const store = getStore();
      const changed = answers.filter((a) => {
        const ut = a.updated_time || a.created_time || 0;
        return String(store[a.id]) !== String(ut);
      });

      if (!changed.length) {
        setBtn(defaultBtnText());
        if (!isAuto) notify('已是最新', `共 ${answers.length} 条回答，没有新增或改动`);
        else console.log('[知乎回答下载] 增量检查：无新增/改动');
        return;
      }

      let ok = 0;
      for (let i = 0; i < changed.length; i++) {
        const a = changed[i];
        setBtn(`下载 ${i + 1}/${changed.length}…`);
        const fname = `${sanitize(a.question?.title)}_${a.id}.md`;
        const success = await downloadText(fname, answerToMarkdown(a));
        if (success) ok++;
        // 记录已同步（无论 GM_download 还是回退，都视为已落盘）
        store[a.id] = String(a.updated_time || a.created_time || 0);
        setStore(store);
        await sleep(CONFIG.downloadDelayMs);
      }

      setBtn(defaultBtnText());
      notify('增量完成', `本次新增/更新 ${changed.length} 条，已存到 下载目录/${CONFIG.subDir}`);
    } catch (e) {
      console.error('[知乎回答下载]', e);
      setBtn(defaultBtnText());
      notify('出错', e.message || String(e));
    } finally {
      running = false;
    }
  }

  // ---------- 悬浮按钮 UI ----------
  function defaultBtnText() { return '⬇ 增量同步我的回答'; }
  function setBtn(text) {
    const btn = document.getElementById('zmad-btn');
    if (btn) btn.textContent = text;
  }
  function mountButton() {
    if (document.getElementById('zmad-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'zmad-btn';
    btn.textContent = defaultBtnText();
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', bottom: '90px', zIndex: 99999,
      padding: '10px 14px', background: '#0066ff', color: '#fff', border: 'none',
      borderRadius: '8px', cursor: 'pointer', fontSize: '13px', boxShadow: '0 2px 8px rgba(0,0,0,.2)',
    });
    btn.onclick = () => sync(false);
    (document.body || document.documentElement).appendChild(btn);
  }

  // ---------- 菜单：清空增量记录（重新下载全部） ----------
  try {
    GM_registerMenuCommand('清空增量记录（下次将重新下载全部）', () => {
      setStore({});
      notify('已重置', '增量记录已清空，下次同步会重新下载全部回答');
    });
  } catch (_) {}

  // ---------- 启动 ----------
  function maybeAutoRun() {
    if (!CONFIG.autoRunOnOpen || didAutoRun) return;
    didAutoRun = true;
    const last = Number(GM_getValue(LASTRUN_KEY, 0) || 0);
    const gap = CONFIG.minAutoRunGapMinutes * 60 * 1000;
    if (Date.now() - last < gap) {
      console.log('[知乎回答下载] 距上次自动同步过近，跳过（点按钮可手动同步）');
      return;
    }
    GM_setValue(LASTRUN_KEY, Date.now());
    setTimeout(() => sync(true), 2500);
  }

  function init() {
    mountButton();
    setInterval(mountButton, 3000); // SPA 路由切换后补挂按钮
    maybeAutoRun();
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
