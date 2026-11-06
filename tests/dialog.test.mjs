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
 *     English sentence (audit should-fix 9) — including the four 0.2 persistence
 *     codes layer-persist / layer-read-failed / layer-readonly / session-invalid
 *     (0.2 design §6.3).
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
  `${source}\n;globalThis.__dialogHelpers = { planInsert, promptDialogKey, dialogErrorText, frameFromMeasurement, frameSettled };`,
  sandbox,
  { filename: 'src/client/dialog.ts' }
);
const { planInsert, promptDialogKey, dialogErrorText, frameFromMeasurement, frameSettled } = sandbox.__dialogHelpers;

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

test('dialog: the 0.2 persistence codes are rendered as localized copy too', () => {
  const t = (key) => 'T:' + key;
  assert.equal(
    dialogErrorText({ ok: false, code: 'layer-persist', message: 'ENOSPC: no space left on device' }, t),
    'T:dialog.persistFailed'
  );
  assert.equal(
    dialogErrorText({ ok: false, code: 'layer-read-failed', message: 'EACCES: permission denied' }, t),
    'T:dialog.readFailed'
  );
  assert.equal(dialogErrorText({ ok: false, code: 'layer-readonly', message: 'version 2' }, t), 'T:dialog.readOnly');
  assert.equal(dialogErrorText({ ok: false, code: 'session-invalid', message: 'bad id' }, t), 'T:dialog.sessionInvalid');
});

// ---------------------------------------------------------------------------
// Backdrop placement (0.2.1): DSH 0.2.2 gives the composer seat
// `will-change: transform`, which makes it the containing block of our
// `position: fixed` backdrop — viewport coordinates written as left/top then
// land under the input box (live defect 2026-11-06). The frame is therefore
// DERIVED from one measurement, never from viewport arithmetic. These cases are
// the pure half of that derivation; the DOM half is verified in a real browser.
// ---------------------------------------------------------------------------

/** One box in the helper's shape. */
function box(left, top, width, height) {
  return { left, top, width, height };
}

test('placement: a viewport-sized containing block is a straight copy', () => {
  const next = frameFromMeasurement(box(0, 0, 800, 600), box(0, 0, 800, 600), box(120, 40, 800, 600));
  assert.equal(next.left, 120);
  assert.equal(next.top, 40);
  assert.equal(next.width, 800);
  assert.equal(next.height, 600);
});

test('placement: an offset containing block (composer seat) is compensated, not added', () => {
  // The seat sits at (240, 712) in viewport px; the probe named left/top 0 and
  // still measured there. The frame must subtract that origin.
  const next = frameFromMeasurement(box(0, 0, 824, 805), box(240, 712, 824, 805), box(240, 0, 824, 805));
  assert.equal(next.left, 0);
  assert.equal(next.top, -712);
  assert.equal(next.width, 824);
  assert.equal(next.height, 805);
});

test('placement: a scaled containing block divides the frame by the measured scale', () => {
  // scale(0.8) ancestor: a 1000x1000 CSS probe measures 800x800.
  const next = frameFromMeasurement(box(0, 0, 1000, 1000), box(0, 0, 800, 800), box(0, 0, 640, 640));
  assert.equal(next.left, 0);
  assert.equal(next.top, 0);
  assert.equal(next.width, 800);
  assert.equal(next.height, 800);
});

test('placement: a partially applied frame is corrected from wherever it is', () => {
  const next = frameFromMeasurement(box(10, 20, 100, 50), box(110, 120, 100, 50), box(60, 80, 100, 50));
  assert.equal(next.left, -40);
  assert.equal(next.top, -20);
  assert.equal(next.width, 100);
  assert.equal(next.height, 50);
});

test('placement: the correction is idempotent once the box is where it belongs', () => {
  const target = box(240, 0, 824, 805);
  const settled = box(0, -712, 824, 805);
  const again = frameFromMeasurement(settled, box(240, 0, 824, 805), target);
  assert.equal(again.left, settled.left);
  assert.equal(again.top, settled.top);
  assert.equal(again.width, settled.width);
  assert.equal(again.height, settled.height);
});

test('placement: unusable measurements return null instead of a broken frame', () => {
  const ok = box(0, 0, 800, 600);
  assert.equal(frameFromMeasurement(null, ok, ok), null);
  assert.equal(frameFromMeasurement(ok, null, ok), null);
  assert.equal(frameFromMeasurement(ok, ok, null), null);
  assert.equal(frameFromMeasurement(box(0, 0, 0, 600), ok, ok), null, 'a zero-width frame cannot be measured');
  assert.equal(frameFromMeasurement(ok, box(0, 0, 0, 600), ok), null, 'a zero-width probe hides the scale');
  assert.equal(frameFromMeasurement(ok, ok, box(0, 0, 0, 600)), null, 'a zero-width target is not a box');
  assert.equal(frameFromMeasurement(ok, ok, box(0, 0, 800, NaN)), null);
  assert.equal(frameFromMeasurement(box(0, 0, NaN, 600), ok, ok), null);
  assert.equal(frameFromMeasurement('nope', ok, ok), null);
});
test('placement: the settle test ends the passes at sub-pixel agreement only', () => {
  const frame = box(0, -712, 824, 805);
  assert.equal(frameSettled(frame, box(0, -712, 824, 805)), true, 'identical frames are settled');
  assert.equal(frameSettled(frame, box(0.4, -711.6, 824.4, 804.6)), true, 'sub-pixel noise is settled');
  assert.equal(frameSettled(frame, box(0.6, -712, 824, 805)), false, 'a >0.5px horizontal move is not settled');
  assert.equal(frameSettled(frame, box(0, -712.6, 824, 805)), false, 'a >0.5px vertical move is not settled');
  assert.equal(frameSettled(frame, box(0, -712, 824.6, 805)), false, 'a >0.5px width change is not settled');
  assert.equal(frameSettled(frame, box(0, -712, 824, 805.6)), false, 'a >0.5px height change is not settled');
  assert.equal(frameSettled(null, frame), false);
  assert.equal(frameSettled(frame, null), false);
});
