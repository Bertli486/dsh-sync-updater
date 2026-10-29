/**
 * dsh-sync-updater —— 宿主半侧插件
 *
 * 三块能力：
 *   1. 三个模型工具：sync_status / sync_check / sync_apply
 *   2. 面板 HTTP API：/sync-updater/api/{state,check,apply,settings}
 *   3. 自动检查定时器（间隔与开关可以被面板实时改写，无需重启）
 *
 * 设置来源的优先级：内置默认值 < cordis.patch.yml 的 config < 面板写入的
 * ~/.dsh/sync-updater/settings.json。面板改写后立即重排定时器。
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { defaultWorkspaceCwd, readProfile, readSkillLock, scanSkills } from './core/inventory.js';
import { checkPlugins, checkSkills, resolveSkillSource } from './core/check.js';
import { applyPlugin, applySkill, fetchSkillDir, resolveSkillshare } from './core/apply.js';
import {
  agentsHome,
  dshHome,
  ensureDir,
  fetchJson,
  isoNow,
  profileDir,
  readJson,
  run,
  stateDir,
  truncate,
  writeJsonAtomic,
} from './core/util.js';
import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export const name = 'sync-updater';
export const inject = ['tools'];

const DEFAULTS = {
  autoCheckIntervalMinutes: 360,
  autoApplySkills: false,
  includeProjectSkills: true,
  includeUserSkills: true,
  registry: '',
  pnpmCommand: '',
  gitCommand: '',
  skillshareCommand: '',
};

const API_PREFIX = '/sync-updater/api';

/** 配置 schema；schemastery 不可用时退化为 undefined，插件照样能跑。 */
export let Config;
try {
  const schemastery = await import('@deepseek-ai/schemastery');
  const z = schemastery.default ?? schemastery;
  Config = z.object({
    autoCheckIntervalMinutes: z.number().default(DEFAULTS.autoCheckIntervalMinutes),
    autoApplySkills: z.boolean().default(DEFAULTS.autoApplySkills),
    includeProjectSkills: z.boolean().default(DEFAULTS.includeProjectSkills),
    includeUserSkills: z.boolean().default(DEFAULTS.includeUserSkills),
    registry: z.string().default(DEFAULTS.registry),
    pnpmCommand: z.string().default(DEFAULTS.pnpmCommand),
    gitCommand: z.string().default(DEFAULTS.gitCommand),
    skillshareCommand: z.string().default(DEFAULTS.skillshareCommand),
  });
} catch {
  Config = undefined;
}

function paths(env = process.env) {
  return {
    home: dshHome(env),
    profile: profileDir(env),
    state: stateDir(env),
    agents: agentsHome(env),
    stateFile: join(stateDir(env), 'state.json'),
    settingsFile: join(stateDir(env), 'settings.json'),
    logFile: join(stateDir(env), 'plugin.log'),
  };
}

async function loadState(p) {
  return (await readJson(p.stateFile, null)) ?? { schemaVersion: 1, upstream: {}, lastCheck: null, lastRun: null, history: [] };
}

async function saveState(p, state) {
  state.schemaVersion = 1;
  state.history = (state.history ?? []).slice(-49);
  await writeJsonAtomic(p.stateFile, state);
}

async function log(p, line) {
  try {
    await ensureDir(p.state);
    await appendFile(p.logFile, `${isoNow()} ${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 合并默认值、cordis config 与面板设置。 */
function mergeSettings(base, file) {
  const merged = { ...DEFAULTS, ...(base ?? {}), ...(file ?? {}) };
  merged.autoCheckIntervalMinutes = Number(merged.autoCheckIntervalMinutes) || 0;
  merged.autoApplySkills = Boolean(merged.autoApplySkills);
  return merged;
}

async function resolveCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory');
    if (workingDirectory && exec?.agent) {
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal);
      if (cwd) return cwd;
    }
  } catch {
    /* 退回默认工作区 */
  }
  return defaultWorkspaceCwd();
}

async function inventory(ctx, s, exec) {
  const p = paths();
  const cwd = await resolveCwd(ctx, exec);
  const extraRoots = [];
  const skillshareDir = join(process.env.HOME ?? '', '.config', 'skillshare', 'skills');
  if (existsSync(skillshareDir)) extraRoots.push({ source: 'skillshare', path: skillshareDir, rank: 600 });
  const scanned = await scanSkills({
    cwd,
    env: process.env,
    includeProject: s.includeProjectSkills,
    includeUser: s.includeUserSkills,
    extraRoots,
  });
  const lock = await readSkillLock(process.env);
  const profile = await readProfile({ env: process.env });
  return { cwd, p, scanned, lock, profile };
}

function dshVersion() {
  return process.env.DSH_APP_VERSION || process.env.DSH_VERSION || null;
}

/* --------------------------------- tools -------------------------------- */

async function statusTool(ctx, exec, s) {
  const { cwd, p, scanned, lock, profile } = await inventory(ctx, s, exec);
  const state = await loadState(p);
  const lockSkills = lock.data?.skills ?? {};
  return {
    dshVersion: dshVersion(),
    cwd,
    profileDir: profile.dir,
    auto: {
      autoCheckIntervalMinutes: s.autoCheckIntervalMinutes,
      autoApplySkills: s.autoApplySkills,
      enabled: Number(s.autoCheckIntervalMinutes) > 0,
    },
    lastCheck: state.lastCheck
      ? { at: state.lastCheck.at, plugins: state.lastCheck.plugins, skills: state.lastCheck.skills }
      : null,
    plugins: profile.packages.map((pkg) => ({
      name: pkg.name,
      installed: pkg.installed,
      spec: pkg.spec,
      origin: pkg.origin,
      bundled: pkg.bundled,
      shipped: pkg.shipped,
    })),
    bundles: profile.bundles,
    skills: scanned.skills.map((skill) => ({
      name: skill.name,
      provider: skill.provider,
      path: skill.path,
      upstream: lockSkills[skill.name]?.source ?? null,
      tracked: Boolean(lockSkills[skill.name]),
    })),
    counts: {
      plugins: profile.packages.length,
      skills: scanned.skills.length,
      trackedSkills: scanned.skills.filter((skill) => lockSkills[skill.name]).length,
    },
  };
}

async function checkTool(ctx, exec, s) {
  const { p, scanned, lock, profile } = await inventory(ctx, s, exec);
  const state = await loadState(p);
  const started = Date.now();
  const [plugins, skills] = await Promise.all([
    checkPlugins(profile, { registry: s.registry }),
    checkSkills(scanned.skills, lock.data, state, { run, checkGit: true }),
  ]);
  const summary = {
    at: isoNow(started),
    ms: Date.now() - started,
    plugins: {
      total: plugins.length,
      updates: plugins.filter((item) => item.status === 'update-available').length,
      rangeBlocked: plugins.filter((item) => item.status === 'range-blocked').length,
      unknown: plugins.filter((item) => item.status === 'unknown').length,
    },
    skills: {
      total: skills.length,
      updates: skills.filter((item) => item.status === 'update-available').length,
      baselines: skills.filter((item) => item.status === 'baseline').length,
      unknown: skills.filter((item) => item.status === 'unknown').length,
    },
  };
  state.lastCheck = { ...summary, result: { plugins, skills } };
  state.history.push({ kind: 'check', ...summary });
  await saveState(p, state);
  await log(p, `check plugins=${summary.plugins.total} skills=${summary.skills.total} updates=${summary.plugins.updates + summary.skills.updates}`);
  return { summary, plugins, skills };
}

async function applyTool(ctx, exec, s, args = {}) {
  const { p, scanned, lock, profile } = await inventory(ctx, s, exec);
  const state = await loadState(p);
  const targets = Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : ['skills', 'plugins'];
  const wanted = Array.isArray(args.names) && args.names.length > 0 ? new Set(args.names) : null;
  const dryRun = args.dryRun === true;
  const results = { skills: [], plugins: [], skipped: [] };

  if (targets.includes('skills')) {
    for (const skill of scanned.skills) {
      if (wanted && !wanted.has(skill.name)) continue;
      const source = await resolveSkillSource(skill, lock.data, state.installed);
      if (dryRun) {
        results.skills.push({
          name: skill.name,
          source: source.kind,
          applied: false,
          detail: source.kind === 'none' ? '没有可识别上游来源' : `将用 ${source.kind} 方式更新`,
        });
        continue;
      }
      const outcome = await applySkill(skill, source, { config: s, env: process.env });
      results.skills.push(outcome);
      await log(p, `apply skill=${skill.name} source=${source.kind} applied=${outcome.applied} ${outcome.detail}`);
    }
  }

  if (targets.includes('plugins')) {
    for (const pkg of profile.packages) {
      if (wanted && !wanted.has(pkg.name)) continue;
      if (pkg.shipped) {
        results.skipped.push({ name: pkg.name, reason: '随 DSH 安装提供' });
        continue;
      }
      if (pkg.origin !== 'registry') {
        results.skipped.push({ name: pkg.name, reason: `来源是 ${pkg.origin}` });
        continue;
      }
      if (dryRun) {
        results.plugins.push({ name: pkg.name, applied: false, detail: `将 pnpm add ${pkg.name}@${args.toLatest ? 'latest' : pkg.spec}` });
        continue;
      }
      const outcome = await applyPlugin(pkg, {
        profileDir: profile.dir,
        config: s,
        env: process.env,
        toLatest: args.toLatest === true,
      });
      results.plugins.push(outcome);
      await log(p, `apply plugin=${pkg.name} applied=${outcome.applied} ${outcome.detail}`);
    }
  }

  const appliedCount = [...results.skills, ...results.plugins].filter((item) => item.applied).length;
  state.lastRun = { at: isoNow(), applied: appliedCount, dryRun, targets };
  state.history.push({ kind: 'apply', at: state.lastRun.at, applied: appliedCount, targets });
  if (!dryRun) await saveState(p, state);
  return { dryRun, applied: appliedCount, restartRequired: results.plugins.some((item) => item.applied), results };
}

function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec) {
      return definition.run(args ?? {}, exec);
    },
  };
}

const STATUS_TOOL = {
  name: 'sync_status',
  description:
    '列出 DSH 里已安装的技能（skills）与插件（plugins）：版本、来源、路径、是否随 App 提供，以及自动检查配置和上次检查结果。只读、不联网，适合在更新前先看清现状。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const CHECK_TOOL = {
  name: 'sync_check',
  description:
    '联网检查已安装技能与插件是否有更新：插件对比 npm registry 最新版，技能对比上游 GitHub 仓库里的 SKILL.md 内容哈希或本地 git 跟踪分支。结果会写入状态文件，供 sync_apply 使用。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const APPLY_TOOL = {
  name: 'sync_apply',
  description:
    '应用更新。skills 走 GitHub 下载（先备份）、git pull 或 skillshare；plugins 走 profile 里的 pnpm add。默认只升级声明范围内的版本，toLatest 才会跨范围升到 latest。dryRun 只报告不执行。',
  parameters: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: "要更新的类别：['skills']、['plugins'] 或两者都写。默认两者。",
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '只处理这些名字（技能名或包名）；省略表示全部。',
      },
      dryRun: { type: 'boolean', description: '只报告，不写文件、不装包。' },
      toLatest: { type: 'boolean', description: '插件是否跨出声明范围直接装 latest（默认 false）。' },
    },
    additionalProperties: false,
  },
};

/* ---------------------------------- http --------------------------------- */

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value ?? null));
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 面板用的合并视图：清单 + 上次检查结果 + 设置。 */
async function panelState(ctx, runtime) {
  const p = paths();
  const { cwd, scanned, lock, profile } = await inventory(ctx, runtime.settings, undefined);
  const state = await loadState(p);
  const lockSkills = lock.data?.skills ?? {};
  const last = state.lastCheck?.result ?? null;
  const checkedPlugins = new Map((last?.plugins ?? []).map((item) => [item.name, item]));
  const checkedSkills = new Map((last?.skills ?? []).map((item) => [item.name, item]));

  return {
    now: isoNow(),
    cwd,
    profileDir: profile.dir,
    dshVersion: dshVersion(),
    settings: {
      autoCheckIntervalMinutes: runtime.settings.autoCheckIntervalMinutes,
      autoApplySkills: runtime.settings.autoApplySkills,
    },
    lastCheck: state.lastCheck
      ? { at: state.lastCheck.at, ms: state.lastCheck.ms, plugins: state.lastCheck.plugins, skills: state.lastCheck.skills }
      : null,
    lastRun: state.lastRun ?? null,
    skills: scanned.skills.map((skill) => {
      const checked = checkedSkills.get(skill.name) ?? null;
      return {
        name: skill.name,
        provider: skill.provider,
        path: skill.path,
        upstream: lockSkills[skill.name]?.source ?? null,
        status: checked?.status ?? 'unchecked',
        detail: checked?.detail ?? '还没检查过',
        source: checked?.source ?? null,
      };
    }),
    plugins: profile.packages.map((pkg) => {
      const checked = checkedPlugins.get(pkg.name) ?? null;
      // 上次检查后刚升过级时，别把旧结论当成"还有更新"
      const fresh = checked && checked.latest && pkg.installed && checked.latest === pkg.installed
        ? { ...checked, status: 'current', detail: '已是最新' }
        : checked;
      return {
        name: pkg.name,
        installed: pkg.installed,
        latest: checked?.latest ?? null,
        spec: pkg.spec,
        origin: pkg.origin,
        shipped: pkg.shipped,
        status: fresh?.status ?? (pkg.shipped ? 'shipped' : 'unchecked'),
        detail: fresh?.detail ?? (pkg.shipped ? '随 App 提供' : '还没检查过'),
      };
    }),
  };
}


/* -------------------------------- discover ------------------------------- */

const SKILLS_SH = 'https://skills.sh';
const RISK_ORDER = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** skills.sh 的搜索（网页内部接口，未文档化；失败要能优雅降级）。 */
async function skillsShSearch(query, owner) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return { query: q, skills: [], error: 'q-too-short' };
  const url = new URL(`${SKILLS_SH}/api/search`);
  url.searchParams.set('q', q);
  if (owner) url.searchParams.set('owner', String(owner).trim());
  const data = await fetchJson(url.toString(), { timeoutMs: 15_000 });
  const skills = (Array.isArray(data?.skills) ? data.skills : []).map((item) => ({
    id: item.id,
    name: item.name,
    source: item.source,
    skillId: item.skillId,
    installs: item.installs ?? 0,
    url: `${SKILLS_SH}/${item.id}`,
  }));
  return { query: q, searchType: data?.searchType ?? null, skills };
}

/** 公开的审计接口：返回多厂商结论，用来在安装前给出风险提示。 */
async function skillsShAudit(source, slug) {
  const [owner, repo] = String(source ?? '').split('/');
  if (!owner || !repo || !slug) return { error: 'invalid-target' };
  const url = `${SKILLS_SH}/api/v1/skills/audit/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`;
  try {
    const data = await fetchJson(url, { timeoutMs: 15_000 });
    const audits = (Array.isArray(data?.audits) ? data.audits : []).map((item) => ({
      provider: item.provider,
      status: item.status,
      riskLevel: item.riskLevel ?? null,
      summary: item.summary ?? '',
    }));
    const rank = (item) => (item.status === 'fail' ? 3 : item.status === 'warn' ? 2 : 1);
    const risk = (item) => RISK_ORDER[item.riskLevel] ?? 0;
    const worst = audits.reduce(
      (acc, item) => (rank(item) > rank(acc) || (rank(item) === rank(acc) && risk(item) > risk(acc)) ? item : acc),
      { status: 'pass', riskLevel: 'NONE' },
    );
    return { audits, verdict: worst.status, riskLevel: worst.riskLevel };
  } catch (error) {
    if (error?.status === 404) return { audits: [], error: 'no-audit' };
    return { error: truncate(error?.message ?? error, 160) };
  }
}

/**
 * 安装一个技能。
 * 主路径：git blobless clone 定位目录 → 稀疏检出 → 复制到 ~/.agents/skills（全程非交互）。
 * 兜底：仓库里找不到目录时才交给 skillshare（它有 TUI，非交互场景容易挂起，所以不是首选）。
 */
async function installSkill(source, skillId, options = {}) {
  const env = process.env;
  const dryRun = options.dryRun === true;
  if (!source || !skillId) return { applied: false, detail: '缺少 source 或 skillId' };

  const work = join(tmpdir(), `dsh-sync-install-${Date.now()}`);
  try {
    const located = await fetchSkillDir(String(source), String(skillId), work);
    if (!located) {
      return {
        applied: false,
        method: 'git',
        detail: `仓库 ${source} 里没有叫 ${skillId} 的技能目录；如果它只有根目录 SKILL.md，请手动安装`,
      };
    }
    if (dryRun) {
      return { applied: false, dryRun: true, method: 'git', detail: `已定位到 ${located.dir}，dry-run 不写入`, dir: located.dir };
    }
    const targetDir = join(agentsHome(env), 'skills', String(skillId));
    if (existsSync(targetDir)) {
      const stamp = isoNow().replace(/[:.]/g, '-');
      const backupDir = join(paths(env).state, 'backups', stamp);
      await mkdir(backupDir, { recursive: true });
      await cp(await realpath(targetDir).catch(() => targetDir), join(backupDir, String(skillId)), { recursive: true, force: true });
    }
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await cp(located.path, targetDir, { recursive: true, force: true });

    // 记一笔，之后 sync_check 才知道它的上游是谁
    const state = await loadState(paths(env));
    state.installed = state.installed ?? {};
    state.installed[String(skillId)] = {
      source: String(source),
      skillId: String(skillId),
      repoDir: located.dir,
      path: targetDir,
      installedAt: isoNow(),
    };
    await saveState(paths(env), state);
    return { applied: true, method: 'git', detail: `已安装到 ${targetDir}`, path: targetDir };
  } catch (error) {
    return { applied: false, method: 'git', detail: truncate(error?.message ?? error, 300) };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function registerRoutes(scope, runtime) {
  const webServer = scope.webServer;
  if (!webServer?.register) return 0;
  const p = paths();

  const route = (path, handler) =>
    scope.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res);
            } catch (error) {
              sendJson(res, 500, { error: String(error && error.message ? error.message : error) });
            }
          },
        }),
      `dsh-sync-updater: ${path}`,
    );

  route(`${API_PREFIX}/state`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    sendJson(res, 200, { ...(await panelState(scope, runtime)), busy: runtime.busy });
  });

  route(`${API_PREFIX}/check`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (runtime.busy) return sendJson(res, 409, { error: 'busy' });
    runtime.busy = true;
    try {
      const result = await checkTool(scope, undefined, runtime.settings);
      sendJson(res, 200, { ...(await panelState(scope, runtime)), check: result.summary });
    } finally {
      runtime.busy = false;
    }
  });

  route(`${API_PREFIX}/apply`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (runtime.busy) return sendJson(res, 409, { error: 'busy' });
    const body = await readBody(req);
    runtime.busy = true;
    try {
      const outcome = await applyTool(scope, undefined, runtime.settings, {
        targets: Array.isArray(body.targets) ? body.targets : undefined,
        names: Array.isArray(body.names) ? body.names : undefined,
        toLatest: body.toLatest === true,
      });
      await log(p, `panel apply applied=${outcome.applied} targets=${JSON.stringify(body.targets ?? null)}`);
      sendJson(res, 200, { ...(await panelState(scope, runtime)), outcome });
    } finally {
      runtime.busy = false;
    }
  });

  route(`${API_PREFIX}/settings`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const patch = {};
    if (body.autoCheckIntervalMinutes !== undefined) {
      const minutes = Number(body.autoCheckIntervalMinutes);
      if (!Number.isFinite(minutes) || minutes < 0) return sendJson(res, 400, { error: 'invalid autoCheckIntervalMinutes' });
      patch.autoCheckIntervalMinutes = Math.round(minutes);
    }
    if (body.autoApplySkills !== undefined) patch.autoApplySkills = Boolean(body.autoApplySkills);
    const saved = await saveFileSettings(patch);
    runtime.settings = mergeSettings(runtime.baseConfig, saved);
    runtime.arm();
    await log(p, `settings ${JSON.stringify(patch)}`);
    sendJson(res, 200, { ...(await panelState(scope, runtime)), saved: runtime.settings });
  });

  route(`${API_PREFIX}/discover`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const result = await skillsShSearch(url.searchParams.get('q') ?? '', url.searchParams.get('owner') ?? '');
      sendJson(res, 200, { ...result, installed: (await inventory(scope, runtime.settings, undefined)).scanned.skills.map((item) => item.name) });
    } catch (error) {
      sendJson(res, 502, { error: `skills.sh 搜索不可用：${truncate(error?.message ?? error, 160)}`, skills: [] });
    }
  });

  route(`${API_PREFIX}/audit`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    sendJson(res, 200, await skillsShAudit(url.searchParams.get('source') ?? '', url.searchParams.get('slug') ?? ''));
  });

  route(`${API_PREFIX}/install`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (runtime.busy) return sendJson(res, 409, { error: 'busy' });
    const body = await readBody(req);
    if (!body.source || !body.skillId) return sendJson(res, 400, { error: 'source 和 skillId 必填' });
    runtime.busy = true;
    try {
      const install = await installSkill(body.source, body.skillId, { dryRun: body.dryRun === true });
      await log(p, `install ${body.source}/${body.skillId} applied=${install.applied} ${install.detail}`);
      sendJson(res, 200, { install, ...(await panelState(scope, runtime)) });
    } finally {
      runtime.busy = false;
    }
  });

  return 7;
}

async function saveFileSettings(patch) {
  const p = paths();
  const current = (await readJson(p.settingsFile, null)) ?? {};
  const next = { ...current, ...patch, updatedAt: isoNow() };
  await writeJsonAtomic(p.settingsFile, next);
  return next;
}

/* --------------------------------- apply --------------------------------- */

export function apply(ctx, config = {}) {
  const p = paths();

  const runtime = {
    baseConfig: { ...config },
    settings: mergeSettings(config, {}),
    busy: false,
    timer: null,
    bootTimer: null,
    arm: () => {},
  };

  runtime.arm = () => {
    if (runtime.timer) clearInterval(runtime.timer);
    if (runtime.bootTimer) clearTimeout(runtime.bootTimer);
    runtime.timer = null;
    runtime.bootTimer = null;
    const minutes = Number(runtime.settings.autoCheckIntervalMinutes) || 0;
    if (minutes <= 0) return;
    const tick = async () => {
      if (runtime.busy) return;
      runtime.busy = true;
      try {
        const checked = await checkTool(ctx, undefined, runtime.settings);
        if (runtime.settings.autoApplySkills) {
          const pending = checked.skills.filter((item) => item.status === 'update-available');
          if (pending.length > 0) {
            const outcome = await applyTool(ctx, undefined, runtime.settings, {
              targets: ['skills'],
              names: pending.map((item) => item.name),
            });
            await log(p, `auto-apply skills=${outcome.applied}`);
          }
        }
      } catch (error) {
        await log(p, `auto-check failed: ${error && error.message ? error.message : error}`);
      } finally {
        runtime.busy = false;
      }
    };
    runtime.bootTimer = setTimeout(tick, 90_000);
    runtime.timer = setInterval(tick, minutes * 60_000);
    if (typeof runtime.timer.unref === 'function') runtime.timer.unref();
    if (typeof runtime.bootTimer.unref === 'function') runtime.bootTimer.unref();
  };

  try {
    ctx.tools.register(tool({ ...STATUS_TOOL, run: (args, exec) => statusTool(ctx, exec, runtime.settings) }));
    ctx.tools.register(tool({ ...CHECK_TOOL, run: (args, exec) => checkTool(ctx, exec, runtime.settings) }));
    ctx.tools.register(tool({ ...APPLY_TOOL, run: (args, exec) => applyTool(ctx, exec, runtime.settings, args) }));
  } catch (error) {
    log(p, `register failed: ${error && error.message ? error.message : error}`).catch(() => {});
    return;
  }

  // webServer 不一定在 apply 时已经就绪，等它出现再挂路由
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        const count = registerRoutes(scope, runtime);
        log(p, `routes registered=${count}`).catch(() => {});
      } catch (error) {
        log(p, `routes failed: ${error && error.message ? error.message : error}`).catch(() => {});
      }
    });
  } catch (error) {
    log(p, `routes inject failed: ${error && error.message ? error.message : error}`).catch(() => {});
  }

  ctx.effect(
    () => () => {
      if (runtime.timer) clearInterval(runtime.timer);
      if (runtime.bootTimer) clearTimeout(runtime.bootTimer);
    },
    'dsh-sync-updater: timers',
  );

  void (async () => {
    try {
      runtime.settings = mergeSettings(runtime.baseConfig, await readJson(p.settingsFile, null));
    } catch {
      /* 用默认值 */
    }
    runtime.arm();
    await log(p, `loaded interval=${runtime.settings.autoCheckIntervalMinutes}m autoApplySkills=${runtime.settings.autoApplySkills}`);
  })();
}

export { statusTool, checkTool, applyTool, paths, loadState, panelState };
