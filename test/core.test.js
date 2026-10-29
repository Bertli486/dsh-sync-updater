import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  parseFrontmatter,
  satisfiesRange,
} from '../lib/core/util.js';
import { readProfile, scanSkills, skillRoots } from '../lib/core/inventory.js';
import { resolveSkillSource } from '../lib/core/check.js';
import { applySkill } from '../lib/core/apply.js';

test('semver: compare', () => {
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('oops', '1.0.0'), null);
});

test('semver: ranges', () => {
  assert.equal(satisfiesRange('0.3.11', '^0.3.10'), true);
  assert.equal(satisfiesRange('0.4.0', '^0.3.10'), false);
  assert.equal(satisfiesRange('1.9.0', '^1.2.3'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false);
  assert.equal(satisfiesRange('0.3.10', '~0.3.10'), true);
  assert.equal(satisfiesRange('0.3.11', '~0.3.10'), true);
  assert.equal(satisfiesRange('0.4.0', '~0.3.10'), false);
  assert.equal(satisfiesRange('1.2.9', '1.2.*'), true);
  assert.equal(satisfiesRange('1.3.0', '1.2.*'), false);
  assert.equal(satisfiesRange('9.9.9', '*'), true);
  assert.equal(satisfiesRange('2.0.0', '>=1.5.0'), true);
  assert.equal(satisfiesRange('2.0.0', 'nonsense'), null);
});

test('frontmatter', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: "hello: world"\n---\n# body\n');
  assert.equal(parsed.name, 'demo');
  assert.equal(parsed.description, 'hello: world');
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {});
});

test('scanSkills: dir bundle + flat file, dedupe by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sync-scan-'));
  try {
    await mkdir(join(root, 'alpha'), { recursive: true });
    await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: first\n---\n');
    await writeFile(join(root, 'beta.md'), '---\nname: beta\ndescription: flat\n---\n');
    await mkdir(join(root, 'gamma'), { recursive: true });
    await writeFile(join(root, 'gamma', 'README.md'), 'no skill here');
    const scanned = await scanSkills({ roots: [root], includeProject: false, includeUser: false, extraRoots: [{ source: 'fixture', path: root, rank: 1 }] });
    assert.equal(scanned.skills.length, 2);
    assert.deepEqual(scanned.skills.map((skill) => skill.name), ['alpha', 'beta']);
    assert.equal(scanned.skills[0].provider, 'fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skillRoots: project + user ordering', () => {
  const roots = skillRoots({ cwd: '/tmp/project', env: { DSH_HOME: '/tmp/home', DSH_AGENTS_HOME: '/tmp/agents' } });
  assert.deepEqual(roots.map((root) => root.source), ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']);
  const minimal = skillRoots({ cwd: '/tmp/project', env: {}, includeProject: false, includeUser: false });
  assert.equal(minimal.length, 0);
});

test('readProfile: bundled shipped packages and specs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-profile-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: { '@deepseek-ai/dsh-base': '0.2.1', 'demo-plugin': '^0.3.10', 'local-plugin': 'link:/tmp/local' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
    }, null, 2));
    await mkdir(join(dir, 'node_modules', 'demo-plugin'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.3.10' }));
    const profile = await readProfile({ profileDir: dir, env: {} });
    const shipped = profile.packages.find((pkg) => pkg.name === '@deepseek-ai/dsh-base');
    assert.equal(shipped.shipped, true);
    const demo = profile.packages.find((pkg) => pkg.name === 'demo-plugin');
    assert.equal(demo.installed, '0.3.10');
    assert.equal(demo.origin, 'registry');
    assert.equal(demo.bundled, true);
    const local = profile.packages.find((pkg) => pkg.name === 'local-plugin');
    assert.equal(local.origin, 'local-link');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSkillSource: lock entry wins, git fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-source-'));
  try {
    await mkdir(join(dir, 'skills', 'gamma'), { recursive: true });
    await writeFile(join(dir, 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n');
    const lock = { skills: { gamma: { source: 'owner/repo', sourceType: 'github', skillPath: 'skills/gamma/SKILL.md' } } };
    const fromLock = await resolveSkillSource({ name: 'gamma', path: join(dir, 'skills', 'gamma') }, lock);
    assert.equal(fromLock.kind, 'lock');
    assert.equal(fromLock.repo, 'owner/repo');
    assert.equal(fromLock.dir, 'skills/gamma');
    const none = await resolveSkillSource({ name: 'delta', path: join(dir, 'nowhere') }, null);
    assert.equal(none.kind, 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applySkill: git pull fast-forward', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sync-git-'));
  try {
    const origin = join(base, 'origin');
    const clone = join(base, 'clone');
    await mkdir(origin, { recursive: true });
    const git = (args, cwd) => import('node:child_process').then(({ execFileSync }) => execFileSync('git', args, { cwd, stdio: 'pipe' }));
    await git(['init', '-q', '-b', 'main'], origin);
    await git(['config', 'user.email', 'test@example.com'], origin);
    await git(['config', 'user.name', 'test'], origin);
    await writeFile(join(origin, 'SKILL.md'), '---\nname: alpha\nversion: 1\n---\n');
    await git(['add', '.'], origin);
    await git(['commit', '-qm', 'one'], origin);
    await git(['clone', '-q', origin, clone], base);
    await writeFile(join(origin, 'SKILL.md'), '---\nname: alpha\nversion: 2\n---\n');
    await git(['commit', '-qam', 'two'], origin);
    const outcome = await applySkill(
      { name: 'alpha', path: clone },
      { kind: 'git', root: clone },
      { backupRoot: join(base, 'backups') },
    );
    assert.equal(outcome.applied, true, outcome.detail);
    const text = await readFile(join(clone, 'SKILL.md'), 'utf8');
    assert.match(text, /version: 2/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('plugin tools: registers three tools and answers sync_status', async () => {
  const module = await import('../lib/index.js');
  const registered = new Map();
  const ctx = {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    effect: () => () => {},
    get: () => undefined,
    inject: () => undefined,
  };
  module.apply(ctx, { autoCheckIntervalMinutes: 0 });
  assert.deepEqual([...registered.keys()].sort(), ['sync_apply', 'sync_check', 'sync_status']);
  const statusTool = registered.get('sync_status');
  assert.equal(statusTool.parameters.type, 'object');
  const value = await statusTool.execute({}, {});
  assert.equal(typeof value, 'object');
  assert.ok(Array.isArray(value.plugins));
  assert.ok(Array.isArray(value.skills));
  assert.ok(value.auto);
  const rendered = statusTool.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
});
