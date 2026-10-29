/**
 * The `/` input-trigger source (design §5.5, §12.1).
 *
 * Registration facts verified against the installed 0.2.1-rc.2 client half
 * (`resources/app.asar!/dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js`):
 *   - sources on one trigger sort by `(a.order ?? 0) - (b.order ?? 0)`, so
 *     `order: -10` puts this group in front of `command`/`skill`/`subagent`;
 *   - the group heading is the menu's translation of `source.name`, so the raw
 *     name would show verbatim — this source sets `showGroupTitle: false` and
 *     stamps a literal `section` on every row instead, which the menu renders
 *     as an untranslated section title and which lets the heading follow the
 *     active locale;
 *   - `onPick` receives `{ candidate, session, position, via, action, span }`
 *     where `span` is `{ start, end, draftRev }` for the live `/query` token.
 *     Returning `undefined` inserts nothing and the menu closes itself, which is
 *     exactly the "open the edit-confirm dialog instead" path.
 */

/** Source name (unique per trigger; the menu's DOM ids derive from it). */
const PROMPT_SOURCE_NAME = 'prompt-library';

/** Candidate cap for the scrollable menu viewport (design §12.1). */
const MAX_MENU_ROWS = 20;

/** How long one successful library read stays hot (design §5.5: cache TTL 5s). */
const LIBRARY_TTL_MS = 5000;

/**
 * Case-insensitive match over title, tags, and body.
 * @param {object} prompt - one library prompt.
 * @param {string} needle - lowercase query.
 * @returns {boolean} whether the prompt matches.
 */
export function promptMatches(prompt, needle) {
  if (needle === '') return true;
  if (typeof prompt.title === 'string' && prompt.title.toLowerCase().includes(needle)) return true;
  if (typeof prompt.body === 'string' && prompt.body.toLowerCase().includes(needle)) return true;
  return Array.isArray(prompt.tags) && prompt.tags.some((tag) => typeof tag === 'string' && tag.toLowerCase().includes(needle));
}

/**
 * Filter and cap the library rows (library array order is preserved verbatim —
 * design §5.5 lists candidates in library order; no re-sorting in v0.1).
 * @param {object[]} prompts - library prompts in array order.
 * @param {string} query - raw menu query.
 * @param {number} limit - maximum rows.
 * @returns {object[]} matching prompts.
 */
function visiblePrompts(prompts, query, limit = MAX_MENU_ROWS) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const rows = [];
  for (const prompt of prompts) {
    if (!promptMatches(prompt, needle)) continue;
    rows.push(prompt);
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Build the `/` source plus its cache invalidator.
 * @param {{loadLibrary: (signal?: AbortSignal) => Promise<object>, openDialog: (sessionId: string, pending: object) => void, t: (key: string, params?: object) => string, estimateTokens: (text: string) => number, now?: () => number}} deps - injected faces.
 * @returns {{source: object, invalidate: () => void}} the source to register plus the cache invalidator.
 */
export function createPromptSource(deps) {
  const now = deps.now ?? (() => Date.now());
  let library = null;
  let fetchedAt = 0;
  let inflight = null;
  /**
   * The last snapshot read successfully, kept ACROSS invalidation: a pick can
   * land after a library write dropped the TTL cache, and the picked row must
   * still resolve to its full prompt (code-review round 1, finding #5).
   */
  let lastKnown = null;

  /** Mark the cached library stale (every library write and every reconnect). */
  const invalidate = () => {
    library = null;
    fetchedAt = 0;
    inflight = null;
  };

  /**
   * Read the library through the cache.
   * @param {AbortSignal|undefined} signal - caller cancellation.
   * @returns {Promise<object>} the library snapshot.
   */
  const load = (signal) => {
    if (library !== null && now() - fetchedAt < LIBRARY_TTL_MS) return Promise.resolve(library);
    if (inflight !== null) return inflight;
    inflight = Promise.resolve()
      .then(() => deps.loadLibrary(signal))
      .then(
        (snapshot) => {
          library = snapshot;
          lastKnown = snapshot;
          fetchedAt = now();
          inflight = null;
          return snapshot;
        },
        (error) => {
          inflight = null;
          throw error;
        }
      );
    return inflight;
  };

  /** One menu row for a prompt. */
  const row = (prompt) => {
    const tokens = deps.estimateTokens(prompt.body);
    const tags = Array.isArray(prompt.tags) ? prompt.tags.join(' · ') : '';
    const tokenLabel = deps.t('menu.tokens', { tokens });
    return {
      name: prompt.title,
      value: prompt.id,
      section: deps.t('menu.group'),
      description: tags === '' ? tokenLabel : `${tags} · ${tokenLabel}`
    };
  };

  /**
   * The prompt behind one menu row: the live TTL cache first, then the last
   * snapshot that was read successfully.
   * @param {{value?: string}|undefined} candidate - the picked menu row.
   * @returns {object|undefined} the stored prompt.
   */
  const findPrompt = (candidate) => {
    const id = candidate?.value;
    if (typeof id !== 'string' || id === '') return undefined;
    for (const snapshot of [library, lastKnown]) {
      const prompts = Array.isArray(snapshot?.prompts) ? snapshot.prompts : [];
      const found = prompts.find((entry) => entry.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const source = {
    trigger: '/',
    name: PROMPT_SOURCE_NAME,
    order: -10,
    showGroupTitle: false,
    async candidates(session, context) {
      const { query, signal } = context;
      let snapshot;
      try {
        snapshot = await load(signal);
      } catch (error) {
        // design §9 "RPC 不可用 -> 菜单只读缓存": a failed read must not blank a
        // menu that already has rows, so the warm cache still answers. Only a
        // cold cache (nothing read since the last invalidation) is empty.
        console.error('[dsh-prompt-library] reading the library from the host failed; serving the warm cache:', error);
        snapshot = library;
        if (snapshot === null) return [];
      }
      if (signal !== undefined && signal.aborted) return [];
      const prompts = Array.isArray(snapshot?.prompts) ? snapshot.prompts : [];
      return visiblePrompts(prompts, query).map(row);
    },
    /**
     * Prewarm the cache once the host is reachable; src/client/index.js calls
     * this right after the Remote mount settles (finding #5). Returns the read
     * promise so a caller can await it, and never rejects: a failed prewarm
     * must not surface, because the next menu open retries.
     * @returns {Promise<void>} settles after the read attempt.
     */
    warm() {
      return load(undefined).catch(() => {
        /* a failed prewarm must never surface: the next menu open retries */
      });
    },
    onPick({ candidate, session, span }) {
      const prompt = findPrompt(candidate);
      if (prompt !== undefined) {
        deps.openDialog(session.sessionId, { kind: 'use', prompt, span: span ?? null, delivery: 'insert' });
      } else {
        // The row outlived the cache (a library write landed while the menu was
        // open). Never dead-end the click: warn, then open the dialog from the
        // menu row so the user can still write a body before confirming.
        console.warn(
          '[dsh-prompt-library] ' + String(candidate?.value) + ' is no longer in the cached library; opening the dialog from the menu row'
        );
        deps.openDialog(session.sessionId, {
          kind: 'use',
          prompt: {
            id: typeof candidate?.value === 'string' ? candidate.value : '',
            title: typeof candidate?.name === 'string' ? candidate.name : '',
            body: '',
            tags: [],
            createdAt: '',
            updatedAt: ''
          },
          span: span ?? null,
          delivery: 'insert'
        });
      }
      // No text: the dialog owns the draft edit, so the menu closes without
      // touching the composer (design §5.5 / §11 "onPick 不自动关菜单" risk).
      return undefined;
    }
  };

  return { source, invalidate };
}

/**
 * The pick-time span is CAS-checked by the dialog, not here: `onPick` only
 * carries `{ start, end, draftRev }` into the pending record and
 * `dialog.js` -> `planInsert` compares that revision with the live composer
 * draft before any write.
 */
