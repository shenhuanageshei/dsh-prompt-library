/**
 * Guard: Remote endpoint methods must never use private class members.
 *
 * The host gateway invokes a Remote endpoint with the cordis service PROXY as
 * `this` (@deepseek-ai/dsh-api-gateway/lib/index.js:1211-1213, :921). A
 * private method such as `#snapshot` then fails V8's private-name brand check
 * and throws "Receiver must be an instance of class ..." — reproduced against
 * the real gateway on DSH 0.2.1-rc.3. Keep endpoint helpers public.
 *
 * The guard reads the source of truth (`src/host/service.ts`): the same text
 * compiles into lib/host/service.js, and the source is what the next edit to a
 * Remote endpoint would touch first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('host service: Remote endpoints never use private members (cordis Proxy receiver)', async () => {
  const source = await readFile(join(ROOT, 'src', 'host', 'service.ts'), 'utf8');
  assert.doesNotMatch(source, /this\.#/u, 'a Remote endpoint calls a private member; the gateway Proxy receiver will throw a brand-check TypeError');
  assert.doesNotMatch(source, /^\s*#[A-Za-z_$]/mu, 'the host service declares a private member; endpoint helpers must be public');
});
