/**
 * Session system-layer chips (design §5.7, §12.3), seated in
 * `conversation.input.dock` — the strip above the composer that
 * `dsh-at-file` also uses.
 *
 * One chip per layer, a × per chip, and one trailing total. Rendered only while
 * the session actually holds a layer, so an untouched session shows nothing.
 *
 * 0.2 (design §5.6 / FR-4): the strip asks for its own session's layers when it
 * mounts, instead of waiting for a session-list change. A browser refresh
 * therefore brings the chips back on its own; the old list sweep stays only as
 * a pre-warm of other sessions.
 */

import { React, useEffect } from './react.js';

/**
 * The dock entry.
 * @param {object} props - injected share (`useLayers`, `openEditor`, `remove`) and locale.
 * @returns {object|null} the chip strip, or null with no layers.
 */
export function LayersDock(props) {
  const snapshot = props.useLayers((value) => value);
  // Mount-time hydration. `ensure` is idempotent (it reuses an in-flight read and
  // skips a session that already succeeded) and never throws into render
  // (design §5.6), so this effect is safe on every mount/session switch.
  const ensure = props.ensure;
  useEffect(() => {
    if (typeof ensure === 'function') ensure();
  }, [props.sessionId]);
  const layers = Array.isArray(snapshot?.layers) ? snapshot.layers : [];
  if (layers.length === 0) return null;
  const total = Number.isFinite(snapshot?.totalTokens) ? snapshot.totalTokens : 0;
  return React.createElement(
    'div',
    { className: 'dsh_promptLibrary_chips', role: 'group', 'aria-label': props.t('chips.aria'), 'data-prompt-library-chips': '' },
    layers.map((layer) =>
      React.createElement(
        'span',
        { className: 'dsh_promptLibrary_chip', key: layer.promptId, 'data-prompt-library-chip': layer.promptId },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_chipTitle',
            title: props.t('chips.edit', { title: layer.title }),
            onClick: () => props.openEditor(layer.promptId)
          },
          layer.title
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_chipRemove',
            'aria-label': props.t('chips.remove', { title: layer.title }),
            title: props.t('chips.remove', { title: layer.title }),
            onClick: () => props.remove(layer.promptId)
          },
          '×'
        )
      )
    ),
    React.createElement(
      'span',
      { className: 'dsh_promptLibrary_chipTotal' },
      props.t('chips.count', { count: layers.length, tokens: total })
    )
  );
}
