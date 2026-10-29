/**
 * Per-session system-prompt layers (design §5.2, D1).
 *
 * In-memory only: a DSH restart clears every layer, which is exactly the
 * "no invisible billing" guarantee of the requirements. Keyed by
 * `String(agent.session.id)`. At most three layers per session; adding an
 * existing `promptId` updates that layer in place (same slot, new text) and
 * never counts against the limit.
 *
 * This module is deliberately dependency-free (no cordis, no zod): the unit
 * tests import it straight from `lib/host/layers.js` under plain `node:test`.
 */
import { estimateTokens } from '../shared/tokens.js';

/** Error code thrown when a fourth layer is requested. */
export const LAYER_LIMIT_CODE = 'layer-limit';

/**
 * Build one layer snapshot (`LayerSnapshot` wire shape).
 * @param {object[]} layers - internal layer rows.
 * @param {number} limit - the session limit.
 * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
 */
function snapshotOf(layers, limit) {
  const rows = layers.map((layer) => ({
    promptId: layer.promptId,
    title: layer.title,
    body: layer.body,
    tokens: layer.tokens
  }));
  return {
    layers: rows,
    totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    limit
  };
}

/** The session layer registry. */
export class LayerRegistry {
  /** `Map<sessionId, Layer[]>` — process memory, never persisted. */
  #bySession = new Map();
  /** Maximum layers per session. */
  limit;

  /**
   * @param {{contract: {LIMITS: {layers: number}}}} options - contract limits.
   */
  constructor({ contract }) {
    this.limit = contract.LIMITS.layers;
  }

  /** @returns {number} how many sessions currently hold at least one layer. */
  get size() {
    return this.#bySession.size;
  }

  /**
   * Read one session's layers.
   * @param {string} sessionId - session identity.
   * @returns {object[]} internal rows (live array; callers must not mutate).
   */
  #list(sessionId) {
    return this.#bySession.get(sessionId) ?? [];
  }

  /**
   * @param {string} sessionId - session identity.
   * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
   */
  snapshot(sessionId) {
    return snapshotOf(this.#list(sessionId), this.limit);
  }

  /**
   * Add or update one layer.
   * @param {string} sessionId - session identity.
   * @param {{promptId: string, title: string, body: string}} input - layer content.
   * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
   * @throws {Error & {code: string}} `layer-limit` when a fourth distinct layer is requested.
   */
  add(sessionId, input) {
    const list = this.#list(sessionId);
    const tokens = estimateTokens(input.body);
    const existing = list.find((layer) => layer.promptId === input.promptId);
    if (existing !== undefined) {
      existing.title = input.title;
      existing.body = input.body;
      existing.tokens = tokens;
      return this.snapshot(sessionId);
    }
    if (list.length >= this.limit) {
      // `layer-limit` is the contract: the client maps that CODE onto localized
      // product copy (src/client/dialog.js -> dialogErrorText -> 'dialog.delivery.full'),
      // so this English sentence is only the host-side/log fallback and never the
      // string a Chinese dialog shows (audit should-fix 9).
      const error = new Error(`at most ${this.limit} session layers`) as Error & { code: string };
      error.code = LAYER_LIMIT_CODE;
      throw error;
    }
    list.push({ promptId: input.promptId, title: input.title, body: input.body, tokens });
    this.#bySession.set(sessionId, list);
    return this.snapshot(sessionId);
  }

  /**
   * Remove one layer (idempotent).
   * @param {string} sessionId - session identity.
   * @param {string} promptId - layer to drop.
   * @returns {{layers: object[], totalTokens: number, limit: number}} snapshot.
   */
  remove(sessionId, promptId) {
    const list = this.#list(sessionId).filter((layer) => layer.promptId !== promptId);
    if (list.length === 0) this.#bySession.delete(sessionId);
    else this.#bySession.set(sessionId, list);
    return this.snapshot(sessionId);
  }

  /**
   * Clear every layer of one session.
   * @param {string} sessionId - session identity.
   * @returns {{layers: object[], totalTokens: number, limit: number}} empty snapshot.
   */
  clear(sessionId) {
    this.#bySession.delete(sessionId);
    return this.snapshot(sessionId);
  }

  /**
   * The prompt section text for one session (design §5.2).
   * @param {string} sessionId - session identity.
   * @returns {string} joined bodies, or '' when the session has no layer.
   */
  sectionText(sessionId) {
    const list = this.#list(sessionId);
    if (list.length === 0) return '';
    return list.map((layer) => layer.body).join('\n\n---\n\n');
  }
}
