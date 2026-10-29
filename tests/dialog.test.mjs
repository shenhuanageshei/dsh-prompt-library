/**
 * The dialog's pure insert planning (src/client/dialog.ts).
 *
 * The overlay component itself needs a live composer (GUI), but the CAS rule it
 * enforces does not: these tests load the real source file (transpiled from
 * TypeScript and flattened by `tests/_client.mjs`) into a VM context and
 * exercise the helpers it declares.
 *
 * What must hold (audit blockers 1+2):
 *   - a fresh span replaces exactly the `/query` token and keeps both
 *     neighbours verbatim (AC-2, and AC-3 stacking);
 *   - a span whose `draftRev` no longer matches the live draft, or whose
 *     coordinates no longer cover a `/query` token, is REFUSED and carries no
 *     next draft at all (the old code fell back to `setDraft(body)`, which wiped
 *     everything the user had typed);
 *   - with no span at all the body is appended at the draft end;
 *   - a failed layer write is rendered from its CODE, never from the host's
 *     English sentence (audit should-fix 9).
 *
 * NOTE: values that come back from the VM realm are compared field by field —
 * `assert.deepEqual` from `node:assert/strict` rejects cross-realm prototypes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transpileClientModule } from './_client.mjs';

const source = await transpileClientModule('dialog');

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  `${source}\n;globalThis.__dialogHelpers = { planInsert, promptDialogKey, dialogErrorText };`,
  sandbox,
  { filename: 'src/client/dialog.ts' }
);
const { planInsert, promptDialogKey, dialogErrorText } = sandbox.__dialogHelpers;

/** One stored pick span. */
function spanOf(start, end, draftRev) {
  return { start, end, draftRev };
}

test('dialog: a fresh span replaces the /query token and keeps both neighbours', () => {
  const plan = planInsert('hello /abo', 3, spanOf(6, 10, 3), 'BODY');
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'replace');
  assert.equal(plan.next, 'hello BODY');
  assert.equal(plan.text, 'BODY');
  assert.equal(plan.span.start, 6);
  assert.equal(plan.span.end, 10);
  assert.equal(plan.span.draftRev, 3);

  const middle = planInsert('A /q B', 1, spanOf(2, 4, 1), 'X');
  assert.equal(middle.next, 'A X B');
});

test('dialog: two consecutive picks stack instead of overwriting each other (AC-3)', () => {
  const first = planInsert('x /a', 1, spanOf(2, 4, 1), 'ONE');
  assert.equal(first.next, 'x ONE');
  // The user types a new token after the first insert; the composer revision moved.
  const draft = first.next + ' /b';
  const second = planInsert(draft, 2, spanOf(draft.length - 2, draft.length, 2), 'TWO');
  assert.equal(second.ok, true);
  assert.equal(second.next, 'x ONE TWO');
  assert.ok(second.next.includes('ONE') && second.next.includes('TWO'));
});

test('dialog: a stale draft revision is refused with no write payload', () => {
  const plan = planInsert('hello /abo', 4, spanOf(6, 10, 3), 'BODY');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'stale-revision');
  assert.equal(plan.next, undefined, 'a refused plan must not carry a next draft');
  assert.equal(plan.text, undefined);
});

test('dialog: a span without a revision is refused (never "trust the coordinates")', () => {
  const withoutRev = planInsert('hello /abo', 1, { start: 6, end: 10 }, 'BODY');
  assert.equal(withoutRev.reason, 'stale-revision');
  const nanRev = planInsert('hello /abo', 1, spanOf(6, 10, NaN), 'BODY');
  assert.equal(nanRev.reason, 'stale-revision');
});

test('dialog: a span that no longer covers a /query token is refused', () => {
  const plan = planInsert('hello world', 1, spanOf(6, 10, 1), 'BODY');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'token-gone');
  const shifted = planInsert('prefix hello /q', 1, spanOf(6, 10, 1), 'BODY');
  assert.equal(shifted.ok, false);
});

test('dialog: out-of-range or inverted spans are refused, not clamped into a write', () => {
  assert.equal(planInsert('abc', 1, spanOf(1, 9, 1), 'X').reason, 'stale-span');
  assert.equal(planInsert('abc', 1, spanOf(2, 1, 1), 'X').reason, 'stale-span');
  assert.equal(planInsert('abc', 1, spanOf(-1, 2, 1), 'X').reason, 'stale-span');
  assert.equal(planInsert('abc', 1, spanOf(1.5, 2, 1), 'X').reason, 'stale-span');
});

test('dialog: degenerate arguments are refused', () => {
  assert.equal(planInsert(undefined, 1, null, 'X').reason, 'no-draft');
  assert.equal(planInsert('abc', undefined, null, 'X').reason, 'no-revision');
  assert.equal(planInsert('abc', 1, null, '').reason, 'no-text');
  assert.equal(planInsert('abc', 1, null, null).reason, 'no-text');
});

test('dialog: no span appends at the draft end with a paragraph break', () => {
  const empty = planInsert('', 1, null, 'BODY');
  assert.equal(empty.ok, true);
  assert.equal(empty.mode, 'append');
  assert.equal(empty.next, 'BODY');
  assert.equal(empty.text, 'BODY');
  assert.equal(empty.span.start, 0);
  assert.equal(empty.span.end, 0);
  assert.equal(empty.span.draftRev, 1);

  const tight = planInsert('abc', 2, null, 'BODY');
  assert.equal(tight.next, 'abc\n\nBODY');
  assert.equal(tight.text, '\n\nBODY');

  const spaced = planInsert('abc\n', 3, null, 'BODY');
  assert.equal(spaced.next, 'abc\nBODY');
  assert.equal(spaced.text, 'BODY');
});

test('dialog: the dialog key separates pick revisions so a re-pick starts fresh', () => {
  const prompt = { id: 'p_1' };
  const atRev = (draftRev) => promptDialogKey({ kind: 'use', prompt, span: spanOf(1, 2, draftRev), delivery: 'insert' });
  assert.equal(atRev(1), atRev(1));
  assert.notEqual(atRev(1), atRev(2));
  assert.equal(promptDialogKey({ kind: 'edit-layer', layer: { promptId: 'p_1' } }), 'layer:p_1');
  assert.equal(promptDialogKey(null), 'none');
});

test('dialog: the layer-limit code is rendered as localized copy, not the host sentence', () => {
  const t = (key) => 'T:' + key;
  const limited = dialogErrorText({ ok: false, code: 'layer-limit', message: 'at most 3 session layers' }, t);
  assert.equal(limited, 'T:dialog.delivery.full');
  assert.equal(dialogErrorText({ ok: false, code: 'input-invalid', message: 'bad body' }, t), 'T:dialog.error');
  assert.equal(dialogErrorText({ ok: false, message: 'boom' }, t), 'T:dialog.error');
  assert.equal(dialogErrorText(undefined, t), 'T:dialog.error');
});
