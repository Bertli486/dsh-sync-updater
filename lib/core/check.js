/**
 * 更新检测：插件看 npm registry，技能看上游仓库。
 *
 * 技能检测优先用 raw.githubusercontent.com 直接取上游文件并算 sha256 ——
 * 没有 API 限流、比整仓 commit 更精确；取不到时退回 GitHub API。
 */
import { readFile, realpath } from 'node:fs/promises';
import { fetchJson, fetchText, compareVersions, satisfiesRange, sha256Hex, truncate, run } from './util.js';
import { gitRootOf, installedVersion, readPackageManifest, skillshareSourceDir } from './inventory.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const RAW_BASE = 'https://raw.githubusercontent.com';

function registryBase(registry) {
  const value = String(registry ?? '').trim() || DEFAULT_REGISTRY;
  return value.replace(/\/+$/, '');
}

/** 拉取 npm 上某个包的最新版本（dist-tags.latest）。 */
export async function latestVersion(name, options = {}) {
  const registry = registryBase(options.registry);
  const headers = {};
  const token = process.env.NPM_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const urls = [`${registry}/${name}/latest`, `${registry}/${encodeURIComponent(name)}/latest`];
  let lastError = null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url, { timeoutMs: options.timeoutMs ?? 15_000, headers });
      return { version: data?.version ?? null, registry, url };
    } catch (error) {
      lastError = error;
      if (error.status === 404) return { version: null, registry, url, error: 'not-found' };
    }
  }
  return { version: null, registry, error: truncate(lastError?.message ?? 'registry error', 200) };
}

/** 插件更新检测。 */
export async function checkPlugins(profile, options = {}) {
  const results = [];
  for (const pkg of profile.packages) {
    const base = {
      name: pkg.name,
      installed: pkg.installed ?? (await installedVersion(profile.dir, pkg.name)),
      spec: pkg.spec,
      origin: pkg.origin,
      bundled: pkg.bundled,
      shipped: pkg.shipped,
    };
    if (pkg.shipped) {
      results.push({ ...base, status: 'shipped', detail: '随 DSH 安装提供，跟 App 版本一起更新' });
      continue;
    }
    if (pkg.origin !== 'registry') {
      results.push({ ...base, status: 'local', detail: `来源是 ${pkg.origin}，需要在该目录/git 仓库里更新` });
      continue;
    }
    const latest = await latestVersion(pkg.name, options);
    if (latest.version === null) {
      results.push({
        ...base,
        status: 'unknown',
        latest: null,
        detail: latest.error === 'not-found' ? 'registry 上没有这个包（可能已下架或为私有包）' : `查询失败：${latest.error}`,
      });
      continue;
    }
    const delta = compareVersions(latest.version, base.installed ?? '0.0.0');
    const inRange = satisfiesRange(latest.version, pkg.spec);
    let status = 'current';
    let detail = '已是最新';
    if (delta === null) {
      status = 'unknown';
      detail = '版本号无法比较';
    } else if (delta > 0) {
      if (inRange === false) {
        status = 'range-blocked';
        detail = `最新 ${latest.version} 超出声明范围 ${pkg.spec}，默认不升级`;
      } else {
        status = 'update-available';
        detail = `${base.installed} → ${latest.version}`;
      }
    }
    const manifest = await readPackageManifest(profile.dir, pkg.name);
    const engines = manifest?.engines?.dsh ?? manifest?.engines?.dshVersion ?? null;
    results.push({ ...base, latest: latest.version, status, detail, enginesDsh: engines });
  }
  return results;
}

const GITHUB_API = 'https://api.github.com';

function githubHeaders() {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function splitRepo(repo) {
  const cleaned = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [owner, name] = cleaned.split('/');
  if (!owner || !name) return null;
  return { owner, name, full: `${owner}/${name}` };
}

/** 某条路径上最后一次提交（API 版；限流时返回 rate-limited）。 */
export async function lastCommitForPath(repo, path, options = {}) {
  const target = splitRepo(repo);
  if (!target) return { error: 'invalid-repo' };
  const url = `${GITHUB_API}/repos/${target.owner}/${target.name}/commits?path=${encodeURIComponent(path ?? '')}&per_page=1`;
  try {
    const data = await fetchJson(url, { timeoutMs: options.timeoutMs ?? 15_000, headers: githubHeaders() });
    const commit = Array.isArray(data) ? data[0] : null;
    if (!commit) return { sha: null, date: null };
    return { sha: commit.sha, date: commit.commit?.committer?.date ?? null };
  } catch (error) {
    if (error.status === 404) return { error: 'not-found' };
    if (error.status === 403) return { error: 'rate-limited' };
    return { error: truncate(error.message, 160) };
  }
}

/** 上游 SKILL.md 的当前内容哈希（走 raw，无限流）。 */
export async function upstreamFileHash(repo, skillPath, ref = 'HEAD', options = {}) {
  const target = splitRepo(repo);
  if (!target) return { error: 'invalid-repo' };
  const url = `${RAW_BASE}/${target.owner}/${target.name}/${ref}/${String(skillPath ?? '').replace(/^\/+/, '')}`;
  try {
    const text = await fetchText(url, { timeoutMs: options.timeoutMs ?? 20_000 });
    return { url, hash: sha256Hex(text), bytes: text.length };
  } catch (error) {
    if (error.status === 404) return { error: 'not-found' };
    return { error: truncate(error.message, 160) };
  }
}

/** 技能的「上游来源」判定：skills 锁 → 面板安装记录 → git 工作树 → skillshare 源。 */
export async function resolveSkillSource(skill, lock, installed) {
  const entry = lock?.skills?.[skill.name];
  if (entry?.source && entry.sourceType === 'github') {
    const skillPath = String(entry.skillPath ?? '');
    const isDir = skillPath.endsWith('/SKILL.md');
    const dir = isDir ? skillPath.replace(/\/SKILL\.md$/, '') : skillPath.split('/').slice(0, -1).join('/');
    return { kind: 'lock', repo: entry.source, dir, skillPath, isDir, entry };
  }
  const own = installed?.[skill.name];
  if (own?.source) {
    const dir = String(own.repoDir ?? own.skillId ?? skill.name);
    return {
      kind: 'lock',
      repo: own.source,
      dir,
      skillPath: `${dir}/SKILL.md`,
      isDir: true,
      origin: 'discover',
    };
  }
  const gitRoot = await gitRootOf(skill.path);
  if (gitRoot) return { kind: 'git', root: gitRoot };
  const shareDir = skillshareSourceDir();
  if (shareDir) {
    const real = await realpath(skill.path).catch(() => skill.path);
    if (String(real).startsWith(shareDir)) return { kind: 'skillshare', dir: shareDir, real };
  }
  return { kind: 'none' };
}

async function localFileHash(file) {
  try {
    return sha256Hex(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 技能更新检测。
 * @param {Array} skills scanSkills().skills
 * @param {object} lock readSkillLock().data
 * @param {object} state 读取的 state（记录上游基线哈希）
 */
export async function checkSkills(skills, lock, state, options = {}) {
  const results = [];
  const upstream = state.upstream ?? (state.upstream = {});
  const checkGit = options.checkGit !== false;
  const runCommand = options.run ?? run;

  for (const skill of skills) {
    const source = await resolveSkillSource(skill, lock, state.installed);

    if (source.kind === 'lock') {
      const key = `${source.repo}#${source.skillPath}`;
      const upstreamFile = await upstreamFileHash(source.repo, source.skillPath, 'HEAD', options);
      const localHash = await localFileHash(skill.file);
      const recorded = upstream[key] ?? null;

      let status = 'unknown';
      let detail = '';
      if (upstreamFile.error === 'not-found') {
        status = 'unknown';
        detail = '上游没有这个路径（可能已移动或删除）';
      } else if (upstreamFile.error) {
        status = 'unknown';
        detail = `上游查询失败：${upstreamFile.error}`;
      } else if (!recorded) {
        status = 'baseline';
        detail = '首次检查，已记录上游基线';
      } else if (recorded.hash !== upstreamFile.hash) {
        status = 'update-available';
        detail = '上游 SKILL.md 已更新';
      } else {
        status = 'current';
        detail = '上游无变化';
      }

      if (upstreamFile.hash) {
        upstream[key] = {
          hash: upstreamFile.hash,
          checkedAt: new Date().toISOString(),
          repo: source.repo,
          skillPath: source.skillPath,
          localHash,
        };
      }

      results.push({
        name: skill.name,
        provider: skill.provider,
        path: skill.path,
        source: { kind: 'github', repo: source.repo, dir: source.dir },
        status,
        detail,
        locallyModified: Boolean(recorded?.localHash && localHash && localHash !== recorded.localHash),
        upstreamHash: upstreamFile.hash ?? null,
        localHash,
      });
      continue;
    }

    if (source.kind === 'git' && checkGit) {
      const fetch = await runCommand('git', ['-C', source.root, 'fetch', '--quiet'], { timeoutMs: 30_000 });
      const behind = await runCommand('git', ['-C', source.root, 'rev-list', '--count', 'HEAD..@{upstream}'], {
        timeoutMs: 15_000,
      });
      const count = Number.parseInt(String(behind?.stdout ?? '').trim(), 10);
      const status = !behind || behind.code !== 0 ? 'unknown' : count > 0 ? 'update-available' : 'current';
      results.push({
        name: skill.name,
        provider: skill.provider,
        path: skill.path,
        source: { kind: 'git', root: source.root },
        status,
        detail:
          status === 'update-available'
            ? `git 跟踪分支落后 ${count} 个提交${fetch && !fetch.ok ? '（fetch 失败，结果可能是旧的）' : ''}`
            : status === 'current'
              ? 'git 跟踪分支已是最新'
              : '无法读取 git 上游状态',
        behind: Number.isNaN(count) ? null : count,
      });
      continue;
    }

    if (source.kind === 'skillshare') {
      results.push({
        name: skill.name,
        provider: skill.provider,
        path: skill.path,
        source: { kind: 'skillshare' },
        status: 'managed',
        detail: '由 skillshare 管理；sync_apply 会转交给 skillshare update/sync',
      });
      continue;
    }

    results.push({
      name: skill.name,
      provider: skill.provider,
      path: skill.path,
      source: { kind: 'none' },
      status: 'no-source',
      detail: '没有记录上游来源（本地作者技能或 skillshare 拷贝），无法自动更新',
    });
  }
  return results;
}
