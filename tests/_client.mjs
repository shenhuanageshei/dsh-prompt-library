/**
 * Load one client source module as flat-scope VM script text.
 *
 * The client half is TypeScript (`src/client/*.ts`) and ships as the tsdown
 * bundle, but the client unit tests still assemble individual modules in one
 * plain VM scope: the helpers they exercise (`planInsert`, `importOutcome`,
 * `visiblePrompts`, `ensureLayers` / the `layersReady` hydration set, ...) are
 * module-private, so a real ESM
 * import cannot reach them. Each file is therefore transpiled with the repo's
 * installed `typescript` package — `module: ESNext`, `target: ES2022` keeps the
 * source's own module shape, no CommonJS shim is emitted — and then flattened
 * for that shared scope:
 *
 *   - ESM `import ...;` statements are dropped: the assembler supplies the same
 *     binding either from an earlier module in the same scope (e.g.
 *     `promptMatches` from source.ts) or from a sandbox stub (`React`,
 *     `estimateTokens`, ...). A dangling import in a VM script is a
 *     SyntaxError, so this is the step that keeps the flat assembly possible;
 *   - the `export` keyword is stripped from declarations, because `export` is
 *     illegal in a plain script too.
 *
 * Types/interfaces are erased by the transpiler itself. Nothing is written to
 * disk and no source file is modified.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, 'src', 'client');

const typescriptModule = await import('typescript');
const ts = typescriptModule.default ?? typescriptModule;
if (typeof ts.transpileModule !== 'function') {
  throw new Error('the client tests need the TypeScript compiler (devDependency "typescript"); "transpileModule" is missing from the loaded module');
}

/** The `export` keyword in front of a declaration (ESM output keeps it). */
const EXPORT_DECLARATION = /^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gmu;

/**
 * Read one client source file verbatim (used by the locale key scan, which is a
 * true text scan over the module sources rather than an execution).
 * @param {string} name - module name without the `.ts` extension.
 * @returns {Promise<string>} the source text.
 */
export function readClientSource(name) {
  return readFile(join(CLIENT, name + '.ts'), 'utf8');
}

/**
 * Remove every ESM import declaration from transpiled output.
 * @param {string} text - transpiled module text.
 * @param {string} label - source label for error messages.
 * @returns {string} the text without import declarations.
 */
function stripImports(text, label) {
  const kept = [];
  let inImport = false;
  for (const line of text.split('\n')) {
    // A trailing line comment never terminates the statement; only code does.
    const code = line.replace(/\/\/.*$/u, '');
    if (inImport) {
      if (code.trimEnd().endsWith(';')) inImport = false;
      continue;
    }
    if (/^[ \t]*import\s/u.test(line)) {
      if (!code.trimEnd().endsWith(';')) inImport = true;
      continue;
    }
    kept.push(line);
  }
  if (inImport) throw new Error(label + ': an import declaration is not terminated by ";"');
  return kept.join('\n');
}

/**
 * Transpile one module text into a script that can share one VM scope.
 * @param {string} text - TypeScript source text.
 * @param {string} label - source label (shown by the compiler and in errors).
 * @returns {string} flat-scope script text.
 */
export function clientScript(text, label) {
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: label
  });
  const script = stripImports(outputText, label).replace(EXPORT_DECLARATION, '');
  const leftover = script.match(/^[ \t]*(?:import|export)\s/mu);
  if (leftover !== null) {
    throw new Error(label + ': module syntax survived flattening: ' + JSON.stringify(leftover[0]));
  }
  return script;
}

/**
 * Read + transpile one `src/client/<name>.ts` module.
 * @param {string} name - module name without the `.ts` extension.
 * @returns {Promise<string>} flat-scope script text.
 */
export async function transpileClientModule(name) {
  return clientScript(await readClientSource(name), 'src/client/' + name + '.ts');
}
