import assert from 'node:assert/strict';
import test from 'node:test';

import { STClient } from '../src/client.js';

function response({ status = 200, json = {}, cookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => cookies },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

test('logs in to a SillyTavern user account before calling protected endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/api/users/login')) {
      return response({ json: { handle: 'ben' }, cookies: ['session=authenticated; Path=/'] });
    }
    if (url.endsWith('/csrf-token')) return response({ json: { token: 'csrf-token' } });
    if (url.endsWith('/api/characters/all')) return response({ json: [] });
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = new STClient({ baseUrl: 'https://tavern.example.test', user: 'ben', password: 'secret' });
    assert.deepEqual(await client.post('/api/characters/all'), []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[0].options.body), { handle: 'ben', password: 'secret' });
  assert.equal(requests[1].options.headers.Cookie, 'session=authenticated');
  assert.equal(requests[2].options.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(requests[2].options.headers.Cookie, 'session=authenticated');
});

test('continues with Basic Auth when no SillyTavern user is configured', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/csrf-token')) return response({ json: { token: 'csrf-token' } });
    if (url.endsWith('/version')) return response({ json: { pkgVersion: '1.0.0' } });
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = new STClient({ baseUrl: 'https://tavern.example.test' });
    assert.deepEqual(await client.get('/version'), { pkgVersion: '1.0.0' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests.some((request) => request.url.endsWith('/api/users/login')), false);
});

test('falls back to Basic Auth when the user-login endpoint rejects credentials', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/api/users/login')) return response({ status: 403 });
    if (url.endsWith('/csrf-token')) return response({ json: { token: 'csrf-token' } });
    if (url.endsWith('/version')) return response({ json: { pkgVersion: '1.0.0' } });
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const client = new STClient({ baseUrl: 'https://tavern.example.test', user: 'basic-user', password: 'secret' });
    assert.deepEqual(await client.get('/version'), { pkgVersion: '1.0.0' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  assert.match(requests[1].options.headers.Authorization, /^Basic /);
  assert.match(requests[2].options.headers.Authorization, /^Basic /);
});