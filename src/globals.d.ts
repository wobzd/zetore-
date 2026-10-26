/*
 * Ambient declarations for the Zotero plugin sandbox.
 * The bundle is loaded via Services.scriptloader.loadSubScript() into a
 * system-principal sandbox, so these globals exist at runtime but are not
 * visible to TypeScript. They are intentionally typed as `any`: the plugin is
 * validated against the real Zotero runtime, not against static types.
 */

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const ChromeUtils: any;
declare const Components: any;

declare function setTimeout(callback: () => void, delay?: number): number;
declare function clearTimeout(id: number): void;
