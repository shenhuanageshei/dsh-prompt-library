/**
 * Resolve the platform Zod instance without a network install.
 *
 * Order:
 *   1. a normal bare import (used once the package has its own node_modules);
 *   2. $DSH_PROMPT_LIBRARY_ZOD, when the caller points at a specific build;
 *   3. the installed desktop profile copy
 *      (C:\Users\<user>\.dsh\profiles\desktop\node_modules\zod\index.js).
 *
 * The profile path is not committed anywhere: it is derived from $DSH_HOME (or
 * ~/.dsh), so a different machine/profile keeps working by exporting DSH_HOME or
 * DSH_PROMPT_LIBRARY_ZOD. Nothing here writes to disk.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Pick the Zod namespace out of an ESM module record. */
function pickZod(module) {
  const candidate = module?.z ?? module?.default?.z ?? module?.default;
  return typeof candidate?.strictObject === 'function' ? candidate : undefined;
}

/** @returns {Promise<object>} the Zod namespace (the same shape defineContract expects). */
export async function loadZod() {
  const tried = [];
  try {
    const z = pickZod(await import('zod'));
    if (z !== undefined) return z;
    tried.push('bare "zod" import has no z export');
  } catch (error) {
    tried.push('bare "zod" import failed (' + (error?.code ?? 'error') + ')');
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const candidates = [];
  if (typeof process.env.DSH_PROMPT_LIBRARY_ZOD === 'string' && process.env.DSH_PROMPT_LIBRARY_ZOD !== '') {
    candidates.push(process.env.DSH_PROMPT_LIBRARY_ZOD);
  }
  candidates.push(join(home, 'profiles', 'desktop', 'node_modules', 'zod', 'index.js'));
  for (const file of candidates) {
    if (!existsSync(file)) {
      tried.push('missing ' + file);
      continue;
    }
    const z = pickZod(await import(pathToFileURL(file).href));
    if (z !== undefined) return z;
    tried.push('no z export in ' + file);
  }
  throw new Error('zod is required by the contract tests but could not be resolved: ' + tried.join('; '));
}
