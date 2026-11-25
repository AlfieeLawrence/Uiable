'use strict';
// App store on/off switch: default on for existing installs, admin-only toggle,
// and the store API is blocked server-side while it is off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./_server');

test('auth.features(): missing keys fall back to defaults (store on for existing installs)', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-feat-'));
  // An "existing install": config without any features block
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ users: [], settings: { theme: 'dark' } }));
  const code = `process.env.UIABLE_DATA_DIR=${JSON.stringify(data)}; const a=require('./server/auth'); const f=a.features(); a.setFeatures({store:false, bogus:true, x:'no'}); const g=a.features(); a.setFeatures({store:'yes'}); console.log(JSON.stringify({f,g,h:a.features(),def:a.FEATURE_DEFAULTS}));`;
  const out = require('child_process').execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.f.store, true);
  assert.equal(r.def.store, true);
  assert.deepEqual(r.g, { store: false });
  assert.equal(r.h.store, false, 'non-boolean values are ignored');
});

test('routes: store gate, admin-only PUT /features, /state carries features', async (t) => {
  const srv = await startServer(t);
  const admin = srv.client();
  assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'adminpass1' })).status, 200);

  let r = await admin('GET', '/state');
  assert.deepEqual(r.data.features, { store: true });
  r = await admin('GET', '/features');
  assert.equal(r.status, 200); assert.equal(r.data.store, true);

  // Store reachable while on (anything but the feature-off 404)
  r = await admin('GET', '/apps/catalog');
  assert.notEqual(r.data && r.data.reason, 'feature-off');

  // Viewers cannot toggle
  assert.equal((await admin('POST', '/accounts', { username: 'viewer1', password: 'viewerpass1', role: 'viewer' })).status, 200);
  const viewer = srv.client();
  assert.equal((await viewer('POST', '/login', { username: 'viewer1', password: 'viewerpass1' })).status, 200);
  assert.equal((await viewer('PUT', '/features', { store: false })).status, 403);

  // Turn it off: every /api/apps route is blocked server-side
  r = await admin('PUT', '/features', { store: false });
  assert.equal(r.status, 200); assert.equal(r.data.store, false);
  for (const [m, u] of [['GET', '/apps/catalog'], ['GET', '/apps/installed'], ['POST', '/apps/install'], ['GET', '/apps/anything/else']]) {
    r = await admin(m, u, m === 'POST' ? { id: 'x' } : undefined);
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.equal(r.data.reason, 'feature-off'); assert.equal(r.data.feature, 'store');
    assert.match(r.data.error, /Settings/);
  }
  assert.deepEqual((await viewer('GET', '/state')).data.features, { store: false });

  // Audit records the change
  r = await admin('GET', '/audit?limit=50');
  const entries = (r.data && (r.data.entries || r.data.items || r.data)) || [];
  assert.ok(JSON.stringify(entries).includes('settings.features'));

  // Back on
  r = await admin('PUT', '/features', { store: true });
  assert.equal(r.data.store, true);
  r = await admin('GET', '/apps/catalog');
  assert.notEqual(r.data && r.data.reason, 'feature-off');
});
