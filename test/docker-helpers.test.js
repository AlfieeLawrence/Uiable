'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const docker = require('../server/docker');

test('maskEnv hides secret-looking values and URL credentials', () => {
  const r = docker.maskEnv(['PATH=/usr/bin', 'DB_PASSWORD=hunter2', 'API_KEY=abc', 'GITHUB_TOKEN=ghp_x', 'DATABASE_URL=postgres://u:pw@db:5432/x', 'TZ=Europe/London', 'EMPTY=', 'NOEQUALS']);
  const env = Object.fromEntries(r.env.map((e) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }));
  assert.equal(env.PATH, '/usr/bin'); assert.equal(env.TZ, 'Europe/London');
  for (const k of ['DB_PASSWORD', 'API_KEY', 'GITHUB_TOKEN']) { assert.notEqual(env[k], { DB_PASSWORD: 'hunter2', API_KEY: 'abc', GITHUB_TOKEN: 'ghp_x' }[k]); assert.ok(r.masked.includes(k)); }
  assert.ok(!env.DATABASE_URL.includes('pw')); assert.ok(env.DATABASE_URL.includes('db:5432')); assert.ok(r.masked.includes('DATABASE_URL'));
  assert.ok(!JSON.stringify(r).includes('hunter2'));
  assert.ok(!r.masked.includes('PATH'));
});

test('parseImageRef: names, tags, digests, registries; IDs are not pullable', () => {
  assert.ok(docker.parseImageRef('nginx'));
  assert.ok(docker.parseImageRef('ghcr.io/org/app:1.2'));
  assert.ok(docker.parseImageRef('localhost:5000/app'));
  assert.equal(docker.parseImageRef('sha256:' + 'a'.repeat(64)), null);
  assert.equal(docker.parseImageRef('a'.repeat(64)), null);
  assert.equal(docker.parseImageRef(''), null);
});

test('buildCreateSpec keeps settings, first network in create, the rest connected after', () => {
  const insp = {
    Id: 'abcdef1234567890', Name: '/web',
    Config: { Hostname: 'abcdef123456', Image: 'nginx:latest', Env: ['A=1'], Labels: { x: 'y' }, ExposedPorts: { '80/tcp': {} }, Cmd: ['nginx'] },
    HostConfig: { Binds: ['/srv:/usr/share/nginx/html:ro'], PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'frontend' },
    NetworkSettings: { Networks: { frontend: { Aliases: ['web', 'abcdef123456'], IPAMConfig: null }, backend: { Aliases: ['web'] } } },
  };
  const { spec, extraNetworks } = docker.buildCreateSpec(insp, 'nginx:latest');
  assert.equal(spec.Image, 'nginx:latest');
  assert.equal(spec.Hostname, undefined, 'auto hostname (short id) is dropped');
  assert.deepEqual(spec.Env, ['A=1']);
  assert.deepEqual(spec.HostConfig.PortBindings, insp.HostConfig.PortBindings);
  assert.deepEqual(spec.HostConfig.Binds, insp.HostConfig.Binds);
  assert.equal(spec.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.deepEqual(Object.keys(spec.NetworkingConfig.EndpointsConfig), ['frontend']);
  assert.deepEqual(extraNetworks.map((n) => n.name), ['backend']);

  const host = docker.buildCreateSpec(Object.assign({}, insp, { Config: Object.assign({}, insp.Config, { Hostname: 'myhost' }), HostConfig: Object.assign({}, insp.HostConfig, { NetworkMode: 'host' }) }), 'nginx:1');
  assert.equal(host.spec.Hostname, 'myhost');
  assert.equal(host.extraNetworks.length, 0);
  assert.ok(!host.spec.NetworkingConfig || !Object.keys(host.spec.NetworkingConfig.EndpointsConfig || {}).length);
});
