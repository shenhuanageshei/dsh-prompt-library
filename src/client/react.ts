/**
 * The client bundle's React face.
 *
 * The platform hands React to the plugin bundle as an external
 * (the `react` module id, resolved inside the ModuleLoader factory). Every client module
 * imports React and the hooks it needs from here, so the external surface is
 * declared in exactly one place.
 *
 * The namespace is typed `any` on purpose: the components build host-facing
 * React trees with `React.createElement` calls whose props (host CSS classes,
 * slot handles, DOM refs) are broader than @types/react's intrinsic-element
 * surface, and the plugin does not ship JSX. The values are the real React ones
 * at runtime; see tsdown.config.ts for the external list.
 */
import * as ReactRuntime from 'react';

/** The platform React namespace used by every client component. */
export const React: any = ReactRuntime;
/** `React.useState`, bound once for the components. */
export const useState: any = (ReactRuntime as any).useState;
/** `React.useRef`, bound once for the components. */
export const useRef: any = (ReactRuntime as any).useRef;
/** `React.useLayoutEffect`, bound once for the overlay measurement. */
export const useLayoutEffect: any = (ReactRuntime as any).useLayoutEffect;
