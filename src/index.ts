import { Plugin } from "./plugin";

const plugin = new Plugin();

// bootstrap.js reads this after loadSubScript(); the bundle is evaluated in the
// same sandbox, so assigning onto the shared Zotero object is the simplest way
// to hand the instance across the two script scopes.
Zotero.__ZRA = plugin;

export { plugin };
export default plugin;
