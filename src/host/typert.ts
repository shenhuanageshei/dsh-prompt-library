/**
 * The hand-written host Typert manifest for the `promptLibrary` Remote.
 *
 * Registered through `ctx.typert.register` in the plugin body. It claims the
 * wire endpoints through the strict registry — the same path generated
 * `./typert` artifacts use — so the Host Gateway resolves the calls without
 * consulting the `@Remote` marker table (the marker table is registered too,
 * see src/host/service.js: it is the source-mode fallback the gateway uses
 * when a strict definition is absent).
 *
 * As-of reference: the gateway prefers `ctx.typert.local.get(endpoint)` and
 * falls back to source-mode discovery
 * (resources/app.asar!/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js
 * -> resolveDescriptor, 0.2.1-rc.2).
 */

/**
 * Build the `TypertContribution` for this package.
 * @param {object} contract - the wire contract from `defineContract`.
 * @returns {object} the manifest passed to `ctx.typert.register`.
 */
export function buildManifest(contract) {
  return {
    package: 'dsh-prompt-library',
    face: 'host',
    schemas: [],
    model: {
      services: [
        {
          key: 'promptLibrary',
          exportName: 'PromptLibraryService',
          description: 'Prompt library storage, import/export, and per-session system-prompt layers.',
          tags: [],
          members: [
            { kind: 'method', name: 'list', signature: 'list(): Promise<LibrarySnapshot>' },
            {
              kind: 'method',
              name: 'save',
              signature: 'save(input: PromptInput): Promise<LibrarySnapshot>'
            },
            { kind: 'method', name: 'removePrompt', signature: 'removePrompt(id: PromptId): Promise<LibrarySnapshot>' },
            {
              kind: 'method',
              name: 'importLibrary',
              signature: 'importLibrary(request: ImportRequest): Promise<ImportResult>'
            },
            {
              kind: 'method',
              name: 'layers',
              signature: 'layers(sessionId: SessionId): Promise<LayerSnapshot>'
            },
            {
              kind: 'method',
              name: 'addLayer',
              signature: 'addLayer(sessionId: SessionId, input: LayerInput): Promise<LayerSnapshot>'
            },
            {
              kind: 'method',
              name: 'removeLayer',
              signature: 'removeLayer(sessionId: SessionId, promptId: PromptId): Promise<LayerSnapshot>'
            },
            {
              kind: 'method',
              name: 'clearLayers',
              signature: 'clearLayers(sessionId: SessionId): Promise<LayerSnapshot>'
            }
          ],
          types: [],
        }
      ],
      events: [],
      objects: []
    },
    invocations: contract.INVOCATIONS
  };
}
