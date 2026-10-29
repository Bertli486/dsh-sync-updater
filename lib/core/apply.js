/**
 * 应用更新：技能（git pull / git sparse 下载 / skillshare）与插件（pnpm add）。
 *
 * 写操作先备份、失败回滚；不修改 skills CLI 的 `.skill-lock.json`
 * （哈希由它自己维护，擅自改写会让它把技能判成 modified）。
 */
import { cp, mkdir, realpath, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoNow, run, truncate } from './util.js';
import { bundledNodeCandidates, bundledPnpmCandidates, gitRootOf, which } from './inventory.js';
import { latestVersion } from './check.js';
import { satisfiesRange } from './util.js';

const GITHUB_API = 'https://api.github.com';

function githubHeaders() {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const error = new Error(`GitHub ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function downloadFile(url, target, headers = {}) {
  const response = await fetch(url, { headers: { ...headers, ...(url.includes('api.github.com') ? githubHeaders() : {}) } });
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, buffer);
}

/** 递归下载技能目录（API 版，作为 git 失败时的兜底）。 */
async function downloadSkillTree(repo, dir, target, headers = githubHeaders()) {
  const [owner, name] = String(repo).split('/');
  const url = `${GITHUB_API}/repos/${owner}/${name}/contents/${encodeURIComponent(dir).replace(/%2F/g, '/')}?ref=HEAD`;
  const items = await githubJson(url);
  const list = Array.isArray(items) ? items : [items];
  for (const item of list) {
    if (item.type === 'dir') {
      await downloadSkillTree(repo, item.path, join(target, item.name), headers);
    } else if (item.type === 'file') {
      await downloadFile(item.download_url, join(target, item.name), headers);
    }
  }
}

/**
 * 在仓库里定位某个技能目录：只取目录树（blob:none + no-checkout），
 * 按 SKILL.md 的父目录名匹配 skillId，再稀疏检出该目录。
 * 完全非交互，也不依赖 skillshare。
 * @returns {Promise<{path:string, dir:string}|null>} 克隆目录的绝对路径与仓库内相对路径
 */
export async function fetchSkillDir(repo, skillId, workDir) {
  const url = `https://github.com/${repo}.git`;
  const temp = join(workDir, 'locate');
  await rm(temp, { recursive: true, force: true });
  const clone = await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', url, temp], {
    timeoutMs: 180_000,
  });
  if (!clone.ok) throw new Error(truncate(clone.stderr || 'git clone 失败', 300));
  const tree = await run('git', ['-C', temp, 'ls-tree', '-r', '--name-only', 'HEAD'], { timeoutMs: 60_000 });
  if (!tree.ok) throw new Error(truncate(tree.stderr || 'git ls-tree 失败', 300));
  const candidates = tree.stdout
    .split('\n')
    .filter((line) => line.endsWith('/SKILL.md') || line === 'SKILL.md')
    .map((line) => (line === 'SKILL.md' ? '.' : line.slice(0, -'/SKILL.md'.length)));
  const exact = candidates.find((dir) => dir.split('/').pop() === String(skillId));
  const loose = candidates.find((dir) => dir.endsWith(`/${skillId}`));
  const only = candidates.length === 1 ? candidates[0] : null;
  const dir = exact ?? loose ?? only;
  if (!dir) return null;
  await run('git', ['-C', temp, 'sparse-checkout', 'init', '--no-cone'], { timeoutMs: 30_000 });
  const checkout = await run('git', ['-C', temp, 'sparse-checkout', 'set', dir], { timeoutMs: 30_000 });
  if (!checkout.ok) throw new Error(truncate(checkout.stderr || 'sparse-checkout 失败', 300));
  const materialize = await run('git', ['-C', temp, 'checkout', '--quiet', 'HEAD'], { timeoutMs: 120_000 });
  if (!materialize.ok) throw new Error(truncate(materialize.stderr || 'git checkout 失败', 300));
  return { path: join(temp, dir), dir };
}

/**
 * 用 git 稀疏克隆拿上游技能目录，避开 GitHub API 限流。
 * @returns {Promise<string>} 克隆里该目录的绝对路径
 */
export async function cloneSkillDir(repo, dir, workDir) {
  const url = `https://github.com/${repo}.git`;
  const temp = join(workDir, 'repo');
  await rm(temp, { recursive: true, force: true });
  const sparse = await run(
    'git',
    ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--quiet', url, temp],
    { timeoutMs: 240_000 },
  );
  if (!sparse.ok) {
    await rm(temp, { recursive: true, force: true });
    const plain = await run('git', ['clone', '--depth', '1', '--quiet', url, temp], { timeoutMs: 240_000 });
    if (!plain.ok) throw new Error(truncate(plain.stderr || sparse.stderr || 'git clone 失败', 300));
  } else {
    const cone = await run('git', ['-C', temp, 'sparse-checkout', 'set', '--no-cone', dir], { timeoutMs: 60_000 });
    if (!cone.ok) throw new Error(truncate(cone.stderr || 'sparse-checkout 失败', 300));
  }
  return join(temp, dir);
}

export async function resolvePnpm(config = {}, env = process.env) {
  if (config.pnpmCommand) return { command: config.pnpmCommand, prefixArgs: [] };
  const onPath = await which(['pnpm'], { env });
  if (onPath) return { command: onPath, prefixArgs: [] };
  const node = bundledNodeCandidates(env)[0];
  const pnpmCjs = bundledPnpmCandidates(env)[0];
  if (node && pnpmCjs) return { command: node, prefixArgs: [pnpmCjs] };
  return null;
}

export async function resolveSkillshare(config = {}, env = process.env) {
  if (config.skillshareCommand) return config.skillshareCommand;
  const home = env.HOME || process.env.HOME || '';
  return which(
    ['skillshare', home ? join(home, 'bin', 'skillshare') : null, home ? join(home, '.local', 'bin', 'skillshare') : null],
    { env },
  );
}

async function swapIn(skill, download, backupRoot) {
  const stamp = isoNow().replace(/[:.]/g, '-');
  const backupDir = join(backupRoot, stamp);
  // 技能可能是软链接（skillshare sync 之后就是），要改真实目标而不是把链接换掉
  const target = await realpath(skill.path).catch(() => skill.path);
  const temp = `${target}.sync-new`;
  await rm(temp, { recursive: true, force: true });
  try {
    await download(temp);
    const { stat } = await import('node:fs/promises');
    const valid = await stat(target.endsWith('.md') ? temp : join(temp, 'SKILL.md')).then((info) => info.size > 0, () => false);
    if (!valid) throw new Error('下载内容不完整（缺少 SKILL.md），已放弃替换');
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, skill.name);
    await cp(target, backupPath, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
    return { backupPath };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 更新单个技能。
 * @param {object} skill scanSkills() 的一条
 * @param {object} source resolveSkillSource() 的结果
 */
export async function applySkill(skill, source, options = {}) {
  const env = options.env ?? process.env;
  const backupRoot = options.backupRoot ?? join(env.DSH_HOME || '', 'sync-updater', 'backups');
  const result = {
    name: skill.name,
    path: skill.path,
    source: source.kind,
    applied: false,
    method: null,
    backup: null,
    detail: '',
    restartRequired: false,
  };

  if (source.kind === 'git') {
    const root = source.root ?? (await gitRootOf(skill.path));
    const pull = await run('git', ['-C', root, 'pull', '--ff-only'], { timeoutMs: 120_000, env });
    result.applied = pull.ok;
    result.method = 'git-pull';
    result.detail = pull.ok ? truncate(pull.stdout || 'git pull 完成', 300) : truncate(pull.stderr || 'git pull 失败', 300);
    return result;
  }

  if (source.kind === 'lock') {
    const workDir = join(tmpdir(), `dsh-sync-${process.pid}-${Date.now()}`);
    try {
      if (source.isDir === false) {
        // 扁平 <name>.md 技能：直接取 raw 文件
        const raw = `https://raw.githubusercontent.com/${source.repo}/HEAD/${source.skillPath}`;
        const { backupPath } = await swapIn(
          skill,
          (temp) => downloadFile(raw, temp),
          backupRoot,
        );
        result.backup = backupPath;
      } else {
        const { backupPath } = await swapIn(
          skill,
          async (temp) => {
            let dirPath;
            try {
              dirPath = await cloneSkillDir(source.repo, source.dir, workDir);
            } catch {
              await mkdir(temp, { recursive: true });
              await downloadSkillTree(source.repo, source.dir, temp);
              return;
            }
            const { stat } = await import('node:fs/promises');
            const info = await stat(dirPath);
            if (!info.isDirectory()) throw new Error(`上游没有目录 ${source.dir}`);
            await mkdir(temp, { recursive: true });
            await cp(dirPath, temp, { recursive: true, force: true });
          },
          backupRoot,
        );
        result.backup = backupPath;
      }
      result.applied = true;
      result.method = source.isDir === false ? 'raw-download' : 'git-sparse';
      result.detail = '.skill-lock.json 未改动（哈希仍由 skills CLI 维护）';
    } catch (error) {
      result.detail = truncate(error && error.message ? error.message : error, 300);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    return result;
  }

  if (source.kind === 'none' || source.kind === 'skillshare') {
    const skillshare = await resolveSkillshare(options.config ?? {}, env);
    if (skillshare) {
      const update = await run(skillshare, ['update', skill.name, '-g'], { timeoutMs: 300_000, env });
      if (update.ok) {
        const sync = await run(skillshare, ['sync', '-g', '-q'], { timeoutMs: 240_000, env });
        result.applied = true;
        result.method = 'skillshare';
        result.detail = sync.ok
          ? 'skillshare update + sync 完成'
          : `skillshare update 完成，但 sync 失败：${truncate(sync.stderr, 200)}`;
        return result;
      }
      result.detail = truncate(update.stderr || update.stdout || 'skillshare update 失败', 300);
      return result;
    }
    result.detail = '没有可用的上游来源，也没有 skillshare CLI；只能手动更新';
    return result;
  }

  result.detail = `不支持的来源类型 ${source.kind}`;
  return result;
}

/** 更新单个插件（在 profile 里 pnpm add）。 */
export async function applyPlugin(pkg, options = {}) {
  const env = options.env ?? process.env;
  const profileDir = options.profileDir;
  const result = { name: pkg.name, installed: pkg.installed ?? null, applied: false, method: 'pnpm', detail: '', restartRequired: true };
  const pnpm = await resolvePnpm(options.config ?? {}, env);
  if (!pnpm) {
    result.detail = '找不到 pnpm（PATH 和 DSH 运行时里都没有）';
    return result;
  }
  // 明确锁定要装的版本：只写 range 时 pnpm 会保留锁文件里的旧版本，等于没升
  let target = pkg.spec || 'latest';
  if (options.toLatest) {
    target = 'latest';
  } else if (pkg.latest) {
    target = pkg.latest;
  } else {
    const looked = await latestVersion(pkg.name, { registry: options.config?.registry });
    if (looked.version && satisfiesRange(looked.version, pkg.spec) !== false) target = looked.version;
  }
  const spec = `${pkg.name}@${target}`;
  const manifestFile = join(profileDir, 'package.json');
  const lockFile = join(profileDir, 'pnpm-lock.yaml');
  const manifestBefore = await readFile(manifestFile, 'utf8').catch(() => null);
  const lockBefore = await readFile(lockFile, 'utf8').catch(() => null);
  const install = await run(pnpm.command, [...pnpm.prefixArgs, 'add', spec, '--dir', profileDir], {
    timeoutMs: options.timeoutMs ?? 600_000,
    env,
  });
  if (!install.ok) {
    if (manifestBefore !== null) await writeFile(manifestFile, manifestBefore).catch(() => {});
    if (lockBefore !== null) await writeFile(lockFile, lockBefore).catch(() => {});
    result.detail = truncate(install.stderr || install.stdout || 'pnpm add 失败', 400);
    return result;
  }
  result.installedAfter = await readInstalledVersion(profileDir, pkg.name);
  result.changed = result.installedAfter !== result.installed;
  result.applied = result.changed;
  result.detail = result.changed
    ? `已升级 ${pkg.name} ${result.installed ?? '?'} → ${result.installedAfter ?? '?'}`
    : `${pkg.name} 已是目标版本 ${result.installedAfter ?? '?'}，未变化`;
  return result;
}

async function readInstalledVersion(profileDir, name) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'));
    return manifest.version ?? null;
  } catch {
    return null;
  }
}
