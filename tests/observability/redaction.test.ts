import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestCommand, redactText, redactValue } from '../../src/observability/redaction';

test('redactText removes bearer and inline secrets', () => {
  const result = redactText('Authorization: Bearer abc.def token=hello safe=value');
  assert.equal(result.value.includes('abc.def'), false);
  assert.equal(result.value.includes('hello'), false);
  assert.match(result.value, /<REDACTED>/);
});

test('redactText removes credential keys, complete quoted values, and URI userinfo', () => {
  const secrets = [
    'CREDENTIAL_SECRET',
    'CREDENTIALS_SECRET',
    'MULTI WORD SECRET',
    'QUOTED TOKEN SECRET',
    'dbuser',
    'DB_SECRET',
    'POSTGRES_SECRET',
    'MONGO_SECRET',
    'REDIS_SECRET',
    'HERMES_SECRET',
    'OPENAI_SECRET',
    'ANTHROPIC_SECRET',
  ];
  const result = redactText([
    'credential=CREDENTIAL_SECRET',
    'credentials=CREDENTIALS_SECRET',
    'password="MULTI WORD SECRET"',
    "token='QUOTED TOKEN SECRET'",
    'DATABASE_URL=postgres://dbuser:DB_SECRET@host/db',
    'POSTGRES_URL=postgres://dbuser:POSTGRES_SECRET@host/db',
    'MONGO_URI=mongodb://mongo:MONGO_SECRET@host/db',
    'REDIS_URL=redis://:REDIS_SECRET@host',
    'HERMES_BRIDGE_TOKEN=HERMES_SECRET',
    'OPENAI_API_KEY=OPENAI_SECRET',
    'ANTHROPIC_API_KEY=ANTHROPIC_SECRET',
  ].join(' '));

  for (const secret of secrets) assert.equal(result.value.includes(secret), false, secret);
  assert.doesNotMatch(result.value, /mongodb:\/\/mongo:/);
  assert.match(result.value, /postgres:\/\/<REDACTED>@host\/db/);
  assert.match(result.value, /mongodb:\/\/<REDACTED>@host\/db/);
  assert.match(result.value, /redis:\/\/<REDACTED>@host/);
});

test('redactValue is recursive and does not mutate input', () => {
  const input = { nested: { apiKey: 'secret-value', safe: 'ok' } };
  const result = redactValue(input);
  assert.equal(result.value.nested.apiKey, '<REDACTED>');
  assert.equal(result.value.nested.safe, 'ok');
  assert.equal(input.nested.apiKey, 'secret-value');
});

test('command digest is stable without retaining command content', () => {
  const first = digestCommand('git status --short');
  const second = digestCommand('git status --short');
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes('git status'), false);
});
