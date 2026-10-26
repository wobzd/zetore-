/**
 * Small cancellation primitive shared by the reader UI and the AI layer.
 *
 * The UI owns the token (it knows when the user clicks "stop" or closes the
 * popup); the provider subscribes and aborts the underlying XHR. A plain
 * object is used instead of AbortController so the token can cross the reader
 * iframe / plugin sandbox boundary without relying on DOM type definitions.
 */
export interface CancelToken {
  readonly cancelled: boolean;
  cancel: () => void;
  onCancel: (listener: () => void) => () => void;
}

export function createCancelToken(): CancelToken {
  let cancelled = false;
  const listeners = new Set<() => void>();

  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      const pending = Array.from(listeners);
      listeners.clear();
      for (const listener of pending) {
        try {
          listener();
        }
        catch (e) {
          // Cancellation listeners are best-effort; one bad listener must not
          // prevent the XHR from being aborted.
        }
      }
    },
    onCancel(listener: () => void) {
      if (cancelled) {
        try {
          listener();
        }
        catch (e) {
          // Same as above: the caller is already cancelled.
        }
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
