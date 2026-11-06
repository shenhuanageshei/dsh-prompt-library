/**
 * The edit-confirm dialog (design §5.6, §12.2).
 *
 * Seated in `conversation.input.overlay` — the same slot the `/` menu itself
 * renders into — so it inherits the session standard kit.
 *
 * Composer interface (verified in the installed 0.2.1-rc.3 client half):
 *   - the composer provides, for EVERY session-scoped slot,
 *     `{ hooks: { conversation, input }, props: { inputActions } }`
 *     (…/dsh-client-ui-conversation/lib/client.js -> `ctx.uiSession.provide({ hooks: ["conversation","input"], props: ["inputActions"], … })`);
 *   - the slot renderer turns each declared hook into the prop `use<Name>`
 *     (…/dsh-client-ui-renderer/lib/client.js -> `materializeStandardBinding`
 *     -> `standardHookPropName`), so the live composer state is `useInput(s => s)`
 *     — there is NO `props.input`;
 *   - the snapshot is the real `compose()` value
 *     `{ draft, attachmentIds, draftRev, phase, claim?, occurrences, queue }`;
 *     `draftRev` is the revision the menu stamps into `hit.span.draftRev`
 *     (…/dsh-client-ui-input-trigger/lib/client.js -> `track(draft, caret, guard, draftRev)`).
 *
 * `dsh-at-file`'s `FolderNavigator` (same overlay slot) uses exactly this pair
 * `useInput` + `inputActions`, which is the pattern this dialog follows.
 *
 * The write is a CAS: the stored `span.draftRev` must equal the live
 * `draftRev` and the stored span must still cover the `/query` token. On a
 * stale span nothing is written — the dialog says so and stays open instead of
 * replacing the composer with the bare body (which would delete the user's text).
 *
 * Picking a row never inserts text by itself: the source stores the menu's
 * `span` here and returns `undefined`, so this dialog owns the draft edit.
 *
 * Geometry (design §12.2, rev 0.2.1): the overlay slot sits inside the
 * composer CARD, so a `position: fixed` backdrop is NOT laid out against the
 * viewport and can never cover the side panels: DSH 0.2.2 makes the composer
 * seat a containing block for fixed descendants (`will-change: transform`
 * under `[data-phase=active]`), and any ancestor transform/zoom would do the
 * same. The backdrop therefore measures the conversation content area
 * (`[data-conversation-scroll]`, the platform's explicit data hook on
 * `ConversationRoot`'s scroll body) and is pinned to that box by measurement,
 * not by arithmetic on viewport numbers; the dialog then centres inside it with
 * 16px of backdrop padding. When nothing measurable is available the element
 * is handed back to the stylesheet's `inset: 0` fallback — never left on a
 * half-applied probe frame (see placeOverlay).
 */

import { React, useState, useRef, useLayoutEffect } from './react.js';
import { estimateTokens } from '../shared/tokens.js';

/** Hard body limit mirroring the host schema (design §6.1). */
const PROMPT_BODY_MAX = 20000;

/**
 * Splice the edited body over the `/query` token span, keeping the surrounding
 * text untouched (design §12.4; two picks therefore stack naturally).
 * @param {string} draft - current draft.
 * @param {{start: number, end: number}|null} span - the token span.
 * @param {string} text - replacement text.
 * @returns {string} the next draft.
 */
function replaceSpan(draft, span, text) {
  const start = Math.max(0, Math.min(Number.isInteger(span?.start) ? span.start : draft.length, draft.length));
  const end = Math.max(start, Math.min(Number.isInteger(span?.end) ? span.end : start, draft.length));
  return draft.slice(0, start) + text + draft.slice(end);
}

/**
 * Decide how one confirm-insert lands on the LIVE composer draft.
 *
 * This is the span CAS the design's `setDraft(next)` write needs but does not
 * get from the platform: the dialog stores the menu's pick-time span
 * (`{ start, end, draftRev }`) and the composer publishes its current
 * revision (`snapshot.draftRev`). Both must still agree, and the span must
 * still cover the `/query` token, or the edit is refused — the caller reports
 * the stale span and writes NOTHING (never `setDraft(body)`, which would throw
 * away everything the user typed around the token).
 *
 * Two shapes:
 *   - `replace`: overwrite `[start, end)` with the edited body, keeping both
 *     neighbours verbatim (design §12.4 — two picks therefore stack);
 *   - `append`: no span at all (a chip re-edit opened without menu
 *     coordinates) -> insert at the draft end, adding a paragraph break only
 *     when neither side of the insertion point already has whitespace.
 *
 * Pure: no React, no platform calls. `text` is what the caller hands to the
 * composer (already carrying the append break), `next` is the same edit
 * expressed as a whole-draft replacement.
 * @param {string} draft - live composer draft.
 * @param {number} draftRev - live composer draft revision.
 * @param {{start: number, end: number, draftRev: number}|null} span - stored pick span.
 * @param {string} text - edited body.
 * @returns {{ok: true, mode: 'replace'|'append', span: {start: number, end: number, draftRev: number}, text: string, next: string}|{ok: false, reason: string}} plan.
 */
function planInsert(draft, draftRev, span, text) {
  if (typeof draft !== 'string') return { ok: false, reason: 'no-draft' };
  if (typeof text !== 'string' || text === '') return { ok: false, reason: 'no-text' };
  if (!Number.isInteger(draftRev)) return { ok: false, reason: 'no-revision' };
  if (span === null || span === undefined) {
    const at = draft.length;
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const needsBreak = before !== '' && !/\s$/u.test(before) && !/^\s/u.test(after);
    const inserted = needsBreak ? '\n\n' + text : text;
    return {
      ok: true,
      mode: 'append',
      span: { start: at, end: at, draftRev },
      text: inserted,
      next: before + inserted + after
    };
  }
  if (typeof span !== 'object') return { ok: false, reason: 'stale-span' };
  if (!Number.isInteger(span.draftRev) || span.draftRev !== draftRev) return { ok: false, reason: 'stale-revision' };
  const start = span.start;
  const end = span.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > draft.length) {
    return { ok: false, reason: 'stale-span' };
  }
  if (!draft.slice(start, end).startsWith('/')) return { ok: false, reason: 'token-gone' };
  return {
    ok: true,
    mode: 'replace',
    span: { start, end, draftRev },
    text,
    next: replaceSpan(draft, { start, end }, text)
  };
}

/**
 * Localized text for one failed system-layer write.
 *
 * The host answers with a CODE and an English sentence
 * (src/host/layers.ts -> `LayerRegistry` / src/host/layer-store.ts). The dialog
 * renders whatever it is handed, so every code is mapped onto product copy here
 * rather than letting a host sentence appear inside a Chinese dialog
 * (0.2 design §6.3 — the Chinese dictionary is the copy of record):
 *
 *   layer-limit       a fourth distinct layer was refused;
 *   layer-persist     the write (or its backup/rename) failed, disk unchanged;
 *   layer-read-failed the layer file could not be read, so the write was refused;
 *   layer-readonly    the file was written by a newer version;
 *   session-invalid   the session id is not a safe layer-file name.
 * @param {{ok: false, code?: string, message?: string}} result - failed client call.
 * @param {(key: string, params?: object) => string} t - namespace translator.
 * @returns {string} the message to render.
 */
function dialogErrorText(result, t) {
  const code = typeof result?.code === 'string' ? result.code : '';
  if (code === 'layer-limit') return t('dialog.delivery.full');
  if (code === 'layer-persist') return t('dialog.persistFailed');
  if (code === 'layer-read-failed') return t('dialog.readFailed');
  if (code === 'layer-readonly') return t('dialog.readOnly');
  if (code === 'session-invalid') return t('dialog.sessionInvalid');
  return t('dialog.error', { message: typeof result?.message === 'string' ? result.message : '' });
}

/** Stable identity of one dialog instance (keyed remount resets its state). */
function promptDialogKey(pending) {
  if (pending === null || pending === undefined) return 'none';
  if (pending.kind === 'edit-layer') return `layer:${pending.layer.promptId}`;
  // The span's draft revision is part of the identity: re-picking the same row
  // after the draft moved is a NEW pending, so the body must start fresh.
  return `use:${pending.prompt.id}:${pending.span?.start ?? -1}:${pending.span?.end ?? -1}:${pending.span?.draftRev ?? -1}`;
}

/**
 * The conversation CONTENT column, as the platform marks it.
 *
 * The overlay slot renders INSIDE the composer card
 * (…/@deepseek-ai/dsh-client-ui-conversation/lib/client.js -> `InputBar`
 * `overlayAnchor`: `{height:0;position:absolute;inset:0 0 auto}` inside
 * `.GRgSLq_card{position:relative}`), so a "fixed = viewport" assumption is
 * wrong in BOTH directions:
 *
 *   - covering a wide side panel: a viewport-sized backdrop does that
 *     (live acceptance finding 2, 0.2.0);
 *   - drifting below the composer: DSH 0.2.2 renders the composer seat as
 *     `.an3WzG_composerSeat{position:sticky;z-index:9;will-change:transform}`
 *     under `[data-phase=active]`, and `will-change: transform` GENERATES A
 *     CONTAINING BLOCK for fixed descendants. Viewport `left/top` are then read
 *     against the seat (the bottom of the column), which puts the dialog under
 *     the input box and paints the tint over the conversation (live defect,
 *     2026-11-06). Any future ancestor transform/zoom/containment would do the
 *     same.
 *
 * So the backdrop is placed BY MEASUREMENT (placeOverlay): the conversation
 * scroll body carries an explicit data hook rather than a hashed class
 * (`ConversationRoot` renders `scrollBody` with
 * `"data-conversation-scroll": ""`), so the nearest such ancestor of our own
 * backdrop is our own session's content column — never a side panel, never a
 * global query. Design §12.2: the dialog centres inside that box and keeps
 * >=16px margins (the stylesheet's 16px backdrop padding).
 */
const CONVERSATION_AREA_SELECTOR = '[data-conversation-scroll]';

/**
 * Placement passes per measurement.
 *
 * One pass discovers the containing block (offset + scale); a second absorbs
 * the layout feedback the first can cause (a fixed descendant counts as
 * scrollable overflow of a scroll container whose descendant is its containing
 * block, so a probe can move a sticky composer by the scrollbar thickness); a
 * third is a no-op once the frame has settled.
 */
const PLACE_PASSES = 3;

/** Sub-pixel tolerance that ends the placement passes (a settled frame). */
const SETTLE_EPSILON_PX = 0.5;

/** One-shot guard: warn once per page load when the content-area hook is gone. */
let warnedMissingArea = false;

/**
 * Whether a corrected frame has converged (pure).
 *
 * Sub-pixel: the second pass exists to absorb layout feedback measured in whole
 * device pixels, so exact equality would never hold and the loop would always
 * spend all `PLACE_PASSES`.
 * @param {{left: number, top: number, width: number, height: number}|null} previous - the frame just applied.
 * @param {{left: number, top: number, width: number, height: number}|null} next - the correction computed for it.
 * @returns {boolean} true when every edge moved less than {@link SETTLE_EPSILON_PX}.
 */
export function frameSettled(previous, next) {
  if (previous === null || next === null) return false;
  if (typeof previous !== 'object' || typeof next !== 'object') return false;
  return (
    Math.abs(next.left - previous.left) < SETTLE_EPSILON_PX &&
    Math.abs(next.top - previous.top) < SETTLE_EPSILON_PX &&
    Math.abs(next.width - previous.width) < SETTLE_EPSILON_PX &&
    Math.abs(next.height - previous.height) < SETTLE_EPSILON_PX
  );
}

/**
 * The nearest conversation content area above one node.
 * @param {object|null} node - our own backdrop element.
 * @returns {object|null} the content-area element, or null when unavailable.
 */
function conversationAreaOf(node) {
  if (node === null || node === undefined) return null;
  if (typeof node.closest !== 'function') return null;
  return node.closest(CONVERSATION_AREA_SELECTOR);
}

/**
 * The viewport as a target box (fallback when the content area is unmeasurable).
 * @returns {{left: number, top: number, width: number, height: number}|null} the box, or null outside a browser.
 */
function viewportRect() {
  if (typeof window === 'undefined') return null;
  const width = Number(window.innerWidth);
  const height = Number(window.innerHeight);
  if (!(width > 0) || !(height > 0)) return null;
  return { left: 0, top: 0, width, height };
}

/**
 * The next CSS frame for one measured element.
 *
 * A frame is `left/top/width/height` in CSS px, expressed in whatever
 * coordinate space the element's containing block defines. The element's
 * measured rect is the SAME box in viewport px. One measurement therefore
 * reveals both the local scale (`measured.width / frame.width`) and where the
 * frame must move so that the visual box equals `target`; nothing is assumed
 * about the containing block (viewport, transformed ancestor, desktop zoom, the
 * 0.2.2 composer seat).
 *
 * Pure and total: anything unusable (missing box, zero size, non-finite field)
 * yields null and the caller keeps the frame it already had — never a broken
 * box.
 * @param {{left: number, top: number, width: number, height: number}|null} frame - the CSS frame currently applied.
 * @param {{left: number, top: number, width: number, height: number}|null} measured - `getBoundingClientRect()` for that frame.
 * @param {{left: number, top: number, width: number, height: number}|null} target - the box the element must cover, in viewport px.
 * @returns {{left: number, top: number, width: number, height: number}|null} the next frame, or null.
 */
export function frameFromMeasurement(frame, measured, target) {
  const boxes = [frame, measured, target];
  for (const box of boxes) {
    if (box === null || typeof box !== 'object') return null;
    if (!Number.isFinite(box.left) || !Number.isFinite(box.top)) return null;
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
  }
  if (!(frame.width > 0) || !(frame.height > 0)) return null;
  if (!(measured.width > 0) || !(measured.height > 0)) return null;
  if (!(target.width > 0) || !(target.height > 0)) return null;
  const scaleX = measured.width / frame.width;
  const scaleY = measured.height / frame.height;
  if (!(scaleX > 0) || !(scaleY > 0)) return null;
  return {
    left: frame.left + (target.left - measured.left) / scaleX,
    top: frame.top + (target.top - measured.top) / scaleY,
    width: frame.width * (target.width / measured.width),
    height: frame.height * (target.height / measured.height)
  };
}

/**
 * Write one CSS frame onto the backdrop (the stylesheet still supplies
 * `position: fixed`).
 * @param {object} node - the backdrop element.
 * @param {{left: number, top: number, width: number, height: number}} frame - the frame to apply.
 * @returns {void}
 */
function applyFrame(node, frame) {
  const px = (value) => Math.round(value * 100) / 100 + 'px';
  node.style.left = px(frame.left);
  node.style.top = px(frame.top);
  node.style.width = px(frame.width);
  node.style.height = px(frame.height);
  // A fixed box that names left+width over-constrains the stylesheet's
  // `inset: 0`; naming the remaining sides keeps the measured frame authoritative.
  node.style.right = 'auto';
  node.style.bottom = 'auto';
}

/**
 * Place the backdrop exactly over the conversation content area.
 *
 * Measures, corrects, and re-measures until the visual box equals the target
 * (see PLACE_PASSES). Writes styles directly instead of re-rendering: the
 * frame is presentation, and a React state round-trip would paint twice per
 * resize tick.
 * @param {object} node - the backdrop element.
 * @returns {void}
 */
function placeOverlay(node) {
  if (node === null || node === undefined) return;
  const area = conversationAreaOf(node);
  const areaRect = area === null ? null : area.getBoundingClientRect();
  const usable = areaRect !== null && areaRect.width > 0 && areaRect.height > 0;
  if (!usable) {
    // A renamed/removed hook is diagnosable instead of silently falling back to
    // the whole viewport (the 0.2.0 side-panel defect shape).
    if (!warnedMissingArea) {
      warnedMissingArea = true;
      console.warn(
        '[dsh-prompt-library] the conversation content hook (' + CONVERSATION_AREA_SELECTOR + ') is missing; the dialog falls back to the whole viewport'
      );
    }
  }
  const target = usable ? areaRect : viewportRect();
  if (target === null) return;
  const width = Math.round(target.width);
  const height = Math.round(target.height);
  if (!(width > 0) || !(height > 0)) return;
  let frame = { left: 0, top: 0, width, height };
  let placed = false;
  for (let pass = 0; pass < PLACE_PASSES; pass += 1) {
    applyFrame(node, frame);
    const next = frameFromMeasurement(frame, node.getBoundingClientRect(), target);
    if (next === null) {
      // No usable measurement. An already-placed frame stays (a transient zero
      // box must not drop the dialog mid-life); with nothing placed yet the
      // element goes back to the stylesheet's `inset: 0` fallback rather than
      // keeping the probe at the containing-block origin.
      if (!placed) clearFrame(node);
      return;
    }
    placed = true;
    const settled = frameSettled(frame, next);
    frame = next;
    if (settled) break;
  }
  applyFrame(node, frame);
}

/**
 * Remove the measured frame, restoring the stylesheet's `inset: 0` fallback.
 * @param {object} node - the backdrop element.
 * @returns {void}
 */
function clearFrame(node) {
  node.style.left = '';
  node.style.top = '';
  node.style.width = '';
  node.style.height = '';
  node.style.right = '';
  node.style.bottom = '';
}

/** Attributes whose flip swaps the platform's containing block for fixed boxes. */
const PHASE_ATTRIBUTES = ['data-phase', 'data-content-phase'];

/** Transition/animation events that mark the end of a composer phase change. */
const PHASE_TRANSITION_EVENTS = ['transitionend', 'animationend'];

/**
 * Keep the backdrop pinned to the conversation content area.
 *
 * Runs in a layout effect, so the corrected frame is applied before the first
 * paint (no flash of the `inset: 0` fallback). Later triggers re-place:
 *
 *   - the next animation frame — the composer animates between the platform's
 *     `hero`/`settling`/`active` phases right after mount;
 *   - a `ResizeObserver` of the content area (side panel, width handle, window);
 *   - the window `resize` event (also covers zoom / OS scaling);
 *   - a passive, frame-coalesced `scroll` listener (a sticky containing block
 *     and the box it pins can disagree for a frame while a fast scroll runs);
 *   - `transitionend` / `animationend` of that phase transition, and a
 *     `data-phase` / `data-content-phase` flip, which swaps the containing
 *     block (`will-change: transform`) without necessarily resizing anything.
 *
 * Optional browser APIs are feature-checked: without them the dialog still
 * lands correctly at open time. Every listener and observer is released on
 * unmount.
 * @param {{current: object|null}} ref - the backdrop element ref.
 * @returns {void}
 */
function useOverlayPlacement(ref) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || node === undefined) return undefined;
    const place = () => {
      placeOverlay(node);
    };
    /** Coalesce bursts (a fast scroll) into at most one placement per frame. */
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        place();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else run();
    };
    place();
    const cleanups = [];
    if (typeof requestAnimationFrame === 'function') {
      const raf = requestAnimationFrame(() => {
        place();
      });
      cleanups.push(() => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      });
    }
    const area = conversationAreaOf(node);
    if (typeof ResizeObserver === 'function' && area !== null) {
      const observer = new ResizeObserver(() => {
        place();
      });
      observer.observe(area);
      cleanups.push(() => observer.disconnect());
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onResize = () => {
        place();
      };
      window.addEventListener('resize', onResize);
      cleanups.push(() => window.removeEventListener('resize', onResize));
    }
    if (area !== null && typeof area.addEventListener === 'function') {
      const onPhaseTransition = () => {
        schedule();
      };
      area.addEventListener('scroll', schedule, { passive: true });
      for (const type of PHASE_TRANSITION_EVENTS) area.addEventListener(type, onPhaseTransition);
      cleanups.push(() => {
        area.removeEventListener('scroll', schedule);
        for (const type of PHASE_TRANSITION_EVENTS) area.removeEventListener(type, onPhaseTransition);
      });
    }
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body !== null) {
      const observer = new MutationObserver(() => {
        place();
      });
      observer.observe(document.body, { attributes: true, attributeFilter: PHASE_ATTRIBUTES, subtree: true });
      cleanups.push(() => observer.disconnect());
    }
    return () => {
      for (const dispose of cleanups) dispose();
    };
  }, []);
}

/**
 * The overlay entry: renders the current pending dialog for this session.
 * @param {object} props - runtime + injected + locale shares.
 * @returns {object|null} the dialog, or null while nothing is pending.
 */
export function PromptDialog(props) {
  const pending = props.useDialog((snapshot) => snapshot);
  if (pending === null || pending === undefined) return null;
  return React.createElement(PromptDialogBody, { ...props, key: promptDialogKey(pending), pending });
}

/**
 * One dialog body: title, tags, editable body, delivery choice, token estimate.
 * @param {object} props - as `PromptDialog` plus the resolved `pending`.
 * @returns {object} the rendered dialog.
 */
function PromptDialogBody(props) {
  const { pending, useInput, inputActions, addLayer, close, t, useLayers } = props;
  // The composer state is a standard hook (`input` -> `useInput`), never a prop.
  const composer = useInput((snapshot) => snapshot);
  const layers = useLayers((snapshot) => snapshot);
  const editingLayer = pending.kind === 'edit-layer';
  const promptId = editingLayer ? pending.layer.promptId : pending.prompt.id;
  const title = editingLayer ? pending.layer.title : pending.prompt.title;
  const tags = editingLayer || !Array.isArray(pending.prompt.tags) ? [] : pending.prompt.tags;
  const [body, setBody] = useState(editingLayer ? pending.layer.body : pending.prompt.body);
  const [delivery, setDelivery] = useState(editingLayer ? 'system' : pending.delivery ?? 'insert');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // The dialog is centred in the conversation content area, not the viewport
  // (design §12.2): the backdrop is PLACED BY MEASUREMENT at mount and whenever
  // the platform's geometry moves (useOverlayPlacement), because the composer
  // subtree now generates a containing block for fixed descendants.
  const backdropRef = useRef(null);
  useOverlayPlacement(backdropRef);

  const tokens = estimateTokens(body);
  const stacked = Array.isArray(layers?.layers) ? layers.layers : [];
  const limit = Number.isInteger(layers?.limit) ? layers.limit : 3;
  const hasOwnLayer = stacked.some((layer) => layer.promptId === promptId);
  const layerFull = !hasOwnLayer && stacked.length >= limit;
  // A full stack locks the system option, but never blocks "insert".
  const systemDisabled = layerFull && !hasOwnLayer;
  const heading = t(editingLayer ? 'dialog.editLayer.title' : 'dialog.use.title');
  const subtitle = t(editingLayer ? 'dialog.editLayer.subtitle' : 'dialog.use.subtitle');

  const hint = (() => {
    if (delivery !== 'system') return null;
    if (hasOwnLayer) return t('dialog.delivery.update');
    if (layerFull) return t('dialog.delivery.full');
    if (stacked.length > 0) return t('dialog.delivery.stack', { count: stacked.length, tokens });
    return null;
  })();

  const confirmLabel = editingLayer
    ? t('dialog.save')
    : delivery === 'system'
      ? t('dialog.inject')
      : t('dialog.insert');

  /**
   * Commit the insert path: CAS the stored pick span against the live draft,
   * then replace the `/query` token. A stale span writes NOTHING.
   */
  const insert = () => {
    const draft = typeof composer?.draft === 'string' ? composer.draft : '';
    const draftRev = Number.isInteger(composer?.draftRev) ? composer.draftRev : undefined;
    const canReplace = inputActions !== undefined && typeof inputActions.insertText === 'function';
    const canSetDraft = inputActions !== undefined && typeof inputActions.setDraft === 'function';
    if (!canReplace && !canSetDraft) {
      setError(t('dialog.error', { message: 'the composer actions are unavailable in this slot' }));
      return;
    }
    const plan = planInsert(draft, draftRev, pending.span, body);
    if (!plan.ok) {
      // Stale span / vanished token: say so and keep the dialog open. Writing
      // here would delete the user's surrounding text (the old `setDraft(body)`
      // fallback) or duplicate an earlier insert.
      setNotice(t('dialog.staleSpan'));
      return;
    }
    if (plan.mode === 'append' && canSetDraft) {
      // Append has no `/query` token to CAS: the plan was computed from the LIVE
      // draft in this same tick, so the planned whole-draft write is exact. The
      // synthesised zero-width span would instead be refused by the composer's
      // span replace, and the user would read "内容已经变了" after a plain append
      // (the chip re-edit path — audit finding 5, 0.2.1).
      inputActions.setDraft(plan.next);
      close();
      return;
    }
    if (canReplace) {
      // The composer's own span replace. It re-checks the revision inside the
      // shell and leaves reference chips in the rest of the draft intact.
      if (inputActions.insertText(plan.text, plan.span) === true) {
        close();
        return;
      }
      setNotice(t('dialog.staleSpan'));
      return;
    }
    inputActions.setDraft(plan.next);
    close();
  };

  /** Commit the system-layer path through the host registry. */
  const inject = async () => {
    setBusy(true);
    setError(null);
    const result = await addLayer({ promptId, title, body });
    setBusy(false);
    if (result.ok) close();
    else setError(dialogErrorText(result, t));
  };

  const confirm = () => {
    if (typeof body !== 'string' || body.trim() === '') {
      setError(t('dialog.bodyRequired'));
      return;
    }
    if (delivery === 'insert') insert();
    else void inject();
  };

  return React.createElement(
    'div',
    {
      className: 'dsh_promptLibrary_backdrop',
      ref: backdropRef,
      // No style prop by design: useOverlayPlacement writes the measured frame
      // imperatively, and until it runs the stylesheet's inset: 0 applies.
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) close();
      }
    },
    React.createElement(
      'div',
      {
        className: 'dsh_promptLibrary_dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': heading,
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            confirm();
          }
        }
      },
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_dialogHead' },
        React.createElement('h2', { className: 'dsh_promptLibrary_dialogTitle' }, heading),
        React.createElement('div', { className: 'dsh_promptLibrary_hint' }, subtitle)
      ),
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_dialogHead' },
        React.createElement('strong', null, title),
        tags.length === 0
          ? null
          : React.createElement(
              'div',
              { className: 'dsh_promptLibrary_tags' },
              tags.map((tag, index) => React.createElement('span', { className: 'dsh_promptLibrary_tag', key: `${index}:${tag}` }, tag))
            )
      ),
      React.createElement('textarea', {
        className: 'dsh_promptLibrary_textarea',
        'aria-label': t('dialog.body'),
        value: body,
        maxLength: PROMPT_BODY_MAX,
        autoFocus: true,
        spellCheck: false,
        onChange: (event) => {
          setBody(event.target.value);
          setError(null);
          setNotice(null);
        }
      }),
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_delivery' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_option',
            'aria-pressed': delivery === 'insert',
            onClick: () => {
              setDelivery('insert');
              setError(null);
            }
          },
          React.createElement('span', { className: 'dsh_promptLibrary_optionTitle' }, t('dialog.delivery.insert')),
          React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('dialog.delivery.insertDesc'))
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_option',
            'aria-pressed': delivery === 'system',
            disabled: systemDisabled,
            onClick: () => {
              if (systemDisabled) return;
              setDelivery('system');
              setError(null);
            }
          },
          React.createElement('span', { className: 'dsh_promptLibrary_optionTitle' }, t('dialog.delivery.system')),
          React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('dialog.delivery.systemDesc'))
        )
      ),
      hint === null ? null : React.createElement('div', { className: 'dsh_promptLibrary_message' }, hint),
      notice === null ? null : React.createElement('div', { className: 'dsh_promptLibrary_message' }, notice),
      error === null ? null : React.createElement('div', { className: 'dsh_promptLibrary_error', role: 'alert' }, error),
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_foot' },
        React.createElement(
          'span',
          { className: 'dsh_promptLibrary_hint' },
          t(delivery === 'system' ? 'dialog.tokensSystem' : 'dialog.tokens', { tokens })
        ),
        React.createElement('span', { className: 'dsh_promptLibrary_spacer' }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_button',
            disabled: busy,
            onClick: () => close()
          },
          t('dialog.cancel')
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_button dsh_promptLibrary_buttonPrimary',
            disabled: busy,
            onClick: () => confirm()
          },
          busy ? t('dialog.running') : confirmLabel
        )
      )
    )
  );
}
