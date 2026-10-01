import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpJevProvider, isLoopbackHost, validateEndpoint } from '../src/provider.js';
import { createProvider } from '../src/runtime.js';

test('isLoopbackHost identifies loopback addresses and rejects remote or spoofed hosts', () => {
  // Accepted loopback hosts
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `expected loopback for ${host}`);
  }

  // Rejected non-loopback hosts
  for (const host of [
    'example.com',
    'api.typesafe.ai',
    'localhost.evil.com',
    '127.0.0.1.attacker.com',
    '192.168.1.1',
    '10.0.0.1',
    '172.16.0.1',
    '128.0.0.1',
    '127.0.0.256',
    '',
  ]) {
    assert.equal(isLoopbackHost(host), false, `expected non-loopback for ${host}`);
  }
});

test('validateEndpoint accepts HTTPS and loopback HTTP endpoints', () => {
  const accepted = [
    'https://api.typesafe.ai/v1/systemone',
    'https://custom.typesafe.endpoint/v1',
    'https://internal.service.corp:8443/systemone',
    'http://localhost:8080/v1/systemone',
    'http://localhost/v1',
    'http://127.0.0.1:8787/v1/systemone',
    'http://127.0.0.2:9000/v1',
    'http://[::1]:8080/v1/systemone',
  ];

  for (const endpoint of accepted) {
    assert.equal(validateEndpoint(endpoint), endpoint);
  }
});

test('validateEndpoint rejects cleartext remote HTTP, invalid schemes, and malformed URLs', () => {
  const rejected = [
    'http://api.typesafe.ai/v1/systemone',
    'http://insecure.endpoint.com/v1',
    'http://192.168.1.100:8080/v1',
    'http://10.0.0.1/v1',
    'http://localhost.evil.com/v1',
    'ftp://api.typesafe.ai/v1',
    'file:///tmp/jev',
    'ws://localhost:8080',
    'not-a-valid-url',
    '',
  ];

  for (const endpoint of rejected) {
    assert.throws(
      () => validateEndpoint(endpoint),
      /Insecure Jev endpoint rejected|Invalid Jev endpoint URL/,
      `expected rejection for ${endpoint}`,
    );
  }
});

test('HttpJevProvider validates configured endpoint on construction', () => {
  // Default is valid HTTPS
  const defaultProvider = new HttpJevProvider({ apiKey: 'test-key' });
  assert.equal(defaultProvider.name, 'typesafe');

  // Loopback HTTP is allowed
  const localProvider = new HttpJevProvider({ apiKey: 'test-key', endpoint: 'http://localhost:8787/v1' });
  assert.equal(localProvider.name, 'typesafe');

  // Remote HTTP is rejected
  assert.throws(
    () => new HttpJevProvider({ apiKey: 'test-key', endpoint: 'http://api.typesafe.ai/v1' }),
    /Insecure Jev endpoint rejected/,
  );
});

test('createProvider rejects insecure JEV_API_URL environment variable', () => {
  const origEnv = process.env.JEV_API_URL;
  try {
    process.env.JEV_API_URL = 'http://remote-jev-service.com/v1';
    assert.throws(
      () => createProvider('typesafe', { apiKey: 'mock-key' }),
      /Insecure Jev endpoint rejected/,
    );

    // Loopback HTTP is accepted
    process.env.JEV_API_URL = 'http://127.0.0.1:9090/v1';
    const local = createProvider('typesafe', { apiKey: 'mock-key' });
    assert.equal(local.name, 'typesafe');
  } finally {
    if (origEnv === undefined) {
      delete process.env.JEV_API_URL;
    } else {
      process.env.JEV_API_URL = origEnv;
    }
  }
});
