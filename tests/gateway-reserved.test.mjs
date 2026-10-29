/**
 * Wire-method / reserved-namespace guard (sixth eng_coder round).
 *
 * WHY THIS FILE EXISTS
 * The real GUI rejected the client half of this plugin with
 *
 *   client api: method "promptLibrary/remove" conflicts with its namespace service
 *
 * so ctx.remote.$mount() threw, the namespace never registered, and every
 * call answered "the promptLibrary Remote is not mounted" while the host half
 * stayed healthy (see .artifacts/dsh-prompt-library-audit/rpc-root-cause.md).
 *
 * PLATFORM PREDICATE (as-of citation, DSH 0.2.1-rc.3)
 *   @deepseek-ai/dsh-api-gateway/lib/client.browser.js:1957-1958
 *     static assertMethodAvailable(namespace, method) {
 *       if (REMOTE_NAMESPACE_FIELDS.has(method) ||
 *           method in RemoteNamespaceService.prototype) throw new Error(...)
 *     }
 *   :2012  remove(kind, method, token) is one member of that prototype.
 *   :2066-2073 REMOTE_NAMESPACE_FIELDS = ctx, empty, invokeRemote, methods,
 *             name, namespace.
 *   mountContribution() calls validateContribution() BEFORE
 *   typert.remotes.register() (:1696-1698 -> :1718-1743), so ONE colliding
 *   method rejects the WHOLE contribution.
 *
 * WHAT THIS FILE GUARDS
 *   1. The pinned reserved set below is the platform set.
 *   2. Every contract.INVOCATIONS[].method must stay outside that set.
 *   3. The guard provably catches the pre-fix wire method "remove" (the
 *      rename target is "removePrompt"); this is the regression proof.
 *   4. Optional real-client cross-check: when DSH_API_GATEWAY_CLIENT points at
 *      the shipped @deepseek-ai/dsh-api-gateway/lib/client.browser.js (or a
 *      temporary copy), the test derives the reserved set from that exact
 *      source and asserts it equals the pinned set. It is skipped otherwise,
 *      because this plugin repo is dependency-free (README W1) and must not
 *      depend on a DSH install.
 *
 * A full mount against the extracted bundle is not asserted here on purpose:
 * the mount needs the live cordis gateway plus its connection / typert
 * services, which a dependency-free node:test process cannot host. The
 * source-derived set is the same predicate input the platform checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadZod } from './_zod.mjs';
import { defineContract } from '../lib/contract.js';

const z = await loadZod();
const contract = defineContract(z);

/**
 * The client gateway reserved Remote-namespace names, pinned as of
 * 0.2.1-rc.3 (see the header for the exact source lines).
 *
 * REMOTE_NAMESPACE_FIELDS (ctx, empty, invokeRemote, methods, name,
 * namespace) UNION the RemoteNamespaceService.prototype members reached by
 * "method in ..." (constructor, assertMethodAvailable, empty, has,
 * installDirect, installScoped, install, remove).
 */
const RESERVED_NAMESPACE_METHODS = Object.freeze([
  'ctx',
  'empty',
  'invokeRemote',
  'methods',
  'name',
  'namespace',
  'constructor',
  'assertMethodAvailable',
  'has',
  'installDirect',
  'installScoped',
  'install',
  'remove'
]);

/**
 * Every wire method that the platform would refuse for a Remote namespace.
 * @param {readonly string[]} methods - candidate wire method names.
 * @returns {string[]} the colliding names, in input order.
 */
function reservedCollisions(methods) {
  return methods.filter((method) => RESERVED_NAMESPACE_METHODS.includes(method));
}

/**
 * Read REMOTE_NAMESPACE_FIELDS out of the shipped client bundle.
 * @param {string} source - client.browser.js text.
 * @returns {string[]} the declared field names.
 */
function namespaceFieldsFrom(source) {
  const match = /const REMOTE_NAMESPACE_FIELDS = new Set\(\[([\s\S]*?)\]\);/u.exec(source);
  assert.ok(match !== null, 'the gateway client must declare REMOTE_NAMESPACE_FIELDS');
  const names = [...match[1].matchAll(/"([A-Za-z_$][\w$]*)"/gu)].map((entry) => entry[1]);
  assert.ok(names.length > 0, 'REMOTE_NAMESPACE_FIELDS must list at least one name');
  return names;
}

/**
 * Read the RemoteNamespaceService.prototype member names out of the shipped
 * client bundle. Members sit at three tabs inside the class body; method
 * bodies are deeper, so the indentation anchor keeps "if ("/"for (" out.
 * @param {string} source - client.browser.js text.
 * @returns {string[]} the prototype member names.
 */
function prototypeMembersFrom(source) {
  const start = source.indexOf('var RemoteNamespaceService = class');
  assert.ok(start >= 0, 'the gateway client must declare the RemoteNamespaceService class');
  const bodyStart = source.indexOf('{', start);
  const bodyEnd = source.indexOf('\n\t\t};', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'the RemoteNamespaceService class body must be delimited');
  const body = source.slice(bodyStart, bodyEnd);
  const names = ['constructor'];
  for (const line of body.split('\n')) {
    const member = /^\t{3}(?:static\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*\(/u.exec(line);
    if (member !== null) names.push(member[1]);
  }
  return [...new Set(names)];
}

test('gateway: the pinned reserved set is the platform namespace member set', () => {
  assert.equal(RESERVED_NAMESPACE_METHODS.length, 13);
  assert.equal(new Set(RESERVED_NAMESPACE_METHODS).size, 13, 'the pinned set must not repeat a name');
  assert.deepEqual([...RESERVED_NAMESPACE_METHODS].sort(), [
    'assertMethodAvailable',
    'constructor',
    'ctx',
    'empty',
    'has',
    'install',
    'installDirect',
    'installScoped',
    'invokeRemote',
    'methods',
    'name',
    'namespace',
    'remove'
  ]);
  assert.equal(RESERVED_NAMESPACE_METHODS.includes('remove'), true, 'the pre-fix wire method is reserved');
  assert.equal(RESERVED_NAMESPACE_METHODS.includes('removePrompt'), false, 'the post-fix wire method is free');
});

test('gateway: no promptLibrary wire method collides with the reserved namespace set', () => {
  assert.equal(contract.INVOCATIONS.length, 8);
  const methods = contract.INVOCATIONS.map((entry) => entry.method);
  assert.equal(new Set(methods).size, methods.length, 'wire method names must be unique');
  for (const entry of contract.INVOCATIONS) {
    assert.equal(entry.namespace, 'promptLibrary');
    assert.equal(
      RESERVED_NAMESPACE_METHODS.includes(entry.method),
      false,
      'wire method "promptLibrary/' + entry.method + '" collides with a RemoteNamespaceService member; ' +
        '$mount would be rejected and the whole Remote would stay unmounted'
    );
  }
  assert.deepEqual(reservedCollisions(methods), []);
});

test('gateway: the guard rejects the pre-fix wire method remove and accepts removePrompt', () => {
  const methods = contract.INVOCATIONS.map((entry) => entry.method);
  // Reconstruct the pre-fix descriptor set: exactly the contract that shipped
  // before this round (the only difference is removePrompt/<->remove).
  const preFix = methods.map((method) => (method === 'removePrompt' ? 'remove' : method));
  assert.deepEqual(preFix, [
    'list',
    'save',
    'remove',
    'importLibrary',
    'layers',
    'addLayer',
    'removeLayer',
    'clearLayers'
  ]);
  assert.deepEqual(reservedCollisions(preFix), ['remove'], 'the guard must catch the old wire method');
  assert.deepEqual(reservedCollisions(methods), [], 'the fixed wire methods must all pass');
  assert.deepEqual(reservedCollisions(['removePrompt']), []);
  assert.equal(RESERVED_NAMESPACE_METHODS.includes('removePrompt'), false);
});

test('gateway: the shipped gateway client reserves exactly the pinned names', async (t) => {
  const bundlePath = process.env.DSH_API_GATEWAY_CLIENT;
  if (typeof bundlePath !== 'string' || bundlePath.length === 0) {
    t.skip('DSH_API_GATEWAY_CLIENT is not set; the pinned static set above is the guard');
    return;
  }
  const source = await readFile(bundlePath, 'utf8');
  assert.match(source, /conflicts with its namespace service/u, 'the file must be the client API gateway bundle');
  const derived = [...new Set([...namespaceFieldsFrom(source), ...prototypeMembersFrom(source)])].sort();
  assert.deepEqual(derived, [...RESERVED_NAMESPACE_METHODS].sort(), 'the pinned set drifted from the shipped gateway client');
  for (const entry of contract.INVOCATIONS) {
    assert.equal(derived.includes(entry.method), false, 'the shipped gateway client would reject promptLibrary/' + entry.method);
  }
});
