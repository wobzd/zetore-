import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fallback location (used when `npm install` cannot reach the network).
const FALLBACK_MODULES = "D:\\Project\\AI\\插件\\zotero-research-copilot\\node_modules";

async function loadModule(name, fallbackEntry) {
  try {
    return await import(name);
  }
  catch (err) {
    const fallbackPath = path.join(FALLBACK_MODULES, name, fallbackEntry);
    if (!fs.existsSync(fallbackPath)) {
      throw new Error(
        `Cannot load '${name}' from node_modules and fallback is missing: ${fallbackPath}\n${err}`
      );
    }
    console.log(`[build] '${name}' not installed locally -> using fallback: ${fallbackPath}`);
    return await import(pathToFileURL(fallbackPath).href);
  }
}

const esbuildMod = await loadModule("esbuild", "lib/main.js");
const esbuild = esbuildMod.build ? esbuildMod : esbuildMod.default;

const admZipMod = await loadModule("adm-zip", "adm-zip.js");
const AdmZip = admZipMod.default ?? admZipMod;

const contentDir = path.join(root, "content");
const scriptsDir = path.join(contentDir, "scripts");
const distDir = path.join(root, "dist");
const bundlePath = path.join(scriptsDir, "index.js");

fs.mkdirSync(scriptsDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

const t0 = Date.now();
await esbuild.build({
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "iife",
  globalName: "ZRA",
  platform: "neutral",
  target: "firefox140",
  legalComments: "none",
  sourcemap: false,
  logLevel: "warning",
});

const bundleBytes = fs.statSync(bundlePath).size;
if (!bundleBytes) {
  throw new Error(`Bundle is empty: ${bundlePath}`);
}
console.log(`[build] bundle ok: ${bundleBytes} bytes in ${Date.now() - t0} ms`);

const REQUIRED_FILES = [
  "manifest.json",
  "bootstrap.js",
  "content/scripts/index.js",
  "content/icons/icon16.svg",
  "content/icons/icon20.svg",
  "content/preferences.xhtml",
  "content/preferences.js",
  "content/preferences.css",
  "locale/en-US/zotero-reading-assistant.ftl",
  "locale/zh-CN/zotero-reading-assistant.ftl",
];

for (const rel of REQUIRED_FILES) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`Missing required file before packaging: ${rel}`);
  }
}

// Zotero 10 / Gecko 140 manifest validator requires all three fields:
// see Extension.sys.mjs:1874-1883 ("applications.zotero.update_url not provided"
// is fatal and surfaces as the generic "may not be compatible" install error).
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const zoteroBlock = sourceManifest.applications?.zotero;
const REQUIRED_ZOTERO_FIELDS = ["id", "update_url", "strict_max_version"];
const missingZoteroFields = REQUIRED_ZOTERO_FIELDS.filter((key) => !zoteroBlock?.[key]);
if (missingZoteroFields.length) {
  console.error(
    "[build] manifest.json is missing applications.zotero fields required by Zotero 10:",
    missingZoteroFields
  );
  process.exit(1);
}

const xpiPath = path.join(distDir, "zotero-reading-assistant.xpi");
if (fs.existsSync(xpiPath)) {
  fs.rmSync(xpiPath);
}

const zip = new AdmZip();
zip.addLocalFile(path.join(root, "manifest.json"));
zip.addLocalFile(path.join(root, "bootstrap.js"));
zip.addLocalFolder(contentDir, "content");
zip.addLocalFolder(path.join(root, "locale"), "locale");
zip.writeZip(xpiPath);

// Verify what actually landed inside the archive.
const verify = new AdmZip(xpiPath);
const entryNames = verify.getEntries().map((e) => e.entryName);
const missing = REQUIRED_FILES.filter((rel) => !entryNames.includes(rel));
const broken = verify
  .getEntries()
  .filter((e) => !e.isDirectory && e.header.size === 0)
  .map((e) => e.entryName);

if (missing.length) {
  console.error("[build] MISSING entries in XPI:", missing);
  process.exit(1);
}
if (broken.length) {
  console.error("[build] EMPTY entries in XPI:", broken);
  process.exit(1);
}

const manifest = JSON.parse(verify.readAsText("manifest.json"));
console.log("[build] XPI ->", xpiPath);
console.log("[build] size:", fs.statSync(xpiPath).size, "bytes");
console.log("[build] addon id:", manifest.applications?.zotero?.id);
console.log("[build] version:", manifest.version);
console.log("[build] entries:");
for (const name of entryNames) {
  console.log("  - " + name);
}
