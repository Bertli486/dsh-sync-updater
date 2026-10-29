/**
 * dsh-sync-updater 的浏览器半侧：侧栏「同步」面板。
 *
 * 两个页签：
 *   已安装 —— 技能/插件清单、检查更新、单行更新、自动更新开关
 *   发现   —— 搜 skills.sh、看 installs 与安全审计、一键安装
 *
 * 形态与官方客户端插件一致：window.__ModuleLoader__.load({ id, factory })，
 * factory 拿到的同步 require 提供 react 与 DSH 模块；不能自带 React。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync-updater',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const react = require('react');
    const { useCallback, useEffect, useRef, useState } = react;
    const createElement = react.createElement;

    const PANEL_ID = 'sync-updater';
    const API = '/sync-updater/api';

    /* ------------------------------- 样式 ------------------------------- */

    const CSS = `
.dsu-root { display:flex; flex-direction:column; gap:14px; padding:20px 24px 32px; height:100%; overflow:auto; font-size:13px; color:inherit; }
.dsu-head { display:flex; align-items:baseline; gap:10px; }
.dsu-title { font-size:16px; font-weight:600; }
.dsu-sub { opacity:.6; font-size:12px; }
.dsu-tabs { display:flex; gap:4px; border-bottom:1px solid rgba(128,128,128,.25); }
.dsu-tab { border:0; background:transparent; color:inherit; opacity:.6; font-size:13px; padding:7px 12px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
.dsu-tab-active { opacity:1; border-bottom-color:currentColor; }
.dsu-card { border:1px solid rgba(128,128,128,.25); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
.dsu-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dsu-row-title { font-weight:600; }
.dsu-grow { flex:1 1 auto; min-width:0; }
.dsu-btn { border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
.dsu-btn:hover:not(:disabled) { background:rgba(128,128,128,.14); }
.dsu-btn:disabled { opacity:.45; cursor:default; }
.dsu-btn-primary { border-color:rgba(64,128,255,.55); background:rgba(64,128,255,.12); }
.dsu-btn-danger { border-color:rgba(220,80,60,.6); color:#c0392b; }
.dsu-select { background:transparent; color:inherit; border:1px solid rgba(128,128,128,.35); border-radius:8px; padding:4px 8px; font-size:12px; }
.dsu-input { flex:1 1 auto; min-width:160px; background:transparent; color:inherit; border:1px solid rgba(128,128,128,.35); border-radius:8px; padding:6px 10px; font-size:13px; }
.dsu-list { display:flex; flex-direction:column; gap:2px; }
.dsu-item { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:8px; }
.dsu-item:hover { background:rgba(128,128,128,.1); }
.dsu-name { font-weight:500; min-width:130px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsu-meta { opacity:.6; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; min-width:60px; }
.dsu-badge { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid rgba(128,128,128,.35); white-space:nowrap; }
.dsu-badge-update { border-color:rgba(240,160,40,.7); color:#c07800; background:rgba(240,160,40,.12); }
.dsu-badge-ok { border-color:rgba(60,170,90,.55); color:#2f8a4f; background:rgba(60,170,90,.1); }
.dsu-badge-warn { border-color:rgba(240,160,40,.7); color:#b06a00; background:rgba(240,160,40,.14); }
.dsu-badge-fail { border-color:rgba(220,80,60,.7); color:#b03a2e; background:rgba(220,80,60,.14); }
.dsu-badge-muted { opacity:.65; }
.dsu-empty { opacity:.55; padding:6px 8px; font-size:12px; }
.dsu-log { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; white-space:pre-wrap; max-height:180px; overflow:auto; opacity:.85; }
.dsu-err { color:#c0392b; font-size:12px; }
.dsu-installs { opacity:.55; font-size:11.5px; min-width:52px; text-align:right; }
`;

    function useStyles() {
      useEffect(() => {
        const id = 'dsh-sync-updater-style';
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    /* ------------------------------- 工具 ------------------------------- */

    async function api(path, body) {
      const options = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) };
      const response = await fetch(`${API}${path}`, options);
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error((data && (data.error || data.detail)) || `HTTP ${response.status}`);
      return data;
    }

    function formatInstalls(value) {
      const count = Number(value) || 0;
      if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
      if (count >= 1e3) return `${Math.round(count / 1e3)}k`;
      return String(count);
    }

    const BADGES = {
      'update-available': ['有更新', 'dsu-badge-update'],
      current: ['最新', 'dsu-badge-ok'],
      baseline: ['已记录基线', 'dsu-badge-muted'],
      managed: ['skillshare 托管', 'dsu-badge-muted'],
      'no-source': ['无上游', 'dsu-badge-muted'],
      unknown: ['未知', 'dsu-badge-muted'],
      unchecked: ['未检查', 'dsu-badge-muted'],
      shipped: ['随 App', 'dsu-badge-muted'],
      local: ['本地来源', 'dsu-badge-muted'],
      'range-blocked': ['超出范围', 'dsu-badge-muted'],
    };

    function badge(status, label, tone) {
      const mapped = BADGES[status];
      const text = label ?? mapped?.[0] ?? status;
      const className = tone ?? mapped?.[1] ?? 'dsu-badge-muted';
      return createElement('span', { className: `dsu-badge ${className}` }, text);
    }

    function auditBadge(audit) {
      if (!audit) return null;
      if (audit.error === 'no-audit') return badge(null, '无审计', 'dsu-badge-muted');
      if (audit.error) return badge(null, '审计查询失败', 'dsu-badge-muted');
      const tone = audit.verdict === 'fail' ? 'dsu-badge-fail' : audit.verdict === 'warn' ? 'dsu-badge-warn' : 'dsu-badge-ok';
      const text = `审计 ${audit.verdict}${audit.riskLevel && audit.riskLevel !== 'NONE' ? ` · ${audit.riskLevel}` : ''}`;
      return createElement('span', {
        className: `dsu-badge ${tone}`,
        title: (audit.audits ?? []).map((item) => `${item.provider}: ${item.status}${item.riskLevel ? ` (${item.riskLevel})` : ''} — ${item.summary}`).join('\n'),
      }, text);
    }

    function describeCheck(lastCheck) {
      if (!lastCheck) return '还没检查过';
      const time = new Date(lastCheck.at).toLocaleString();
      const pluginUpdates = lastCheck.plugins?.updates ?? 0;
      const skillUpdates = lastCheck.skills?.updates ?? 0;
      return `${time} · 插件 ${pluginUpdates} 个 / 技能 ${skillUpdates} 个可更新`;
    }

    /* ------------------------------- 面板 ------------------------------- */

    function SyncPanel() {
      useStyles();
      const [tab, setTab] = useState('installed');
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [log, setLog] = useState([]);
      const mounted = useRef(true);

      // 发现页
      const [query, setQuery] = useState('');
      const [searching, setSearching] = useState(false);
      const [results, setResults] = useState(null);
      const [searchError, setSearchError] = useState(null);
      const [installedNames, setInstalledNames] = useState([]);
      const [audits, setAudits] = useState({});
      const [confirming, setConfirming] = useState(null);
      const [installing, setInstalling] = useState(null);

      useEffect(() => () => { mounted.current = false; }, []);

      const push = useCallback((line) => {
        setLog((current) => [...current.slice(-40), line]);
      }, []);

      const load = useCallback(async () => {
        try {
          const next = await api('/state');
          if (mounted.current) setState(next);
        } catch (loadError) {
          if (mounted.current) setError(String(loadError.message ?? loadError));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const runCheck = useCallback(async () => {
        setBusy('check');
        setError(null);
        push('开始检查更新…');
        try {
          const next = await api('/check', {});
          if (!mounted.current) return;
          setState(next);
          const p = next.check?.plugins?.updates ?? 0;
          const s = next.check?.skills?.updates ?? 0;
          push(`检查完成：插件 ${p} 个、技能 ${s} 个可更新`);
        } catch (checkError) {
          setError(String(checkError.message ?? checkError));
          push(`检查失败：${checkError.message ?? checkError}`);
        } finally {
          setBusy(null);
        }
      }, [push]);

      const runApply = useCallback(async (targets, names) => {
        setBusy('apply');
        setError(null);
        push(`开始更新 ${targets.join(' + ')}${names ? `：${names.join(', ')}` : ''}…`);
        try {
          const next = await api('/apply', { targets, names });
          if (!mounted.current) return;
          setState(next);
          const outcome = next.outcome;
          for (const item of outcome?.results?.skills ?? []) {
            push(`技能 ${item.name}：${item.applied ? '已更新' : '跳过'} · ${item.detail ?? ''}`);
          }
          for (const item of outcome?.results?.plugins ?? []) {
            push(`插件 ${item.name}：${item.applied ? '已更新' : '未变化'} · ${item.detail ?? ''}`);
          }
          if (outcome?.applied === 0) push('没有实际变化');
          else if (outcome?.restartRequired) push('插件已升级，重启 DSH 后生效');
        } catch (applyError) {
          setError(String(applyError.message ?? applyError));
          push(`更新失败：${applyError.message ?? applyError}`);
        } finally {
          setBusy(null);
        }
      }, [push]);

      const saveSettings = useCallback(async (patch) => {
        try {
          const next = await api('/settings', patch);
          if (mounted.current) setState(next);
          push(`设置已保存：${JSON.stringify(patch)}`);
        } catch (settingsError) {
          setError(String(settingsError.message ?? settingsError));
        }
      }, [push]);

      const runSearch = useCallback(async (text) => {
        const q = String(text ?? '').trim();
        if (q.length < 2) {
          setSearchError('至少输入 2 个字符');
          return;
        }
        setSearching(true);
        setSearchError(null);
        setResults(null);
        try {
          const data = await api(`/discover?q=${encodeURIComponent(q)}`);
          if (!mounted.current) return;
          setResults(data.skills ?? []);
          setInstalledNames(data.installed ?? []);
          setAudits({});
          setConfirming(null);
          push(`发现：搜索「${q}」得到 ${(data.skills ?? []).length} 条`);
        } catch (discoverError) {
          setSearchError(String(discoverError.message ?? discoverError));
        } finally {
          setSearching(false);
        }
      }, [push]);

      const installRow = useCallback(async (row) => {
        const key = row.id;
        if (!audits[key]) {
          try {
            const audit = await api(`/audit?source=${encodeURIComponent(row.source)}&slug=${encodeURIComponent(row.skillId)}`);
            if (mounted.current) setAudits((current) => ({ ...current, [key]: audit }));
            const risky = audit.verdict === 'fail' || ['HIGH', 'CRITICAL'].includes(audit.riskLevel);
            if (risky) {
              setConfirming(key);
              push(`⚠️ ${row.name} 审计结论 ${audit.verdict}/${audit.riskLevel}，再点一次确认安装`);
              return;
            }
          } catch {
            /* 审计不可用就照常安装 */
          }
        }
        setInstalling(key);
        setError(null);
        push(`安装 ${row.name}（${row.source}）…`);
        try {
          const data = await api('/install', { source: row.source, skillId: row.skillId });
          if (!mounted.current) return;
          setState((current) => (current ? { ...current, skills: data.skills, plugins: data.plugins } : current));
          setConfirming(null);
          push(`安装${data.install?.applied ? '成功' : '未完成'}：${data.install?.detail ?? ''}`);
          if (data.install?.applied) {
            setInstalledNames((current) => [...new Set([...current, row.skillId])]);
          }
        } catch (installError) {
          setError(String(installError.message ?? installError));
          push(`安装失败：${installError.message ?? installError}`);
        } finally {
          setInstalling(null);
        }
      }, [audits, push]);

      if (!state) {
        return createElement('div', { className: 'dsu-root' },
          createElement('div', { className: 'dsu-head' }, createElement('div', { className: 'dsu-title' }, '同步更新')),
          error
            ? createElement('div', { className: 'dsu-card' },
              createElement('div', { className: 'dsu-err' }, `读不到宿主数据：${error}`),
              createElement('div', { className: 'dsu-sub' }, '插件可能刚被加载或宿主正在重组，点下面重试；若一直失败，多半是宿主半侧没挂上路由。'),
              createElement('button', {
                type: 'button',
                className: 'dsu-btn dsu-btn-primary',
                onClick: () => { setError(null); void load(); },
              }, '重试'))
            : createElement('div', { className: 'dsu-empty' }, '加载中…'));
      }

      const settings = state.settings ?? {};
      const pluginRows = state.plugins ?? [];
      const skillRows = state.skills ?? [];
      const pendingSkills = skillRows.filter((item) => item.status === 'update-available');
      const pendingPlugins = pluginRows.filter((item) => item.status === 'update-available');

      const tabs = createElement('div', { className: 'dsu-tabs' },
        ...['installed', 'discover'].map((key) =>
          createElement('button', {
            key,
            type: 'button',
            className: `dsu-tab${tab === key ? ' dsu-tab-active' : ''}`,
            onClick: () => setTab(key),
          }, key === 'installed' ? '已安装' : '发现')));

      const header = createElement('div', { className: 'dsu-head' },
        createElement('div', { className: 'dsu-title' }, '同步更新'),
        createElement('div', { className: 'dsu-sub dsu-grow' }, state.cwd ?? ''),
        createElement('button', { type: 'button', className: 'dsu-btn', disabled: busy !== null, onClick: () => void load() }, '刷新'));

      if (tab === 'discover') {
        const rows = (results ?? []).map((row) => {
          const installed = installedNames.includes(row.skillId);
          const audit = audits[row.id];
          const isConfirm = confirming === row.id;
          return createElement('div', { className: 'dsu-item', key: row.id },
            createElement('span', { className: 'dsu-name', title: row.id }, row.name),
            badge(row.status, installed ? '已安装' : null, installed ? 'dsu-badge-ok' : 'dsu-badge-muted'),
            auditBadge(audit),
            createElement('span', { className: 'dsu-meta', title: `${row.source} · ${row.url}` }, row.source),
            createElement('span', { className: 'dsu-installs' }, formatInstalls(row.installs)),
            createElement('button', {
              type: 'button',
              className: `dsu-btn${isConfirm ? ' dsu-btn-danger' : ''}`,
              disabled: installing !== null || installed,
              onClick: () => void installRow(row),
            }, installed ? '已装' : installing === row.id ? '安装中…' : isConfirm ? '仍要安装' : '安装'));
        });

        return createElement('div', { className: 'dsu-root' },
          header,
          tabs,
          createElement('div', { className: 'dsu-card' },
            createElement('div', { className: 'dsu-row' },
              createElement('input', {
                className: 'dsu-input',
                placeholder: '搜索 skills.sh，比如 pdf / code review / dsh',
                value: query,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void runSearch(query); },
              }),
              createElement('button', {
                type: 'button',
                className: 'dsu-btn dsu-btn-primary',
                disabled: searching,
                onClick: () => void runSearch(query),
              }, searching ? '搜索中…' : '搜索')),
            searchError ? createElement('div', { className: 'dsu-err' }, searchError) : null,
            createElement('div', { className: 'dsu-sub' }, '数据来自 skills.sh 的公开搜索与审计接口；安装走 skillshare（没有就用 git 拉进 ~/.agents/skills）')),
          results === null
            ? null
            : createElement('div', { className: 'dsu-card' },
              createElement('div', { className: 'dsu-row' },
                createElement('span', { className: 'dsu-row-title' }, `结果 (${results.length})`),
                createElement('span', { className: 'dsu-sub' }, '装之前会先查一次安全审计；有风险的技能需要再点一次确认')),
              results.length === 0
                ? createElement('div', { className: 'dsu-empty' }, '没有匹配的技能')
                : createElement('div', { className: 'dsu-list' }, ...rows)),
          log.length === 0 ? null : createElement('div', { className: 'dsu-card' },
            createElement('div', { className: 'dsu-row' }, createElement('span', { className: 'dsu-row-title' }, '最近操作')),
            createElement('div', { className: 'dsu-log' }, log.join('\n'))));
      }

      const intervalOptions = [
        [0, '关闭'],
        [30, '每 30 分钟'],
        [60, '每 1 小时'],
        [360, '每 6 小时'],
        [1440, '每 24 小时'],
      ];

      const settingsCard = createElement('div', { className: 'dsu-card' },
        createElement('div', { className: 'dsu-row' },
          createElement('span', { className: 'dsu-row-title' }, '自动更新'),
          createElement('span', { className: 'dsu-sub' }, '只自动处理技能；插件始终手动')),
        createElement('div', { className: 'dsu-row' },
          createElement('span', null, '检查频率'),
          createElement('select', {
            className: 'dsu-select',
            value: String(settings.autoCheckIntervalMinutes ?? 0),
            disabled: busy !== null,
            onChange: (event) => {
              const minutes = Number(event.target.value);
              setState((current) => ({ ...current, settings: { ...current.settings, autoCheckIntervalMinutes: minutes } }));
              void saveSettings({ autoCheckIntervalMinutes: minutes });
            },
          }, ...intervalOptions.map(([value, label]) =>
            createElement('option', { key: value, value: String(value) }, label)))),
        createElement('label', { className: 'dsu-row', style: { cursor: 'pointer' } },
          createElement('input', {
            type: 'checkbox',
            checked: Boolean(settings.autoApplySkills),
            disabled: busy !== null,
            onChange: (event) => {
              const enabled = event.target.checked;
              setState((current) => ({ ...current, settings: { ...current.settings, autoApplySkills: enabled } }));
              void saveSettings({ autoApplySkills: enabled });
            },
          }),
          createElement('span', null, '检查到技能更新时自动应用'),
          createElement('span', { className: 'dsu-sub' }, '（失败不会动原文件，替换前有备份）')));

      const actionCard = createElement('div', { className: 'dsu-card' },
        createElement('div', { className: 'dsu-row' },
          createElement('button', {
            type: 'button',
            className: 'dsu-btn dsu-btn-primary',
            disabled: busy !== null,
            onClick: () => void runCheck(),
          }, busy === 'check' ? '检查中…' : '检查更新'),
          createElement('button', {
            type: 'button',
            className: 'dsu-btn',
            disabled: busy !== null || pendingSkills.length === 0,
            onClick: () => void runApply(['skills'], pendingSkills.map((item) => item.name)),
          }, `更新技能${pendingSkills.length ? ` (${pendingSkills.length})` : ''}`),
          createElement('button', {
            type: 'button',
            className: 'dsu-btn',
            disabled: busy !== null || pendingPlugins.length === 0,
            onClick: () => void runApply(['plugins'], pendingPlugins.map((item) => item.name)),
          }, `更新插件${pendingPlugins.length ? ` (${pendingPlugins.length})` : ''}`),
          createElement('span', { className: 'dsu-sub dsu-grow' }, describeCheck(state.lastCheck))),
        error ? createElement('div', { className: 'dsu-err' }, error) : null);

      const skillSection = createElement('div', { className: 'dsu-card' },
        createElement('div', { className: 'dsu-row' },
          createElement('span', { className: 'dsu-row-title' }, `技能 (${skillRows.length})`),
          createElement('span', { className: 'dsu-sub' }, '来自 ~/.agents/skills、项目目录与 skillshare 源')),
        skillRows.length === 0
          ? createElement('div', { className: 'dsu-empty' }, '没有发现技能')
          : createElement('div', { className: 'dsu-list' }, ...skillRows.map((item) =>
            createElement('div', { className: 'dsu-item', key: item.name },
              createElement('span', { className: 'dsu-name' }, item.name),
              badge(item.status),
              createElement('span', { className: 'dsu-meta', title: item.path }, item.upstream ? `${item.upstream} · ${item.detail}` : item.detail),
              createElement('button', {
                type: 'button',
                className: 'dsu-btn',
                disabled: busy !== null,
                onClick: () => void runApply(['skills'], [item.name]),
              }, '更新')))));

      const pluginSection = createElement('div', { className: 'dsu-card' },
        createElement('div', { className: 'dsu-row' },
          createElement('span', { className: 'dsu-row-title' }, `插件 (${pluginRows.length})`),
          createElement('span', { className: 'dsu-sub' }, 'profile 里声明的包；@deepseek-ai/* 随 App 更新')),
        pluginRows.length === 0
          ? createElement('div', { className: 'dsu-empty' }, '没有发现插件')
          : createElement('div', { className: 'dsu-list' }, ...pluginRows.map((item) =>
            createElement('div', { className: 'dsu-item', key: item.name },
              createElement('span', { className: 'dsu-name' }, item.name),
              badge(item.status),
              createElement('span', { className: 'dsu-meta', title: item.spec },
                `${item.installed ?? '?'}${item.latest && item.latest !== item.installed ? ` → ${item.latest}` : ''} · ${item.detail}`),
              createElement('button', {
                type: 'button',
                className: 'dsu-btn',
                disabled: busy !== null || item.origin !== 'registry' || item.shipped,
                onClick: () => void runApply(['plugins'], [item.name]),
              }, '更新')))));

      const logCard = log.length === 0 ? null : createElement('div', { className: 'dsu-card' },
        createElement('div', { className: 'dsu-row' }, createElement('span', { className: 'dsu-row-title' }, '最近操作')),
        createElement('div', { className: 'dsu-log' }, log.join('\n')));

      return createElement('div', { className: 'dsu-root' },
        header,
        tabs,
        settingsCard,
        actionCard,
        skillSection,
        pluginSection,
        logCard);
    }

    function SyncIcon() {
      return createElement('span', {
        'aria-hidden': 'true',
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18 },
      }, createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
        createElement('path', { d: 'M13.5 6.5A5.5 5.5 0 0 0 3.2 5.1' }),
        createElement('path', { d: 'M2.5 2.5v3h3' }),
        createElement('path', { d: 'M2.5 9.5a5.5 5.5 0 0 0 10.3 1.4' }),
        createElement('path', { d: 'M13.5 13.5v-3h-3' })));
    }

    const name = 'sync-updater';
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID }, SyncPanel);
      });
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '同步' }, SyncIcon);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
