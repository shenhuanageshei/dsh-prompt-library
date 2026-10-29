/**
 * The wire-contract instance the client half reads.
 *
 * `defineContract` is the shared host/client factory (src/contract.ts); this
 * module binds it once to the platform Zod instance, so the client bundle needs
 * exactly one `zod` external. The bundle inlines both modules; the browser then
 * offers the same schemas/limits the host manifest declares.
 *
 * The namespace is normalized like the pre-tsdown bundle did: the web boot
 * facade may hand the plugin either the Zod namespace itself or a module record
 * carrying it under `default`, and both shapes must work.
 */
import * as zodModule from 'zod';
import { defineContract } from '../contract.js';

/** The platform Zod namespace (`z`) out of whatever module record we got. */
const z: any = (zodModule as any).z ?? (zodModule as any).default?.z ?? zodModule;

/** The `promptLibrary` wire contract every client module reads. */
export const contract = defineContract(z);
