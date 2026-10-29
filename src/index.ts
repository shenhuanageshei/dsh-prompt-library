/**
 * dsh-prompt-library — host half.
 *
 * Owns three things and nothing else:
 *   1. the prompt library file (`$DSH_HOME/prompt-library/prompts.json`, atomic
 *      write + backup + quarantine — src/host/store.js);
 *   2. the per-session system layers (process memory, max three —
 *      src/host/layers.js);
 *   3. the `promptLibrary` Remote namespace (strict Typert manifest plus
 *      `@Remote` markers — src/host/service.js).
 *
 * With no active layer the registered prompt section returns an empty string,
 * so an untouched session pays exactly zero extra tokens (AC-11).
 */
import { homedir } from 'node:os';
import { z } from 'zod';
import { defineContract } from './contract.js';
import { PromptStore, resolveLibraryPath } from './host/store.js';
import { LayerRegistry } from './host/layers.js';
import { PromptLibraryService } from './host/service.js';
import { buildManifest } from './host/typert.js';

/** Cordis plugin name (the Loader entry and the client bundle id). */
export const name = 'dsh-prompt-library';

/** Services required before load: the Typert registry and the system-prompt registry. */
export const inject = ['typert', 'systemPrompt'];

/** Name of the registered prompt section (stable; visible in the assembly). */
export const SECTION_NAME = 'prompt-library:session-layers';

/** Section order used when the platform exposes no placement table. */
export const SECTION_ORDER_FALLBACK = 10200;

/** Offset after DEPLOYMENT_PERSONA_SUFFIX, i.e. the very end of the prompt. */
export const SECTION_ORDER_OFFSET = 300;

/**
 * Resolve this plugin's prompt-section order.
 *
 * The value is DERIVED, never hardcoded: `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`
 * (10200 on DSH 0.2.1-rc.2) + 300 = 10500. The 10500 shown in design §5.3 /
 * §7.1 is only an illustration of that arithmetic — if a future platform moves
 * the persona suffix, this section follows it instead of drifting.
 * @param {object} systemPrompt - the `ctx.systemPrompt` service.
 * @returns {number} section order.
 */
export function resolveSectionOrder(systemPrompt) {
  const base = typeof systemPrompt?.getSectionOrder === 'function'
    ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
    : undefined;
  return (Number.isFinite(base) ? base : SECTION_ORDER_FALLBACK) + SECTION_ORDER_OFFSET;
}

/**
 * Mount the library store, the layer registry, the Remote service, the strict
 * Typert manifest, and the session-layer prompt section.
 * @param {object} ctx - host cordis context.
 * @returns {void}
 */
export function apply(ctx) {
  const contract = defineContract(z);
  const store = new PromptStore({ filePath: resolveLibraryPath(process.env, homedir()), contract });
  const layers = new LayerRegistry({ contract });
  const service = new PromptLibraryService(ctx, { store, layers, contract });

  // Strict endpoint registration: the gateway resolves promptLibrary/* from this
  // manifest, independent of decorator marker state. A platform that rejects the
  // manifest still serves the calls through the @Remote markers on the service,
  // so this failure is contained (and loud in the host log).
  ctx.effect(() => {
    try {
      const dispose = ctx.typert.register(buildManifest(contract));
      return () => {
        void dispose();
      };
    } catch (error) {
      console.error('[dsh-prompt-library] strict Typert manifest registration failed; falling back to @Remote markers:', error);
      return () => {};
    }
  }, 'dsh-prompt-library: typert manifest');

  // The session-layer prompt section. `text` is evaluated on every assembly, so
  // adding/removing a chip changes the very next request without touching the
  // registry. `interpolate: false` keeps a literal {{name}} in a user prompt
  // verbatim instead of failing assembly with "unknown prompt variable".
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolveSectionOrder(ctx.systemPrompt),
    interpolate: false,
    text: (context) => {
      const agent = context?.agent;
      if (agent === undefined || agent === null || agent.session === undefined) return '';
      return layers.sectionText(String(agent.session.id));
    }
  });

  // Layer lifetime (design §5.3, §9). The registry is process memory keyed by
  // session id, and NOTHING on the agent lifecycle may clear it:
  //
  //   - `agent/disposed` fires on every agent teardown, i.e. BETWEEN a user's
  //     two messages and on every compaction. Clearing there made a layer
  //     disappear from the next turn's system prompt while its chip stayed on
  //     screen (live evidence: turn 28 step 1 carried the layer at 09:52:49,
  //     step 2 at 09:53:45 did not, and no compaction happened in between).
  //   - `session/disposed` is not a session-close signal either: the agent loop
  //     enters + announces the session when a run is published and detaches it
  //     in that run's `finally`
  //     (…/@deepseek-ai/dsh-agent-loop/lib/index.js:1182-1186 ->
  //     sessions.enter/announce, :1146 detachSession), so it fires once per run
  //     exactly like `agent/disposed`.
  //   - The platform's whole session event surface is created / disposed /
  //     event / flush (the signature table …/@deepseek-ai/dsh-tool-cordis
  //     lists exactly those four) — there is no true session-close event to
  //     hook instead.
  //
  // So a layer lives until the DSH process restarts, or until the user removes
  // it through the Remote (`removeLayer` / `clearLayers`) — which is exactly
  // the requirements' contract: per-process, never persisted, user-owned off
  // switch. Do not reintroduce an agent/session teardown clear here.

  // Kept for the client's post-restart sanity read and for debugging.
  service.libraryPath = store.filePath;
}
