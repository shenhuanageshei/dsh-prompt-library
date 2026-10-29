/**
 * The `promptLibrary` wire contract, shared by the host Typert manifest
 * (src/host/typert.ts) and the client contribution (src/client/index.ts).
 * Every schema lives inside `defineContract(z)` so the single source of truth
 * can be inlined into the client bundle: the browser bundle has no module
 * loader for this package, so the tsdown build (design D5) inlines this module
 * into lib/client.js and re-binds `z` from the platform's static module map
 * (verified: the web boot facade exposes `zod` beside `react`). The host half
 * imports the same factory as plain ESM from lib/contract.js, emitted by
 * `tsc -p tsconfig.build.json`.
 *
 * Codec shape note: descriptors use `create: () => <zod schema>` because the
 * 0.2.1-rc.2 Typert registry validates strict codecs with
 * `typeof codec.create === 'function'`
 * (resources/app.asar!/dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js
 * -> validateCodec, as of 0.2.1-rc.2) and the API gateway decodes arguments
 * with `codec.create().parse(value)`
 * (…/dsh-api-gateway/lib/index.js -> decode, same as-of).
 *
 * @param {typeof import('zod').z} z - the platform Zod instance.
 */
export function defineContract(z) {
    /** Hard limits shared by host validation and client affordances (design §6.1). */
    const LIMITS = Object.freeze({
        /** Maximum prompt title length, in code units. */
        title: 80,
        /** Maximum prompt body length, in code units. */
        body: 20000,
        /** Maximum tags per prompt. */
        tags: 8,
        /** Maximum tag length, in code units. */
        tag: 40,
        /** Maximum prompts in one library. */
        prompts: 200,
        /** Maximum session system layers (design D1). */
        layers: 3
    });
    /**
     * Wire type symbol of the platform's strict SessionId codec (design §6.4:
     * `@deepseek-ai/dsh-session/types#SessionId`).
     */
    const SESSION_ID_WIRE_TYPE_SYMBOL = '@deepseek-ai/dsh-session/types#SessionId';
    /**
     * One session identity on the wire (the host keys layers by
     * `String(agent.session.id)`).
     *
     * Design §6.4 asks for the platform's strict SessionId codec. Verified on the
     * installed platform (0.2.1-rc.3): `@deepseek-ai/dsh-session/types` exports
     * the SessionId *brand* (a compile-time cast, no runtime work —
     * `lib/types/types.js: export function SessionId(id) { return brandString(id); }`)
     * and no exported zod codec object. The strict codec therefore exists as the
     * descriptor every platform-generated manifest declares for this type:
     * `{ mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
     * create: () => z.string() }` — see
     * …/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js
     * (fileReferences/list parameter 0) and
     * …/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js
     * (agentPresets/select parameter 0), both as of 0.2.1-rc.3.
     *
     * This contract now declares exactly that codec (`sessionParam` below), so
     * the wire identity of a session id is the platform's SessionId/string rather
     * than a package-local symbol. The schema mirrors the platform codec: a plain
     * `z.string()` (the platform generated schema carries no `.min(1)`). The host
     * still only ever feeds it `String(agent.session.id)`, which is never empty.
     */
    const sessionIdSchema = z.string();
    /** One stored prompt as it appears on the wire (never the raw file object). */
    const promptSchema = z.strictObject({
        id: z.string().min(1),
        title: z.string().min(1).max(LIMITS.title),
        body: z.string().min(1).max(LIMITS.body),
        tags: z.array(z.string().min(1).max(LIMITS.tag)).max(LIMITS.tags),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1)
    }).readonly();
    /** One create/update request; an empty `id` means "append a new prompt". */
    const promptInputSchema = z.strictObject({
        id: z.string().min(1).optional(),
        title: z.string().min(1).max(LIMITS.title),
        body: z.string().min(1).max(LIMITS.body),
        tags: z.array(z.string().min(1).max(LIMITS.tag)).max(LIMITS.tags)
    }).readonly();
    /** One prompt removal request. */
    const promptIdSchema = z.string().min(1);
    /**
     * The library snapshot every mutating call returns, so the client can replace
     * its store without a second round trip. `filePath` is display-only (settings
     * page shows the storage path read-only).
     */
    const librarySnapshotSchema = z.strictObject({
        prompts: z.array(promptSchema).max(LIMITS.prompts),
        updatedAt: z.string().nullable(),
        filePath: z.string().min(1),
        readOnly: z.boolean(),
        corruptBackup: z.string().nullable(),
        notice: z.string().nullable()
    }).readonly();
    /** One layer request: the body rides along so "edit layer" re-opens the edited text. */
    const layerInputSchema = z.strictObject({
        promptId: z.string().min(1),
        title: z.string().min(1).max(LIMITS.title),
        body: z.string().min(1).max(LIMITS.body)
    }).readonly();
    /** One session layer row on the wire (design §6.4 plus `body`, needed by FR-6 re-edit). */
    const layerViewSchema = z.strictObject({
        promptId: z.string().min(1),
        title: z.string().min(1),
        body: z.string(),
        tokens: z.number().int().min(0)
    }).readonly();
    /** One session's layer snapshot (order = insertion order). */
    const layerSnapshotSchema = z.strictObject({
        layers: z.array(layerViewSchema).max(LIMITS.layers),
        totalTokens: z.number().int().min(0),
        limit: z.number().int().min(1)
    }).readonly();
    /** One import request; `text` is the raw file content so the host can report an invalid-entry count. */
    const importRequestSchema = z.strictObject({
        mode: z.enum(['replace', 'merge']),
        text: z.string().max(4 * 1024 * 1024)
    }).readonly();
    /** One import outcome appended to the library snapshot. */
    const importResultSchema = z.strictObject({
        imported: z.number().int().min(0),
        replaced: z.boolean()
    }).readonly();
    /** Strict codec factory used by every descriptor (see the file header). */
    const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema });
    /** One wire parameter of the given kind. */
    const param = (name, schema, typeSymbol) => ({
        name,
        wire: name,
        source: 'json',
        codec: strict(`dsh-prompt-library#${typeSymbol}`, schema)
    });
    /**
     * One session-identity parameter, carrying the platform's strict SessionId
     * codec (design §6.4) instead of the package-local symbol `param` builds.
     * @param {string} name - wire parameter name.
     * @returns {object} wire parameter descriptor.
     */
    const sessionParam = (name) => ({
        name,
        wire: name,
        source: 'json',
        codec: strict(SESSION_ID_WIRE_TYPE_SYMBOL, sessionIdSchema)
    });
    /** Result descriptor of one invocation. */
    const result = (schema, typeSymbol) => strict(`dsh-prompt-library#${typeSymbol}`, schema);
    /**
     * The `promptLibrary` Remote namespace's strict invocation descriptors.
     * Endpoint ids are `dsh-prompt-library#promptLibrary/<method>`.
     */
    const INVOCATIONS = [
        {
            id: 'dsh-prompt-library#promptLibrary/list',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'list',
            invocation: { kind: 'direct' },
            parameters: [],
            result: result(librarySnapshotSchema, 'LibrarySnapshot')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/save',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'save',
            invocation: { kind: 'direct' },
            parameters: [param('input', promptInputSchema, 'PromptInput')],
            result: result(librarySnapshotSchema, 'LibrarySnapshot')
        },
        {
            // Wire name `removePrompt`, never `remove`: the client gateway rejects a
            // Remote method that collides with RemoteNamespaceService.prototype
            // (`remove(kind, method, token)`, @deepseek-ai/dsh-api-gateway/lib/client.browser.js:1957-1958
            // and :2012 as of 0.2.1-rc.3), which made the whole `$mount` fail.
            // Guarded by tests/gateway-reserved.test.mjs.
            id: 'dsh-prompt-library#promptLibrary/removePrompt',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'removePrompt',
            invocation: { kind: 'direct' },
            parameters: [param('id', promptIdSchema, 'PromptId')],
            result: result(librarySnapshotSchema, 'LibrarySnapshot')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/importLibrary',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'importLibrary',
            invocation: { kind: 'direct' },
            parameters: [param('request', importRequestSchema, 'ImportRequest')],
            result: result(importResultSchema, 'ImportResult')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/layers',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'layers',
            invocation: { kind: 'direct' },
            parameters: [sessionParam('sessionId')],
            result: result(layerSnapshotSchema, 'LayerSnapshot')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/addLayer',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'addLayer',
            invocation: { kind: 'direct' },
            parameters: [
                sessionParam('sessionId'),
                param('input', layerInputSchema, 'LayerInput')
            ],
            result: result(layerSnapshotSchema, 'LayerSnapshot')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/removeLayer',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'removeLayer',
            invocation: { kind: 'direct' },
            parameters: [
                sessionParam('sessionId'),
                param('promptId', promptIdSchema, 'PromptId')
            ],
            result: result(layerSnapshotSchema, 'LayerSnapshot')
        },
        {
            id: 'dsh-prompt-library#promptLibrary/clearLayers',
            service: 'promptLibrary',
            namespace: 'promptLibrary',
            method: 'clearLayers',
            invocation: { kind: 'direct' },
            parameters: [sessionParam('sessionId')],
            result: result(layerSnapshotSchema, 'LayerSnapshot')
        }
    ];
    return {
        LIMITS,
        SESSION_ID_WIRE_TYPE_SYMBOL,
        sessionIdSchema,
        promptSchema,
        promptInputSchema,
        promptIdSchema,
        librarySnapshotSchema,
        layerInputSchema,
        layerViewSchema,
        layerSnapshotSchema,
        importRequestSchema,
        importResultSchema,
        INVOCATIONS
    };
}
