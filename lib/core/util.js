/**
 * 基础工具：路径解析、子进程、HTTP、semver、原子写、日志。
 * 只依赖 node: 内置模块，方便脱离 DSH 单测。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const USER_AGENT = 'dsh-sync-updater/0.1.0';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

export function profileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  const profile = env.DSH_PROFILE;
  return profile ? join(dshHome(env), 'profiles', profile) : join(dshHome(env), 'profiles', 'desktop');
}

export function agentsHome(env = process.env) {
  return env.DSH_AGENTS_HOME || join(homedir(), '.agents');
}

export function stateDir(env = process.env) {
  return join(dshHome(env), 'sync-updater');
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export function exists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/**
 * 运行外部命令，不经过 shell（避免注入），带超时与输出截断。
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, timedOut:boolean, stdout:string, stderr:string, command:string}>}
 */
export function run(command, args = [], options = {}) {
  const { cwd, timeoutMs = 60_000, env, input, maxBytes = 256 * 1024 } = options;
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      resolvePromise({
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: String(error && error.message ? error.message : error),
        command: [command, ...args].join(' '),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        command: [command, ...args].join(' '),
      });
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += String(chunk);
    });
    child.on('error', (error) => {
      stderr += String(error && error.message ? error.message : error);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function fetchJson(url, options = {}) {
  const { timeoutMs = 20_000, headers = {}, method = 'GET' } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      error.status = response.status;
      error.body = text.slice(0, 500);
      throw error;
    }
    return text === '' ? null : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, options = {}) {
  const { timeoutMs = 20_000, headers = {} } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${url}`);
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- semver ------------------------------- */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

/** 返回 -1 / 0 / 1；无法解析时返回 null。 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * 简化 range 判断，覆盖 npm 上最常见的写法：`^1.2.3`、`~1.2.3`、`>=1.2.3`、
 * `1.x`、`1.2.*`、精确版本、`*`/`latest`。无法识别时返回 null（未知）。
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const spec = String(range ?? '').trim();
  if (spec === '' || spec === '*' || spec === 'latest' || spec === 'x') return true;
  if (spec.startsWith('=')) return compareVersions(version, spec.slice(1)) === 0;
  if (/^[~^]/.test(spec)) {
    const base = parseVersion(spec.slice(1));
    if (!base) return null;
    const cmp = compareVersions(version, spec.slice(1));
    if (cmp === null) return null;
    if (spec[0] === '^') {
      if (base.major > 0) return parsed.major === base.major && cmp >= 0;
      if (base.minor > 0) return parsed.major === 0 && parsed.minor === base.minor && cmp >= 0;
      return cmp === 0;
    }
    return parsed.major === base.major && parsed.minor === base.minor && cmp >= 0;
  }
  const operator = /^(>=|<=|>|<)\s*(.+)$/.exec(spec);
  if (operator) {
    const cmp = compareVersions(version, operator[2]);
    if (cmp === null) return null;
    switch (operator[1]) {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      default: return null;
    }
  }
  if (/^[0-9xX*]+(\.[0-9xX*]+){0,2}$/.test(spec)) {
    const parts = spec.replace(/^v/, '').split('.');
    const concrete = parts.filter((part) => !/^[xX*]$/.test(part)).map(Number);
    const actual = [parsed.major, parsed.minor, parsed.patch];
    for (let index = 0; index < concrete.length; index += 1) {
      if (concrete[index] !== actual[index]) return false;
    }
    return true;
  }
  const exact = compareVersions(version, spec);
  return exact === null ? null : exact === 0;
}

/* -------------------------------- misc -------------------------------- */

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function truncate(text, max = 400) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

/** 极简 frontmatter 解析：只取顶层标量 key。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    let value = pair[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('>') || value.startsWith('|')) value = line.slice(line.indexOf(value) + 1).trim();
    result[pair[1]] = value;
  }
  return result;
}

export async function appendLog(file, record) {
  await ensureDir(dirname(file));
  await writeFile(file, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

export { join, resolve, dirname };
