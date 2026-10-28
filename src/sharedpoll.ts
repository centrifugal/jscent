// Signatures for shared poll subscriptions.
//
// See https://centrifugal.dev/docs/server/shared_poll. Shared poll
// subscriptions are experimental in Centrifugo, and this module follows their
// changes.

/** What sign takes. */
export interface SignOptions {
  /** The ID of the connection's user; empty for an anonymous one. */
  user: string;
  /** The shared poll channel. */
  channel: string;
  /** The keys the signature covers, exactly and in their order. */
  keys: readonly string[];
  /** When the signature expires; unset for one which does not. */
  expiresAt?: Date;
}

/**
 * The signature authorizing a user to track keys in a channel until
 * expiresAt, as Centrifugo verifies it: "iat:exp:hmac", iat now and exp
 * expiresAt in Unix seconds - 0 without expiresAt, for a signature which does
 * not expire. secret is Centrifugo's shared_poll.hmac_secret_key.
 *
 * The signature covers exactly keys, in their order: a client tracking other
 * keys, or the same in another order, is refused.
 *
 * ```ts
 * await sign(secret, { user: '42', channel: 'poll:prices', keys: ['AAPL'], expiresAt });
 * ```
 */
export function sign(secret: string | Uint8Array, options: SignOptions): Promise<string> {
  return signAt(secret, options, Math.floor(Date.now() / 1000));
}

/** @internal sign, at the Unix time now: for the spec's test vectors. */
export async function signAt(secret: string | Uint8Array, options: SignOptions, now: number): Promise<string> {
  const s = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (s.byteLength === 0) {
    throw new TypeError('sharedpoll: empty secret');
  }
  const { user, channel, keys, expiresAt } = options;
  if (typeof user !== 'string' || typeof channel !== 'string' || !Array.isArray(keys)) {
    throw new TypeError('sharedpoll: user and channel are strings, keys an array of strings');
  }
  let exp = '0';
  if (expiresAt !== undefined) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new TypeError('sharedpoll: expiresAt must be a valid Date');
    }
    exp = String(Math.floor(expiresAt.getTime() / 1000));
  }
  const iat = String(now);
  const enc = new TextEncoder();
  const keysHash = toHex(await crypto.subtle.digest('SHA-256', enc.encode(keys.join('\0'))));
  // NUL-separated, so that a colon in a user or channel cannot move between
  // fields: ("alice", "news:tech") and ("alice:news", "tech") sign differently.
  const key = await crypto.subtle.importKey('raw', s as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = toHex(await crypto.subtle.sign('HMAC', key, enc.encode([iat, exp, user, channel, keysHash].join('\0'))));
  return `${iat}:${exp}:${mac}`;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
