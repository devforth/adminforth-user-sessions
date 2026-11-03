import type { SessionNonce } from "./types.js";

// a request sent before the browser got the new value may come after one sent with it, e.g. a slow upload
const PREVIOUS_NONCE_GRACE_MS = 60 * 1000;

export interface NonceCheck {
  /** State to store, the same object when nothing changed. */
  nonce: SessionNonce;
  /** The browser should be given `nonce.current`. */
  sendCookie: boolean;
}

export function createNonce(): SessionNonce {
  return { current: crypto.randomUUID(), current_seen_at: null, previous: null, next: crypto.randomUUID() };
}

function rotate(nonce: SessionNonce, seenAt: string | null): SessionNonce {
  return { current: nonce.next, current_seen_at: seenAt, previous: nonce.current, next: crypto.randomUUID() };
}

/**
 * Checks the nonce cookie of a request against the stored state of its session.
 * Returns null when the cookie can only come from a copy of the session made in another browser.
 */
export function checkNonce(nonce: SessionNonce, cookie: string | null, now: Date, rotationIntervalMs: number): NonceCheck | null {
  const seenAt = nonce.current_seen_at ? Date.parse(nonce.current_seen_at) : null;

  if (cookie === nonce.current) {
    if (seenAt === null) {
      return { nonce: { ...nonce, current_seen_at: now.toISOString() }, sendCookie: false };
    }
    if (now.getTime() - seenAt >= rotationIntervalMs) {
      return { nonce: rotate(nonce, null), sendCookie: true };
    }
    return { nonce, sendCookie: false };
  }

  if (cookie === nonce.next) {
    // the browser got a rotation, then a parallel request which read the session before it wrote the old state back
    return { nonce: rotate(nonce, now.toISOString()), sendCookie: false };
  }

  if (cookie && cookie === nonce.previous) {
    if (seenAt === null) {
      // the response with the current value didn't reach the browser, e.g. the request was aborted
      return { nonce, sendCookie: true };
    }
    if (now.getTime() - seenAt < PREVIOUS_NONCE_GRACE_MS) {
      return { nonce, sendCookie: false };
    }
  }

  return null;
}
