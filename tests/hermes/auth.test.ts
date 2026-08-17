import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { createBridgeAuthenticator } from '../../src/hermes';

function req(authorization?: string): Request {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as Request;
}

test('no dedicated token (undefined) fails closed with 503 service unavailable', () => {
  const auth = createBridgeAuthenticator({ token: undefined });
  assert.deepEqual(auth.authenticate(req('Bearer anything')), { ok: false, status: 503 });
});

test('a blank token fails closed with 503', () => {
  const auth = createBridgeAuthenticator({ token: '   ' });
  assert.deepEqual(auth.authenticate(req('Bearer    ')), { ok: false, status: 503 });
});

test('a correct Bearer token is accepted', () => {
  const auth = createBridgeAuthenticator({ token: 'secret-bridge-token' });
  assert.deepEqual(auth.authenticate(req('Bearer secret-bridge-token')), { ok: true });
});

test('a wrong token is rejected with 401', () => {
  const auth = createBridgeAuthenticator({ token: 'secret-bridge-token' });
  assert.deepEqual(auth.authenticate(req('Bearer wrong-token')), { ok: false, status: 401 });
});

test('a missing Authorization header is rejected with 401 (query-string is never consulted)', () => {
  const auth = createBridgeAuthenticator({ token: 'secret-bridge-token' });
  assert.deepEqual(auth.authenticate(req(undefined)), { ok: false, status: 401 });
});

test('a non-Bearer Authorization scheme is rejected with 401', () => {
  const auth = createBridgeAuthenticator({ token: 'secret-bridge-token' });
  assert.deepEqual(auth.authenticate(req('Basic c2VjcmV0')), { ok: false, status: 401 });
});

test('a Bearer header with an empty token is rejected with 401', () => {
  const auth = createBridgeAuthenticator({ token: 'secret-bridge-token' });
  assert.deepEqual(auth.authenticate(req('Bearer ')), { ok: false, status: 401 });
  assert.deepEqual(auth.authenticate(req('Bearer')), { ok: false, status: 401 });
});

test('tokens of different lengths are still compared in constant time (no length leak observable as distinct status)', () => {
  const auth = createBridgeAuthenticator({ token: 'short' });
  const decisions = [
    auth.authenticate(req('Bearer a')),
    auth.authenticate(req('Bearer a-very-long-token-that-definitely-does-not-match')),
    auth.authenticate(req('Bearer short')),
  ];
  // Every non-matching token yields the same 401 regardless of length.
  assert.deepEqual(decisions[0], { ok: false, status: 401 });
  assert.deepEqual(decisions[1], { ok: false, status: 401 });
  assert.deepEqual(decisions[2], { ok: true });
});

test('the authenticator is stateless and repeatable', () => {
  const auth = createBridgeAuthenticator({ token: 'token' });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(auth.authenticate(req('Bearer token')), { ok: true });
    assert.deepEqual(auth.authenticate(req('Bearer nope')), { ok: false, status: 401 });
  }
});
