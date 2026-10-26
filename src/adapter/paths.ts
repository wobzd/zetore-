import { jsonify } from "../util";

/**
 * Plugin-owned data directory. Lives under the Zotero data directory so it
 * follows the user's library location without hardcoding a machine path.
 */
export const DATA_DIR_NAME = "zotero-reading-assistant";

export function dataDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, DATA_DIR_NAME);
}

export function dataPath(...parts: string[]): string {
  return PathUtils.join(dataDir(), ...parts);
}

export async function ensureDir(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await IOUtils.readUTF8(path);
    return JSON.parse(text) as T;
  }
  catch (e) {
    return fallback;
  }
}

/**
 * Write to a sibling .tmp file and move it into place, so a crash mid-write
 * can never leave a truncated JSON file behind.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir(PathUtils.parent(path));
  const tmp = `${path}.tmp`;
  await IOUtils.writeUTF8(tmp, jsonify(data));
  await IOUtils.move(tmp, path);
}
