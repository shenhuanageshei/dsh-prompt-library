/**
 * The settings section (design §5.8, §12.5): list, search, create, edit,
 * delete, import, export, token estimate, and the read-only storage path.
 *
 * Import follows the confirmed mockup (design §5.8): `replace` rewrites the
 * whole library after an explicit confirmation, `merge` is by id with the
 * imported entry winning. The batch is all-or-nothing (one invalid entry rejects
 * the whole import — a local rule documented in README, "导入是原子的"), and the
 * host reports how many entries landed. Export writes the same JSON the library
 * file holds, so a hand-edited file and an exported file are interchangeable.
 */

import { React, useState, useRef } from './react.js';
import { estimateTokens } from '../shared/tokens.js';
import { promptMatches } from './source.js';

/** Body limit mirroring the host schema. */
const SETTINGS_BODY_MAX = 20000;

/** Client-side title limit mirroring the host schema. */
const SETTINGS_TITLE_MAX = 80;

/** Client-side tag limit mirroring the host schema. */
const SETTINGS_TAG_MAX = 8;

/**
 * Whether the toolbar's write actions (add / import) are available.
 *
 * A library file written by a newer version is served read-only by the host
 * (design §9: "未知 version 只读 + 提示，不覆盖"). Offering "新增/导入" there only
 * produced a failed write that rendered the host's English sentence, so the
 * toolbar is disabled instead (code-review round 2, finding #5). Row edits keep
 * their affordance: the host still refuses fail-closed and the refusal now
 * renders product copy, so disabling them as well would change more behaviour
 * than the finding asked for.
 * @param {object|undefined} snapshot - client library view.
 * @returns {boolean} true when the library accepts writes.
 */
function libraryWritable(snapshot) {
  return snapshot?.available === true && snapshot?.readOnly !== true;
}

/**
 * Split the comma-separated tag field.
 * @param {string} value - raw field text.
 * @returns {string[]} trimmed, non-empty, de-duplicated tags.
 */
function parseTagField(value) {
  const seen = new Set();
  const tags = [];
  for (const part of String(value ?? '').split(/[,，]/u)) {
    const tag = part.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/**
 * Filter the library for the search box (title, tags, body).
 * @param {object[]} prompts - library prompts.
 * @param {string} query - raw query.
 * @returns {object[]} matching prompts in library order.
 */
function filterLibrary(prompts, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return prompts;
  return prompts.filter((prompt) => promptMatches(prompt, needle));
}

/**
 * Normalize one `importLibrary` RPC outcome.
 *
 * The client store returns `{ ok, value }` for success and
 * `{ ok: false, code, message, invalid? }` for failure, so the count lives at
 * `result.value.imported` — NOT at `result.imported` (audit should-fix 5: the
 * old read made every successful import report "imported 0 prompts").
 * @param {object} result - outcome from the client half's `importLibrary`.
 * @returns {{ok: boolean, imported: number, replaced: boolean, invalid: number, message: string, code: string}} normalized outcome.
 */
function importOutcome(result) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    const value = result.value ?? {};
    return {
      ok: true,
      imported: Number.isInteger(value.imported) ? value.imported : 0,
      replaced: value.replaced === true,
      invalid: 0,
      message: '',
      code: ''
    };
  }
  return {
    ok: false,
    imported: 0,
    replaced: false,
    invalid: typeof result?.invalid === 'number' ? result.invalid : 0,
    message: typeof result?.message === 'string' ? result.message : '',
    code: typeof result?.code === 'string' ? result.code : ''
  };
}

/**
 * Product copy for the library failure codes the settings page can provoke.
 *
 * Every failure used to render `result.message` verbatim, so a Chinese settings
 * page showed the host's English sentence (code-review round 2, finding #5).
 * The three codes a write can carry here are mapped to the product copy;
 * anything else still falls back to `settings.error` with the host message.
 * @param {string|undefined} code - wire error code.
 * @param {(key: string, params?: object) => string} t - namespace translator.
 * @returns {string} the localized sentence, or '' when the code is not mapped.
 */
function libraryFailureCopy(code, t) {
  if (code === 'library-readonly') return t('settings.errorReadOnly');
  if (code === 'library-full') return t('settings.errorFull');
  if (code === 'library-corrupt') return t('settings.errorCorrupt');
  return '';
}

/**
 * The sentence to render for one failed write.
 * @param {{code?: string, message?: string}|undefined} result - failed client call.
 * @param {(key: string, params?: object) => string} t - namespace translator.
 * @returns {string} localized failure text.
 */
function libraryErrorText(result, t) {
  const code = typeof result?.code === 'string' ? result.code : '';
  const mapped = libraryFailureCopy(code, t);
  if (mapped !== '') return mapped;
  return t('settings.error', { message: typeof result?.message === 'string' ? result.message : '' });
}

/**
 * Download the library as `prompts.json`.
 * @param {{prompts: object[], updatedAt: string|null}} snapshot - current library.
 * @returns {void}
 */
function downloadLibrary(snapshot) {
  const payload = { version: 1, updatedAt: snapshot.updatedAt ?? null, prompts: snapshot.prompts };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'prompts.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The settings section component.
 * @param {object} props - injected share and locale.
 * @returns {object} the rendered section.
 */
export function PromptLibrarySection(props) {
  const { useLibrary, savePrompt, removePrompt, importLibrary, reloadLibrary, t } = props;
  const snapshot = useLibrary((value) => value);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState(null);
  const [importState, setImportState] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileRef = useRef(null);

  const prompts = Array.isArray(snapshot?.prompts) ? snapshot.prompts : [];
  const rows = filterLibrary(prompts, query);
  const available = snapshot?.available === true;
  const writable = libraryWritable(snapshot);

  const report = (kind, text) => setMessage({ kind, text });
  const fail = (error) => report('error', t('settings.error', { message: error instanceof Error ? error.message : String(error) }));

  const startCreate = () => {
    setConfirmDelete(null);
    setEditor({ mode: 'new', id: null, title: '', tags: '', body: '' });
    setMessage(null);
  };

  const startEdit = (prompt) => {
    setConfirmDelete(null);
    setEditor({
      mode: 'edit',
      id: prompt.id,
      title: prompt.title,
      tags: Array.isArray(prompt.tags) ? prompt.tags.join(', ') : '',
      body: prompt.body
    });
    setMessage(null);
  };

  const submitEditor = async () => {
    if (editor === null) return;
    const title = editor.title.trim();
    const body = editor.body;
    const tags = parseTagField(editor.tags);
    if (title === '') return report('error', t('settings.titleRequired'));
    if (title.length > SETTINGS_TITLE_MAX) return report('error', t('settings.titleTooLong'));
    if (body.trim() === '') return report('error', t('settings.bodyRequired'));
    if (tags.length > SETTINGS_TAG_MAX) return report('error', t('settings.tooManyTags'));
    setBusy(true);
    try {
      const result = await savePrompt({ id: editor.id ?? undefined, title, body, tags });
      if (!result.ok) {
        report('error', libraryErrorText(result, t));
        return;
      }
      setEditor(null);
      report('info', t('settings.saved'));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const commitDelete = async (id) => {
    setBusy(true);
    try {
      const result = await removePrompt(id);
      if (!result.ok) {
        report('error', libraryErrorText(result, t));
        return;
      }
      setConfirmDelete(null);
      report('info', t('settings.deleted'));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const pickImportFile = () => {
    const input = fileRef.current;
    if (input !== null && typeof input.click === 'function') input.click();
  };

  const readImportFile = async (event) => {
    const file = event.target?.files?.[0];
    if (file === undefined) return;
    try {
      const text = await file.text();
      setImportState({ mode: 'merge', text, fileName: file.name });
      setMessage(null);
    } catch (error) {
      fail(error);
    } finally {
      // Allow re-picking the same file.
      event.target.value = '';
    }
  };

  const commitImport = async () => {
    if (importState === null) return;
    setBusy(true);
    try {
      const result = importOutcome(await importLibrary({ mode: importState.mode, text: importState.text }));
      if (!result.ok) {
        // A capped / read-only / corrupt library is NOT an "invalid batch": say
        // what happened in product copy instead of "0 invalid: <host sentence>".
        const mapped = libraryFailureCopy(result.code, t);
        if (mapped !== '') {
          report('error', mapped);
          return;
        }
        report('error', t('settings.importFailed', {
          count: result.invalid,
          message: result.message
        }));
        return;
      }
      setImportState(null);
      report('info', t('settings.imported', { count: result.imported }));
      await reloadLibrary(true);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const exportLibrary = () => {
    try {
      downloadLibrary(snapshot ?? { prompts: [], updatedAt: null });
      report('info', t('settings.exported'));
    } catch (error) {
      fail(error);
    }
  };

  const head = React.createElement(
    'div',
    { className: 'dsh_promptLibrary_sectionHead' },
    React.createElement('h2', { className: 'dsh_promptLibrary_sectionTitle' }, t('settings.title')),
    React.createElement('div', { className: 'dsh_promptLibrary_hint' }, t('settings.subtitle')),
    snapshot?.filePath
      ? React.createElement('div', { className: 'dsh_promptLibrary_path' }, `${t('settings.storePath')}: ${snapshot.filePath}`)
      : null
  );

  const banners = [];
  if (snapshot?.corruptBackup) {
    banners.push(
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_banner', role: 'status', key: 'corrupt' },
        t('settings.corrupt', { file: snapshot.corruptBackup })
      )
    );
  }
  if (snapshot?.readOnly === true) {
    banners.push(
      React.createElement('div', { className: 'dsh_promptLibrary_banner', role: 'status', key: 'readonly' }, t('settings.readOnly'))
    );
  }
  if (available !== true) {
    banners.push(
      React.createElement(
        'div',
        { className: 'dsh_promptLibrary_banner', role: 'status', key: 'unavailable' },
        t('settings.unavailable', { message: snapshot?.error ?? '' })
      )
    );
  }

  const toolbar = React.createElement(
    'div',
    { className: 'dsh_promptLibrary_toolbar' },
    React.createElement('input', {
      className: 'dsh_promptLibrary_input',
      type: 'search',
      value: query,
      placeholder: t('settings.search'),
      'aria-label': t('settings.search'),
      onChange: (event) => setQuery(event.target.value)
    }),
    React.createElement(
      'button',
      { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy || !writable, onClick: pickImportFile },
      t('settings.import')
    ),
    React.createElement(
      'button',
      { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy || prompts.length === 0, onClick: exportLibrary },
      t('settings.export')
    ),
    React.createElement(
      'button',
      { type: 'button', className: 'dsh_promptLibrary_button dsh_promptLibrary_buttonPrimary', disabled: busy || !writable, onClick: startCreate },
      t('settings.add')
    ),
    React.createElement('input', {
      type: 'file',
      accept: 'application/json,.json',
      ref: fileRef,
      style: { display: 'none' },
      onChange: readImportFile
    })
  );

  const table = (() => {
    if (rows.length === 0) {
      return React.createElement(
        'div',
        { className: 'dsh_promptLibrary_empty' },
        prompts.length === 0 ? t('settings.empty') : t('settings.noMatch')
      );
    }
    return React.createElement(
      'table',
      { className: 'dsh_promptLibrary_table' },
      React.createElement(
        'thead',
        null,
        React.createElement(
          'tr',
          null,
          React.createElement('th', null, t('settings.col.title')),
          React.createElement('th', null, t('settings.col.tags')),
          React.createElement('th', null, t('settings.col.tokens')),
          React.createElement('th', { style: { textAlign: 'right' } }, t('settings.col.actions'))
        )
      ),
      React.createElement(
        'tbody',
        null,
        rows.map((prompt) =>
          React.createElement(
            'tr',
            { key: prompt.id },
            React.createElement(
              'td',
              null,
              React.createElement('div', { className: 'dsh_promptLibrary_cellTitle' }, prompt.title),
              React.createElement('div', { className: 'dsh_promptLibrary_cellBody' }, prompt.body)
            ),
            React.createElement(
              'td',
              null,
              (prompt.tags ?? []).map((tag, index) =>
                React.createElement('span', { className: 'dsh_promptLibrary_tag', key: `${prompt.id}:${index}` }, tag)
              )
            ),
            React.createElement('td', null, String(estimateTokens(prompt.body))),
            React.createElement(
              'td',
              null,
              confirmDelete === prompt.id
                ? React.createElement(
                    'div',
                    { className: 'dsh_promptLibrary_confirm' },
                    React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('settings.deleteConfirm', { title: prompt.title })),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh_promptLibrary_button dsh_promptLibrary_buttonDanger',
                        disabled: busy,
                        onClick: () => void commitDelete(prompt.id)
                      },
                      t('settings.delete')
                    ),
                    React.createElement(
                      'button',
                      { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy, onClick: () => setConfirmDelete(null) },
                      t('settings.cancel')
                    )
                  )
                : React.createElement(
                    'div',
                    { className: 'dsh_promptLibrary_rowActions' },
                    React.createElement(
                      'button',
                      { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy, onClick: () => startEdit(prompt) },
                      t('settings.edit')
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh_promptLibrary_button',
                        disabled: busy,
                        onClick: () => {
                          setEditor(null);
                          setConfirmDelete(prompt.id);
                        }
                      },
                      t('settings.delete')
                    )
                  )
            )
          )
        )
      )
    );
  })();

  const form = editor === null
    ? null
    : React.createElement(
        'div',
        { className: 'dsh_promptLibrary_form' },
        React.createElement('strong', null, t(editor.mode === 'new' ? 'settings.formNew' : 'settings.formEdit')),
        React.createElement(
          'label',
          { className: 'dsh_promptLibrary_field' },
          React.createElement('span', { className: 'dsh_promptLibrary_fieldLabel' }, t('settings.fieldTitle')),
          React.createElement('input', {
            className: 'dsh_promptLibrary_input',
            value: editor.title,
            maxLength: SETTINGS_TITLE_MAX,
            onChange: (event) => setEditor({ ...editor, title: event.target.value })
          })
        ),
        React.createElement(
          'label',
          { className: 'dsh_promptLibrary_field' },
          React.createElement('span', { className: 'dsh_promptLibrary_fieldLabel' }, t('settings.fieldTags')),
          React.createElement('input', {
            className: 'dsh_promptLibrary_input',
            value: editor.tags,
            onChange: (event) => setEditor({ ...editor, tags: event.target.value })
          })
        ),
        React.createElement(
          'label',
          { className: 'dsh_promptLibrary_field' },
          React.createElement('span', { className: 'dsh_promptLibrary_fieldLabel' }, t('settings.fieldBody')),
          React.createElement('textarea', {
            className: 'dsh_promptLibrary_textarea',
            value: editor.body,
            maxLength: SETTINGS_BODY_MAX,
            spellCheck: false,
            onChange: (event) => setEditor({ ...editor, body: event.target.value })
          })
        ),
        React.createElement(
          'div',
          { className: 'dsh_promptLibrary_hint' },
          t('settings.bodyCount', { count: editor.body.length })
        ),
        React.createElement(
          'div',
          { className: 'dsh_promptLibrary_foot' },
          React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('dialog.tokens', { tokens: estimateTokens(editor.body) })),
          React.createElement('span', { className: 'dsh_promptLibrary_spacer' }),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy, onClick: () => setEditor(null) },
            t('settings.cancel')
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh_promptLibrary_button dsh_promptLibrary_buttonPrimary',
              disabled: busy,
              onClick: () => void submitEditor()
            },
            busy ? t('dialog.running') : t('settings.save')
          )
        )
      );

  const importBox = importState === null
    ? null
    : React.createElement(
        'div',
        { className: 'dsh_promptLibrary_importBox' },
        React.createElement('strong', null, t('settings.importTitle')),
        React.createElement('div', { className: 'dsh_promptLibrary_hint' }, `${importState.fileName} · ${importState.text.length} B`),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_option',
            'aria-pressed': importState.mode === 'replace',
            onClick: () => setImportState({ ...importState, mode: 'replace' })
          },
          React.createElement('span', { className: 'dsh_promptLibrary_optionTitle' }, t('settings.importReplace')),
          React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('settings.importReplaceDesc', { count: prompts.length }))
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh_promptLibrary_option',
            'aria-pressed': importState.mode === 'merge',
            onClick: () => setImportState({ ...importState, mode: 'merge' })
          },
          React.createElement('span', { className: 'dsh_promptLibrary_optionTitle' }, t('settings.importMerge')),
          React.createElement('span', { className: 'dsh_promptLibrary_hint' }, t('settings.importMergeDesc'))
        ),
        React.createElement(
          'div',
          { className: 'dsh_promptLibrary_confirm' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh_promptLibrary_button dsh_promptLibrary_buttonPrimary',
              disabled: busy,
              onClick: () => void commitImport()
            },
            busy ? t('settings.importing') : t('settings.importConfirm')
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh_promptLibrary_button', disabled: busy, onClick: () => setImportState(null) },
            t('settings.cancel')
          )
        )
      );

  const status = message === null
    ? null
    : React.createElement(
        'div',
        { className: message.kind === 'error' ? 'dsh_promptLibrary_error' : 'dsh_promptLibrary_message', role: 'status' },
        message.text
      );

  return React.createElement(
    'section',
    { className: 'dsh_promptLibrary_section', 'aria-label': t('settings.title') },
    head,
    banners,
    toolbar,
    available === true ? null : React.createElement('div', { className: 'dsh_promptLibrary_hint' }, t('settings.loading')),
    form,
    importBox,
    status,
    table
  );
}
