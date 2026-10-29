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
 * Geometry (design §12.2): the overlay slot sits inside the composer CARD, so a
 * `position: fixed` backdrop would be laid out against the viewport and cover
 * the side panels. The backdrop instead measures the conversation content area
 * (`[data-conversation-scroll]`, the platform's explicit data hook on
 * `ConversationRoot`'s scroll body) and is pinned to that box; the dialog then
 * centres inside it with 16px of backdrop padding. Without a measurement the
 * stylesheet's viewport fallback applies (see useConversationFrame).
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
 * (…/@deepseek-ai/dsh-client-ui-conversation/lib/client.js ->
 * `InputBar` `overlayAnchor`: `{height:0;position:absolute;inset:0 0 auto}`
 * inside `.uV2eYG_card{position:relative}`), so the old
 * `position: fixed; inset: 0` backdrop was laid out against the VIEWPORT and
 * the dialog therefore centred over the whole window — covering a wide side
 * panel (live acceptance finding 2).
 *
 * The content area between the side panels is the conversation scroll body,
 * which carries an explicit data hook rather than a hashed CSS class:
 * `ConversationRoot` renders `scrollBody` with `"data-conversation-scroll": ""`
 * (same bundle, the root's JSX). Measuring the nearest such ancestor of our own
 * backdrop keeps the overlay on our own session (never a global query) and never
 * touches a side panel. Design §12.2: the dialog centres inside the content
 * area and keeps >=16px margins (the stylesheet's 16px backdrop padding).
 */
const CONVERSATION_AREA_SELECTOR = '[data-conversation-scroll]';

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
 * Turn a measured content-area rect into the backdrop's inline geometry.
 *
 * Pure and total: anything unusable (no rect, a zero/negative box, a future
 * layout that measures before painting) yields `null`, which leaves the
 * stylesheet's `inset: 0` viewport fallback in force — never a broken frame.
 * @param {{left: number, top: number, width: number, height: number}|null} rect - `getBoundingClientRect()` view.
 * @returns {{left: string, top: string, width: string, height: string, right: string, bottom: string}|null} inline style, or null.
 */
function overlayFrameStyle(rect) {
  if (rect === null || rect === undefined) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    left: Math.round(rect.left) + 'px',
    top: Math.round(rect.top) + 'px',
    width: width + 'px',
    height: height + 'px',
    // A fixed box that sets left+width over-constrains `inset: 0`; naming the
    // remaining sides explicitly keeps the measured frame authoritative.
    right: 'auto',
    bottom: 'auto'
  };
}

/**
 * Measure the conversation content area and keep the frame current.
 *
 * Runs once per dialog mount (the overlay is remounted for every pending
 * dialog) in a layout effect, so the corrected frame is applied before paint;
 * a `ResizeObserver` on the content area plus the window `resize` event track
 * a side panel opening/closing while the dialog is open. ResizeObserver is
 * optional: without it the dialog still lands correctly at open time.
 * @param {{current: object|null}} ref - the backdrop element ref.
 * @returns {object|null} inline style for the backdrop, or null for the fallback.
 */
function useConversationFrame(ref) {
  const [frame, setFrame] = useState(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || node === undefined) return undefined;
    const measure = () => {
      const area = conversationAreaOf(node);
      setFrame(overlayFrameStyle(area === null ? null : area.getBoundingClientRect()));
    };
    measure();
    const area = conversationAreaOf(node);
    const observer = typeof ResizeObserver === 'function' && area !== null ? new ResizeObserver(measure) : null;
    if (observer !== null) observer.observe(area);
    const onResize = () => measure();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', onResize);
    }
    return () => {
      if (observer !== null) observer.disconnect();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onResize);
      }
    };
  }, []);
  return frame;
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
  // (design §12.2): the backdrop is pinned to the measured area.
  const backdropRef = useRef(null);
  const frame = useConversationFrame(backdropRef);

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
      // null = "not measured yet": keep the stylesheet's viewport fallback.
      style: frame === null ? undefined : frame,
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
