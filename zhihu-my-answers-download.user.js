// ==UserScript==
// @name         知乎-我的回答批量下载
// @namespace    https://github.com/yourname/zhihu-my-answers
// @version      1.0.0
// @description  打开知乎自动获取当前登录账号的全部回答，转 Markdown 打包成单个 zip 下载到指定目录（配合浏览器默认下载目录指向坚果云同步盘即可同步上云）
// @author       you
// @match        *://www.zhihu.com/*
// @match        *://zhuanlan.zhihu.com/*
// @grant        GM_download
// @grant        GM_notification
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.3/dist/turndown.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===================== 可配置项 =====================
  const CONFIG = {
    // 下载子目录（相对“浏览器默认下载目录”）。把浏览器默认下载目录设为坚果云同步盘即可同步上云。
    subDir: 'zhihu-answers',
    // 是否“打开知乎就自动运行”。true=自动；false=只显示按钮手动点。
    autoRun: false,
    // 自动运行的最小间隔（小时），避免每次刷新都重下。
    autoRunIntervalHours: 12,
    // 每页拉取数量（知乎上限 20）
    pageLimit: 20,
    // 每次翻页之间的延迟（毫秒），礼貌一点、降低被限流概率
    pageDelayMs: 800,
  };
  // ====================================================

  const LS_KEY = 'zhihu_my_answers_last_run';

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // ---------- 获取当前登录账号 ----------
  async function fetchMe() {
    const r = await fetch(
      'https://www.zhihu.com/api/v4/me?include=name,url_token,answer_count',
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
      const r = await fetch(url, {
        credentials: 'include',
        headers: { 'x-requested-with': 'fetch' },
      });
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

  // ---------- 单条回答转 Markdown ----------
  function answerToMarkdown(a) {
    const title = a.question?.title ?? '未知问题';
    const created = a.created_time ? fmtDate(a.created_time * 1000) : '';
    const link = `https://www.zhihu.com/question/${a.question?.id}/answer/${a.id}`;
    let body = '';
    try {
      body = turndown.turndown(a.content || '');
    } catch (e) {
      body = (a.content || '').replace(/<[^>]+>/g, '');
    }
    return (
      `# ${title}\n\n` +
      `> 发布日期：${created}　赞同：${a.voteup_count ?? 0}　评论：${a.comment_count ?? 0}\n` +
      `> 原文链接：${link}\n\n` +
      `---\n\n` +
      `${body}\n`
    );
  }

  // ---------- 打包并下载 ----------
  async function buildAndDownload(me, answers) {
    const zip = new JSZip();
    const used = new Set();
    answers.forEach((a, idx) => {
      const dateStr = a.created_time ? fmtDate(a.created_time * 1000) : '0000-00-00';
      let base = `${dateStr}_${sanitize(a.question?.title)}`;
      let fname = `${base}.md`;
      let n = 1;
      while (used.has(fname)) fname = `${base}_${n++}.md`;
      used.add(fname);
      zip.file(fname, answerToMarkdown(a));
    });

    // 附一个索引
    const indexMd =
      `# ${me.name} 的知乎回答备份\n\n` +
      `导出时间：${fmtDate(Date.now())}　共 ${answers.length} 条\n\n` +
      answers
        .map(
          (a) =>
            `- [${sanitize(a.question?.title)}](https://www.zhihu.com/question/${a.question?.id}/answer/${a.id})`
        )
        .join('\n') +
      '\n';
    zip.file('_index.md', indexMd);

    const blob = await zip.generateAsync({ type: 'blob' });
    const objUrl = URL.createObjectURL(blob);
    const zipName =
      `${CONFIG.subDir}/${sanitize(me.name)}_知乎回答_${fmtDate(Date.now())}.zip`;

    GM_download({
      url: objUrl,
      name: zipName, // 含子目录，相对浏览器默认下载目录
      saveAs: false,
      onload: () => {
        URL.revokeObjectURL(objUrl);
        notify('完成', `已下载 ${answers.length} 条回答到 下载目录/${CONFIG.subDir}`);
      },
      onerror: (e) => {
        // 回退：普通 a 标签下载（落到默认下载目录根，不带子目录）
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = zipName.split('/').pop();
        a.click();
        notify('已下载（回退方式）', '子目录未生效，文件在下载目录根部');
      },
    });
  }

  function notify(title, text) {
    try {
      GM_notification({ title: `知乎回答下载 · ${title}`, text, timeout: 4000 });
    } catch (_) {}
  }

  // ---------- 主流程 ----------
  let running = false;
  async function run(manual) {
    if (running) return;
    running = true;
    const btn = document.getElementById('zmad-btn');
    try {
      setBtn('获取账号中…');
      const me = await fetchMe();
      setBtn('拉取回答 0…');
      const answers = await fetchAllAnswers(me.url_token, (got, total) => {
        setBtn(`拉取回答 ${got}${total ? '/' + total : ''}…`);
      });
      if (!answers.length) {
        notify('无内容', '当前账号没有回答');
        setBtn(defaultBtnText());
        return;
      }
      setBtn(`打包 ${answers.length} 条…`);
      await buildAndDownload(me, answers);
      localStorage.setItem(LS_KEY, String(Date.now()));
      setBtn(defaultBtnText());
    } catch (e) {
      console.error('[知乎回答下载]', e);
      notify('出错', e.message || String(e));
      setBtn(defaultBtnText());
    } finally {
      running = false;
    }
  }

  // ---------- 悬浮按钮 UI ----------
  function defaultBtnText() {
    return '⬇ 下载我的全部回答';
  }
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
      position: 'fixed',
      right: '20px',
      bottom: '90px',
      zIndex: 99999,
      padding: '10px 14px',
      background: '#0066ff',
      color: '#fff',
      border: 'none',
      borderRadius: '8px',
      cursor: 'pointer',
      fontSize: '13px',
      boxShadow: '0 2px 8px rgba(0,0,0,.2)',
    });
    btn.onclick = () => run(true);
    document.body.appendChild(btn);
  }

  // ---------- 自动运行判断 ----------
  function shouldAutoRun() {
    if (!CONFIG.autoRun) return false;
    const last = Number(localStorage.getItem(LS_KEY) || 0);
    const gap = CONFIG.autoRunIntervalHours * 3600 * 1000;
    return Date.now() - last > gap;
  }

  // ---------- 启动 ----------
  function init() {
    mountButton();
    if (shouldAutoRun()) {
      // 稍等页面稳定再跑
      setTimeout(() => run(false), 2500);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
