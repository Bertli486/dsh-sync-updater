import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

/** 简易 res：收集 status / headers / body。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      this.body += chunk ?? '';
    },
  };
}

function fakeReq(method, body) {
  if (body === undefined) return { method };
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method });
}

test('http api: /state, /settings, /check shape', async () => {
  // 隔离到临时 DSH_HOME，避免写真实的 ~/.dsh/sync-updater/settings.json
  const home = await mkdtemp(join(tmpdir(), 'sync-http-'));
  const profile = join(home, 'profiles', 'desktop');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: { 'fixture-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['fixture-plugin'] } },
    }, null, 2),
  );
  await mkdir(join(profile, 'node_modules', 'fixture-plugin'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', 'fixture-plugin', 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }),
  );

  const previousHome = process.env.DSH_HOME;
  const previousProfileDir = process.env.DSH_PROFILE_DIR;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profile;

  try {
    const module = await import('../lib/index.js');
    const routes = new Map();
    const ctx = {
      tools: { register: () => {} },
      effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
      get: () => undefined,
      // 模拟 Cordis：服务就绪后才跑回调
      inject: (_deps, callback) => callback({
        effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
        webServer: { register: (route) => routes.set(route.path, route.handler) },
      }),
    };
    module.apply(ctx, { autoCheckIntervalMinutes: 0 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      [...routes.keys()].sort(),
      [
        '/sync-updater/api/apply',
        '/sync-updater/api/audit',
        '/sync-updater/api/check',
        '/sync-updater/api/discover',
        '/sync-updater/api/install',
        '/sync-updater/api/settings',
        '/sync-updater/api/state',
      ],
    );

    const stateRes = fakeRes();
    await routes.get('/sync-updater/api/state')(fakeReq('GET'), stateRes);
    assert.equal(stateRes.status, 200);
    const state = JSON.parse(stateRes.body);
    assert.equal(typeof state.settings.autoCheckIntervalMinutes, 'number');
    assert.ok(Array.isArray(state.plugins));
    assert.ok(Array.isArray(state.skills));
    assert.ok(state.plugins.some((item) => item.name === 'fixture-plugin'));

    const settingsRes = fakeRes();
    await routes.get('/sync-updater/api/settings')(fakeReq('POST', { autoApplySkills: true, autoCheckIntervalMinutes: 30 }), settingsRes);
    assert.equal(settingsRes.status, 200);
    const saved = JSON.parse(settingsRes.body);
    assert.equal(saved.settings.autoApplySkills, true);
    assert.equal(saved.settings.autoCheckIntervalMinutes, 30);

    const badRes = fakeRes();
    await routes.get('/sync-updater/api/settings')(fakeReq('POST', { autoCheckIntervalMinutes: -5 }), badRes);
    assert.equal(badRes.status, 400);

    const wrongMethod = fakeRes();
    await routes.get('/sync-updater/api/state')(fakeReq('POST'), wrongMethod);
    assert.equal(wrongMethod.status, 405);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previousProfileDir;
    await rm(home, { recursive: true, force: true });
  }
});
