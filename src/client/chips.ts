/**
 * Session system-layer chips (design §5.7, §12.3), seated in
 * `conversation.input.dock` — the strip above the composer that
 * `dsh-at-file` also uses.
 *
 * One chip per layer, a × per chip, and one trailing total. Rendered only while
 * the session actually holds a layer, so an untouched session shows nothing.
 */

import { React } from './react.js';

/**
 * The dock entry.
 * @param {object} props - injected share (`useLayers`, `openEditor`, `remove`) and locale.
 * @returns {object|null} the chip strip, or null with no layers.
 */
export function LayersDock(props) {
  const snapshot = props.useLayers((value) => value);
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
