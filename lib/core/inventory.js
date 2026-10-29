/**
 * 清单（inventory）：技能目录扫描、技能锁文件、profile 插件清单、外部命令探测。
 *
 * 这部分是「整合」的基础：把散落在 ~/.dsh、~/.agents、项目目录、
 * skillshare 源目录里的技能，与 profile 里声明的插件，收拢成同一种结构。
 */
import { readdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentsHome,
  dshHome,
  exists,
  parseFrontmatter,
  profileDir,
  readJson,
  run,
} from './util.js';

/**
 * 技能根目录，按 DSH 自己的扫描优先级排列。
 * @returns {Array<{source:string, path:string, rank:number}>}
 */
export function skillRoots(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = dshHome(env);
  const agents = agentsHome(env);
  const roots = [];
  if (options.includeProject !== false) {
    roots.push({ source: 'project-dsh', path: join(cwd, '.dsh', 'skills'), rank: 100 });
    roots.push({ source: 'project-agents', path: join(cwd, '.agents', 'skills'), rank: 200 });
  }
  if (options.includeUser !== false) {
    roots.push({ source: 'user-dsh', path: join(home, 'skills'), rank: 400 });
    roots.push({ source: 'user-agents', path: join(agents, 'skills'), rank: 500 });
  }
  return roots;
}

/** skillshare 的源目录（若存在）。 */
export function skillshareSourceDir(env = process.env) {
  const home = env.HOME || process.env.HOME || '';
  if (!home) return null;
  const dir = join(home, '.config', 'skillshare', 'skills');
  return exists(dir) ? dir : null;
}

/**
 * 扫描一个技能根：目录型 `<name>/SKILL.md` 与扁平 `<name>.md`。
 * @returns {Promise<Array<{name:string, description:string, path:string, provider:string}>>}
 */
export async function scanRoot(root) {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root.path, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      const file = join(full, 'SKILL.md');
      if (!exists(file)) continue;
      const parsed = await readSkillFile(file);
      if (!parsed) continue;
      skills.push({ ...parsed, path: full, file, provider: root.source, root: root.path });
    } else if (info.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      const parsed = await readSkillFile(full);
      if (!parsed) continue;
      skills.push({
        ...parsed,
        path: full,
        file: full,
        provider: root.source,
        root: root.path,
      });
    }
  }
  return skills;
}

async function readSkillFile(file) {
  try {
    const text = await readFile(file, 'utf8');
    const front = parseFrontmatter(text);
    const name = front.name || file.split('/').slice(-2, -1)[0];
    if (!name) return null;
    return {
      name,
      description: front.description || '',
      whenToUse: front.whenToUse || front.when_to_use || '',
    };
  } catch {
    return null;
  }
}

/** 汇总所有技能根，按 name 去重（先到先得，与 DSH 的 rank 顺序一致）。 */
export async function scanSkills(options = {}) {
  const roots = skillRoots(options);
  const extra = options.extraRoots ?? [];
  const seen = new Set();
  const skills = [];
  for (const root of [...roots, ...extra]) {
    const found = await scanRoot(root);
    for (const skill of found) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { roots: [...roots, ...extra], skills };
}

/** 读取 `~/.agents/.skill-lock.json`（skills CLI 的安装记录）。 */
export async function readSkillLock(env = process.env) {
  const file = join(agentsHome(env), '.skill-lock.json');
  const data = await readJson(file, null);
  return { file, data };
}

/** 读取 profile 的清单：依赖、bundle 列表、安装版本。 */
export async function readProfile(options = {}) {
  const env = options.env ?? process.env;
  const dir = options.profileDir ?? profileDir(env);
  const manifestFile = join(dir, 'package.json');
  const manifest = await readJson(manifestFile, null);
  if (!manifest) return { dir, manifestFile, manifest: null, dependencies: {}, bundles: [], packages: [] };
  const dependencies = manifest.dependencies ?? {};
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  const packages = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    const installed = await installedVersion(dir, name);
    packages.push({
      name,
      spec,
      installed,
      origin: originOfSpec(spec),
      bundled: bundles.includes(name),
      shipped: isShippedBundle(name),
    });
  }
  return { dir, manifestFile, manifest, dependencies, bundles, packages };
}

export function originOfSpec(spec) {
  const value = String(spec ?? '');
  if (value.startsWith('link:')) return 'local-link';
  if (value.startsWith('file:')) return 'local-file';
  if (value.startsWith('workspace:')) return 'workspace';
  if (value.startsWith('git') || value.includes('github.com') || value.includes('gitlab.com')) return 'git';
  if (value.startsWith('http')) return 'tarball';
  return 'registry';
}

/** 安装包是否由 DSH 安装本身提供（随 App 更新，不该被本插件升级）。 */
export function isShippedBundle(name) {
  return name.startsWith('@deepseek-ai/') || name === 'dsh';
}

export async function installedVersion(profileDirPath, name) {
  const file = join(profileDirPath, 'node_modules', name, 'package.json');
  const manifest = await readJson(file, null);
  return manifest?.version ?? null;
}

export async function readPackageManifest(profileDirPath, name) {
  return readJson(join(profileDirPath, 'node_modules', name, 'package.json'), null);
}

/** 依次探测命令是否可用。 */
export async function which(candidates = [], options = {}) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('/')) {
      if (exists(candidate)) return candidate;
      continue;
    }
    const probe = await run(candidate, ['--version'], { timeoutMs: 8_000, ...options });
    if (!probe.timedOut && probe.code !== null && probe.code !== 127) return candidate;
  }
  return null;
}

/** 找到 DSH 运行时的 pnpm（桌面版通常没把 pnpm 放进 PATH）。 */
export function bundledPnpmCandidates(env = process.env) {
  const home = dshHome(env);
  const candidates = [];
  const runtimes = join(home, 'dsh-runtimes');
  if (exists(runtimes)) {
    for (const name of safeReaddirSync(runtimes)) {
      const pnpm = join(runtimes, name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
      if (exists(pnpm)) candidates.push(pnpm);
    }
  }
  return candidates;
}

export function bundledNodeCandidates(env = process.env) {
  const home = dshHome(env);
  const candidates = [];
  const runtimes = join(home, 'dsh-runtimes');
  if (exists(runtimes)) {
    for (const name of safeReaddirSync(runtimes)) {
      const node = join(runtimes, name, 'dependencies', 'node', 'bin', 'node');
      if (exists(node)) candidates.push(node);
    }
  }
  return candidates;
}

function safeReaddirSync(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 技能是否位于某个 git 工作树内（tracked repo / 手动 clone）。 */
export async function gitRootOf(path) {
  let current = path;
  for (let depth = 0; depth < 6; depth += 1) {
    if (exists(join(current, '.git'))) return current;
    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 最近使用的默认工作区（面板/定时任务没有 session 时用它当 cwd）。 */
export async function defaultWorkspaceCwd(env = process.env) {
  const file = join(dshHome(env), 'storages', 'workspace.json');
  const data = await readJson(file, null);
  const id = data?.global?.defaultWorkspaceId;
  const path = id ? data?.tables?.workspaces?.[id]?.path : null;
  return path ?? env.DSH_WORKSPACE ?? process.cwd();
}

export async function fileMtime(path) {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}
