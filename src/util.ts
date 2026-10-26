export function debug(msg: string): void {
  try {
    Zotero.debug("[ZRA] " + msg);
  }
  catch (e) {
    // Nothing sensible to do if Zotero.debug itself is unavailable.
  }
}

export function errorLog(err: unknown): void {
  try {
    Zotero.logError(err);
  }
  catch (e) {
    debug("logError failed: " + errText(err));
  }
}

export function errText(err: unknown): string {
  if (!err) {
    return String(err);
  }
  if (typeof err === "object" && err !== null) {
    const anyErr = err as { name?: string; message?: string; stack?: string };
    if (typeof anyErr.message === "string" && anyErr.message) {
      return `${anyErr.name || "Error"}: ${anyErr.message}`;
    }
  }
  return String(err);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Registration failures are otherwise invisible: Zotero's plugin API returns
 * false (or we swallow an exception) and the UI simply doesn't appear. Keep
 * the reason so the self-check report can explain it.
 */
export const registrationErrors: Array<{ fn: string; error: string; at: string }> = [];

export function recordRegistrationError(fn: string, err: unknown): void {
  registrationErrors.push({ fn, error: errText(err), at: nowIso() });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms: ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * JSON.stringify that never throws on cycles or non-serializable values.
 * The report is consumed by a human reading a JSON file, so losing exotic
 * values is preferable to failing the self-check.
 */
export function jsonify(value: unknown): string {
  // Track the current ancestor chain only. A global "seen" set would label
  // every repeated reference (e.g. the same sample object in two checks) as
  // "[circular]", which made the report misleading.
  const ancestors = new WeakSet<object>();
  const walk = (val: any): any => {
    if (typeof val === "function") {
      return `[function ${val.name || "anonymous"}]`;
    }
    if (typeof val === "bigint") {
      return `${val.toString()}n`;
    }
    if (val && typeof val === "object") {
      if (ancestors.has(val)) {
        return "[circular]";
      }
      ancestors.add(val);
      let out: any;
      if (Array.isArray(val)) {
        out = val.map(walk);
      }
      else {
        out = {};
        for (const key of Object.keys(val)) {
          out[key] = walk(val[key]);
        }
      }
      ancestors.delete(val);
      return out;
    }
    return val;
  };
  return JSON.stringify(walk(value), null, 2);
}
