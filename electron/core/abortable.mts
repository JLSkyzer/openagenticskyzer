// A wait that a stop cuts short: the caller is released at once, the work itself keeps running to its own end
// (a native load cannot be interrupted midway; it sees its own signal and cleans up behind).

/** `promise`, or `signal.reason` as soon as `signal` aborts, whichever comes first. No signal: `promise` itself.
 * An already aborted signal rejects at once. The abort listener is removed once settled; a rejection of `promise`
 * after the abort is handled here, never left unhandled. */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
