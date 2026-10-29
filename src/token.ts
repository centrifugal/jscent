// Tokens: connection and subscription tokens for client SDKs, the JSON Web Key
// Set Centrifugo verifies them with, and Centrifugo PRO's server API tokens.
// Signed with Web Crypto, in every runtime jscent supports.

import type { FilterNode, SubscribeOptionOverride } from './generated/api.ts';
import { FilterNodeFields, SubscribeOptionOverrideFields } from './generated/api.ts';
import { checkKeys } from './options.ts';
import { encodePayload } from './payload.ts';
import { encode, kindOf } from './wire.ts';

/**
 * An expiry chosen to be never - always explicitly: for expiresAt, a token
 * accepted forever, and forever once leaked; for connectionExpiresAt and
 * subscriptionExpiresAt, a connection or subscription which never expires.
 */
export const NEVER: unique symbol = Symbol('jscent.never');

/** An expiry: a time, or NEVER. */
export type Expiry = Date | typeof NEVER;

const subtle = globalThis.crypto.subtle;

type Signer = (data: Uint8Array) => Promise<Uint8Array>;

// OIDs in a PKCS #8 key, to tell its algorithm.
const OID_RSA = '2a864886f70d010101';
const OID_EC = '2a8648ce3d0201';
const OID_ED25519 = '2b6570';
const EC_CURVES: Record<string, [alg: string, crv: string, hash: string]> = {
  '2a8648ce3d030107': ['ES256', 'P-256', 'SHA-256'],
  '2b81040022': ['ES384', 'P-384', 'SHA-384'],
  '2b81040023': ['ES512', 'P-521', 'SHA-512'],
};
// The DER prefix of an Ed25519 private key in PKCS #8, before its 32-byte seed.
const ED25519_PKCS8_PREFIX = hex('302e020100300506032b657004220420');

/**
 * A key signing tokens, matching the one Centrifugo verifies with. Make one
 * with Key.hmac, Key.fromPem, Key.fromJwk or Key.ed25519.
 */
export class Key {
  /** The JWS algorithm: HS256, RS256, ES256, ES384, ES512 or EdDSA. */
  readonly alg: string;
  /** The key ID written as the tokens' "kid", if set. */
  readonly kid: string;
  readonly #sign: Signer;
  readonly #jwk: JsonWebKey | undefined;

  /** @internal */
  constructor(alg: string, sign: Signer, jwk: JsonWebKey | undefined, kid = '') {
    this.alg = alg;
    this.kid = kid;
    this.#sign = sign;
    this.#jwk = jwk;
  }

  /**
   * The key, with `kid` as the "kid" of the tokens it signs: the ID of its
   * public key in the JWKS Centrifugo verifies with. Never give the ID of a key
   * to another: Centrifugo caches keys by ID, and would refuse the other key's
   * tokens until its cache expires.
   */
  withKeyId(kid: string): Key {
    if (typeof kid !== 'string' || kid === '') {
      throw new TypeError('token: a key ID must be a non-empty string');
    }
    return new Key(this.alg, this.#sign, this.#jwk, kid);
  }

  /** A key signing with HS256 and secret: Centrifugo's client.token.hmac_secret_key. */
  static hmac(secret: string | Uint8Array): Key {
    const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
    if (bytes.byteLength === 0) {
      throw new TypeError('token: empty HMAC secret');
    }
    const key = subtle.importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Key(
      'HS256',
      async (data) => new Uint8Array(await subtle.sign('HMAC', await key, data as BufferSource)),
      undefined,
    );
  }

  /**
   * The key of a PEM-encoded PKCS #8 private key ("BEGIN PRIVATE KEY") - RSA
   * (RS256), ECDSA on P-256, P-384 or P-521 (ES256, ES384, ES512), or Ed25519
   * (EdDSA). Convert an older "BEGIN RSA PRIVATE KEY" or "BEGIN EC PRIVATE
   * KEY" with `openssl pkcs8 -topk8 -nocrypt`.
   */
  static async fromPem(pem: string): Promise<Key> {
    const m = /-----BEGIN ([A-Z ]+)-----([^-]+)-----END \1-----/.exec(pem);
    if (m === null) {
      throw new TypeError('token: not a PEM key');
    }
    if (m[1] !== 'PRIVATE KEY') {
      throw new TypeError(
        `token: a "${m[1]}" PEM: convert it to PKCS #8 ("BEGIN PRIVATE KEY") with openssl pkcs8 -topk8 -nocrypt`,
      );
    }
    const der = Uint8Array.from(atob(m[2]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    const oids = derOids(der);
    if (oids.includes(OID_RSA)) {
      return Key.#asymmetric(
        'RS256',
        der,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        { name: 'RSASSA-PKCS1-v1_5' },
      );
    }
    if (oids.includes(OID_EC)) {
      const curve = oids.map((o) => EC_CURVES[o]).find((c) => c !== undefined);
      if (curve === undefined) {
        throw new TypeError('token: an ECDSA key on another curve than P-256, P-384 or P-521');
      }
      const [alg, crv, hash] = curve;
      return Key.#asymmetric(alg, der, { name: 'ECDSA', namedCurve: crv }, { name: 'ECDSA', hash });
    }
    if (oids.includes(OID_ED25519)) {
      return Key.#asymmetric('EdDSA', der, { name: 'Ed25519' }, { name: 'Ed25519' });
    }
    throw new TypeError('token: unsupported private key type: want RSA, ECDSA or Ed25519');
  }

  /**
   * The key of a private JSON Web Key - RSA, EC on P-256, P-384 or P-521, or
   * OKP Ed25519 - as Key.fromPem makes it.
   */
  static async fromJwk(jwk: JsonWebKey): Promise<Key> {
    if (jwk.d === undefined) {
      throw new TypeError('token: the JWK has no private part ("d")');
    }
    if (jwk.kty === 'RSA') {
      const k = await subtle.importKey(
        'jwk',
        { ...jwk, alg: 'RS256' },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        true,
        ['sign'],
      );
      return Key.#fromCryptoKey('RS256', k, { name: 'RSASSA-PKCS1-v1_5' });
    }
    if (jwk.kty === 'EC') {
      const curve = Object.values(EC_CURVES).find(([, crv]) => crv === jwk.crv);
      if (curve === undefined) {
        throw new TypeError(`token: ECDSA curve ${jwk.crv}, want P-256, P-384 or P-521`);
      }
      const [alg, crv, hash] = curve;
      const k = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: crv }, true, ['sign']);
      return Key.#fromCryptoKey(alg, k, { name: 'ECDSA', hash });
    }
    if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
      const k = await subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['sign']);
      return Key.#fromCryptoKey('EdDSA', k, { name: 'Ed25519' });
    }
    throw new TypeError('token: unsupported JWK: want RSA, EC or OKP Ed25519');
  }

  /**
   * A key signing with EdDSA from a 32-byte Ed25519 seed, whose public key is
   * Centrifugo's client.token.ed25519_public_key (Centrifugo v6.10.2+), or is
   * published in its JWKS.
   */
  static async ed25519(seed: Uint8Array): Promise<Key> {
    if (!(seed instanceof Uint8Array) || seed.byteLength !== 32) {
      throw new TypeError('token: an Ed25519 seed is 32 bytes');
    }
    const der = new Uint8Array(48);
    der.set(ED25519_PKCS8_PREFIX);
    der.set(seed, 16);
    return Key.#asymmetric('EdDSA', der, { name: 'Ed25519' }, { name: 'Ed25519' });
  }

  static async #asymmetric(
    alg: string,
    pkcs8: Uint8Array,
    importAlg: RsaHashedImportParams | EcKeyImportParams | Algorithm,
    signAlg: AlgorithmIdentifier | EcdsaParams,
  ): Promise<Key> {
    const k = await subtle.importKey('pkcs8', pkcs8 as BufferSource, importAlg, true, ['sign']);
    return Key.#fromCryptoKey(alg, k, signAlg);
  }

  static async #fromCryptoKey(alg: string, key: CryptoKey, signAlg: AlgorithmIdentifier | EcdsaParams): Promise<Key> {
    const priv = await subtle.exportKey('jwk', key);
    // The public part only: what a JWKS publishes.
    const jwk: JsonWebKey = { kty: priv.kty };
    for (const f of ['n', 'e', 'crv', 'x', 'y'] as const) {
      if (priv[f] !== undefined) {
        jwk[f] = priv[f];
      }
    }
    return new Key(alg, async (data) => new Uint8Array(await subtle.sign(signAlg, key, data as BufferSource)), jwk);
  }

  /** @internal */
  sign(data: Uint8Array): Promise<Uint8Array> {
    return this.#sign(data);
  }

  /** @internal The public key as a JSON Web Key; undefined for HMAC. */
  get jwk(): JsonWebKey | undefined {
    return this.#jwk;
  }
}

/**
 * Operations granted in channels: a connection may do an operation in a channel
 * when any of its capabilities allows the operation and matches the channel.
 * Centrifugo PRO only.
 */
export interface ChannelsCapability {
  /** The channels, or channel patterns, it applies to. */
  channels?: readonly string[];
  /** The operations: "sub" (subscribe), "pub" (publish), "hst" (history), "prs" (presence). */
  allow?: readonly string[];
  /** How channels are matched: empty for exact names, "wildcard" or "regex". */
  match?: string;
}

/** The options of a server-side subscription in ConnectionClaims.subs. */
export interface SubscribeOptions {
  /** Channel-specific information about the connection. */
  info?: unknown;
  /** Binary info in base64, instead of info. */
  b64info?: string;
  /** Sent to the client with the subscription. */
  data?: unknown;
  /** Binary data in base64, instead of data. */
  b64data?: string;
  /** Channel options of the namespace overridden for this subscription. */
  override?: SubscribeOptionOverride;
  /**
   * Only publications whose tags match it are delivered. Centrifugo PRO only,
   * which refuses a malformed filter: the subscription fails.
   */
  serverTagsFilter?: FilterNode;
}

/** The claims of a connection token. See https://centrifugal.dev/docs/server/authentication. */
export interface ConnectionClaims {
  /** The ID of the connection's user: the "sub" claim. Empty for an anonymous connection. */
  user?: string;
  /**
   * Until when the token is accepted: the "exp" claim, or NEVER for a token
   * accepted forever - and forever once leaked, for a trusted service's own
   * connection, say. Required. The connection expires then too, unless
   * connectionExpiresAt says otherwise: Centrifugo asks the client for a new
   * token, and closes the connection without one.
   */
  expiresAt: Expiry;
  /**
   * When set, when the connection expires instead of at expiresAt: the
   * "expire_at" claim. NEVER makes the connection never expire - Centrifugo
   * never asks for a new token - while expiresAt still bounds when the token
   * is accepted, on reconnects too. Most applications leave it unset.
   */
  connectionExpiresAt?: Expiry;
  /** The "iat" claim; now when unset. */
  issuedAt?: Date;
  /** The "jti" claim, for Centrifugo PRO's token revocation. */
  id?: string;
  /** The "aud" claim: client.token.audience. */
  audience?: string;
  /** The "iss" claim: client.token.issuer. */
  issuer?: string;
  /** Information about the connection: in presence, join and leave events, and the client's publications. */
  info?: unknown;
  /** Binary info in base64, instead of info. */
  b64info?: string;
  /** Server-side channels to subscribe the connection to. */
  channels?: readonly string[];
  /**
   * Server-side channels to subscribe the connection to, each with its
   * options. Set channels or subs, not both: Centrifugo ignores channels when
   * subs is set.
   */
  subs?: Record<string, SubscribeOptions>;
  /**
   * Custom data attached to the connection. Not visible to other clients -
   * Centrifugo never sends it - but the token carries it, visible to the user
   * owning the token: put nothing in it that user must not see.
   */
  meta?: unknown;
  /** Capabilities granting the connection operations in channels. Centrifugo PRO only. */
  caps?: readonly ChannelsCapability[];
  /**
   * The connection's client labels: for metrics, targeted server API calls
   * and CEL expressions. Centrifugo PRO only.
   */
  labels?: Record<string, string>;
}

/** The claims of a subscription token. See https://centrifugal.dev/docs/server/channel_token_auth. */
export interface SubscriptionClaims {
  /** The ID of the connection's user: the "sub" claim. */
  user?: string;
  /** The channel the token allows to subscribe to. Required. */
  channel: string;
  /**
   * Until when the token is accepted: the "exp" claim, or NEVER. Required. The
   * subscription expires then too, unless subscriptionExpiresAt says
   * otherwise.
   */
  expiresAt: Expiry;
  /**
   * When set, when the subscription expires instead of at expiresAt: the
   * "expire_at" claim. NEVER makes it never expire, while expiresAt still
   * bounds when the token is accepted: with a short expiresAt, a token which
   * subscribes once.
   */
  subscriptionExpiresAt?: Expiry;
  /** The "iat" claim; now when unset. */
  issuedAt?: Date;
  /** The "jti" claim, for Centrifugo PRO's token revocation. */
  id?: string;
  /** The "aud" claim. */
  audience?: string;
  /** The "iss" claim. */
  issuer?: string;
  /** Channel-specific information about the connection. */
  info?: unknown;
  /** Binary info in base64, instead of info. */
  b64info?: string;
  /** Sent to the client in the subscribe reply. */
  data?: unknown;
  /** Binary data in base64, instead of data. */
  b64data?: string;
  /** Channel options of the namespace overridden for this subscription. */
  override?: SubscribeOptionOverride;
  /** Capabilities in the channel besides subscribing: "pub", "hst", "prs". Centrifugo PRO only. */
  allow?: readonly string[];
  /** Only publications whose tags match it are delivered. Centrifugo PRO only. */
  serverTagsFilter?: FilterNode;
}

/**
 * The claims of a token authenticating calls to Centrifugo PRO's server API,
 * verified with the keys of http_api.jwks.endpoint. See
 * https://centrifugal.dev/docs/pro/server_api_enhancements.
 *
 * A token passing Centrifugo PRO's checks can call every API method, and it
 * checks only what it is configured to: the signature by any key of the JWKS
 * endpoint, and audience, issuer and scope only when http_api.jwks sets them.
 * So the token must carry a claim no other token carries - above all the
 * connection and subscription tokens users hold:
 *
 * - sign API tokens with keys of their own, published at their own JWKS
 *   endpoint - never the one of client.token.jwks_public_endpoint;
 * - set audience, scope or both, to values only API tokens carry, and
 *   configure http_api.jwks.audience and scope to require them. api refuses
 *   claims with neither.
 */
export interface ApiClaims {
  /** The "aud" claim: http_api.jwks.audience. */
  audience?: string;
  /** The "scope" claim, its scopes joined by spaces: http_api.jwks.scope is one of them. */
  scope?: readonly string[];
  /** The "iss" claim: http_api.jwks.issuer. */
  issuer?: string;
  /** The "sub" claim: who calls the API, for the application's own logs. */
  subject?: string;
  /**
   * When the token expires: required, best minutes ahead. Centrifugo PRO would
   * accept a token without "exp" for as long as its key is published, so api
   * never signs one. ApiTokens sets it itself.
   */
  expiresAt?: Date;
  /** The "iat" claim; now when unset. */
  issuedAt?: Date;
  /** The "jti" claim. */
  id?: string;
}

// The keys of the claims types, and their JWT names - which the claims are
// not named by - for a hint.
const COMMON_CLAIMS = ['user', 'expiresAt', 'issuedAt', 'id', 'audience', 'issuer', 'info', 'b64info'] as const;
const CONNECTION_CLAIMS = [
  ...COMMON_CLAIMS,
  'connectionExpiresAt',
  'channels',
  'subs',
  'meta',
  'caps',
  'labels',
] as const;
const SUBSCRIPTION_CLAIMS = [
  ...COMMON_CLAIMS,
  'channel',
  'subscriptionExpiresAt',
  'data',
  'b64data',
  'override',
  'allow',
  'serverTagsFilter',
] as const;
const API_CLAIMS = ['audience', 'scope', 'issuer', 'subject', 'expiresAt', 'issuedAt', 'id'] as const;
const WIRE_NAMES: Readonly<Record<string, string>> = {
  sub: 'user',
  exp: 'expiresAt',
  iat: 'issuedAt',
  jti: 'id',
  aud: 'audience',
  iss: 'issuer',
};

/** A connection token with claims, signed with key. */
export async function connection(key: Key, claims: ConnectionClaims): Promise<string> {
  const c = claims;
  checkKeys(c, CONNECTION_CLAIMS, 'connection claim', (m) => new TypeError(`token: ${m}`), {
    ...WIRE_NAMES,
    expire_at: 'connectionExpiresAt',
    expireAt: 'connectionExpiresAt',
  });
  if (c.channels?.length && c.subs && Object.keys(c.subs).length > 0) {
    throw new TypeError('token: set channels or subs, not both: Centrifugo ignores channels when subs is set');
  }
  const p = registered(c.user ?? '', c.expiresAt, c.issuedAt, c.id, c.audience, c.issuer);
  const at = sessionExpiry(c.connectionExpiresAt, 'connectionExpiresAt');
  if (at !== undefined) {
    p.push(`"expire_at":${at}`);
  }
  payloadClaim(p, 'info', c.info);
  stringClaim(p, 'b64info', c.b64info);
  if (c.channels?.length) {
    p.push(`"channels":${JSON.stringify(strings(c.channels, 'channels'))}`);
  }
  if (c.subs && Object.keys(c.subs).length > 0) {
    const subs = Object.entries(c.subs).map(
      ([ch, o]) => `${JSON.stringify(ch)}:${subscribeOptions(o, `subs[${JSON.stringify(ch)}]`)}`,
    );
    p.push(`"subs":{${subs.join(',')}}`);
  }
  payloadClaim(p, 'meta', c.meta);
  if (c.caps?.length) {
    p.push(`"caps":[${c.caps.map((cap, i) => encode(CAP_FIELDS, cap, `caps[${i}]`)).join(',')}]`);
  }
  if (c.labels && Object.keys(c.labels).length > 0) {
    p.push(`"labels":${encode([['labels', 0, 2]], { labels: c.labels }, '').slice('{"labels":'.length, -1)}`);
  }
  return sign(key, p);
}

/** A subscription token with claims, signed with key. */
export async function subscription(key: Key, claims: SubscriptionClaims): Promise<string> {
  const c = claims;
  checkKeys(c, SUBSCRIPTION_CLAIMS, 'subscription claim', (m) => new TypeError(`token: ${m}`), {
    ...WIRE_NAMES,
    expire_at: 'subscriptionExpiresAt',
    expireAt: 'subscriptionExpiresAt',
  });
  if (typeof c.channel !== 'string' || c.channel === '') {
    throw new TypeError('token: a subscription token needs a channel');
  }
  const p = registered(c.user ?? '', c.expiresAt, c.issuedAt, c.id, c.audience, c.issuer);
  p.push(`"channel":${JSON.stringify(c.channel)}`);
  const at = sessionExpiry(c.subscriptionExpiresAt, 'subscriptionExpiresAt');
  if (at !== undefined) {
    p.push(`"expire_at":${at}`);
  }
  payloadClaim(p, 'info', c.info);
  stringClaim(p, 'b64info', c.b64info);
  payloadClaim(p, 'data', c.data);
  stringClaim(p, 'b64data', c.b64data);
  messageClaim(p, 'override', c.override, SubscribeOptionOverrideFields);
  if (c.allow?.length) {
    p.push(`"allow":${JSON.stringify(strings(c.allow, 'allow'))}`);
  }
  messageClaim(p, 'server_tags_filter', c.serverTagsFilter, FilterNodeFields);
  return sign(key, p);
}

/**
 * A token for Centrifugo PRO's server API with claims, signed with key - an
 * asymmetric key with an ID, published by jwks: Centrifugo PRO finds it by the
 * "kid". See ApiClaims for keeping it apart from client tokens, and ApiTokens
 * for one to send with every call.
 */
export async function api(key: Key, claims: ApiClaims): Promise<string> {
  const c = claims;
  checkKeys(c, API_CLAIMS, 'API token claim', (m) => new TypeError(`token: ${m}`), { ...WIRE_NAMES, sub: 'subject' });
  if (key.jwk === undefined) {
    throw new TypeError(
      'token: an API token needs an RSA, ECDSA or Ed25519 key: Centrifugo PRO verifies it with the public keys of its JWKS endpoint',
    );
  }
  if (!key.kid) {
    throw new TypeError('token: an API token needs a key ID, by which Centrifugo PRO finds the key: use withKeyId');
  }
  if (!c.audience && !c.scope?.length) {
    throw new TypeError(
      "token: set audience or scope, required by http_api.jwks, so that client tokens signed with the same keys can't call the server API",
    );
  }
  if (c.expiresAt === undefined) {
    throw new TypeError(
      'token: set expiresAt: Centrifugo PRO accepts an API token without one while its key is published',
    );
  }
  for (const s of c.scope ?? []) {
    if (typeof s !== 'string' || s === '' || /\s/.test(s)) {
      throw new TypeError('token: a scope is empty or has a space');
    }
  }
  const p = registered(c.subject ?? '', c.expiresAt, c.issuedAt, c.id, c.audience, c.issuer);
  if (c.scope?.length) {
    p.push(`"scope":${JSON.stringify(c.scope.join(' '))}`);
  }
  return sign(key, p);
}

/**
 * The public keys of keys as a JSON Web Key Set, for Centrifugo's
 * client.token.jwks_public_endpoint, which verifies tokens by their "kid".
 * Each key needs an ID - see Key.withKeyId - unique in the set. HMAC keys have
 * no public key to publish, and are refused, as is a set without keys.
 *
 * A set is how keys rotate without restarting Centrifugo: publish the new key
 * next to the old one; once every instance of the application publishes it,
 * sign with it; drop the old key once the tokens it signed have expired. Never
 * give a key ID to another key: Centrifugo caches keys by ID.
 *
 * Publish the keys of client tokens and of Centrifugo PRO's server API tokens
 * at separate endpoints: a token signed with any key of a set passes
 * Centrifugo's signature check.
 */
export function jwks(...keys: Key[]): string {
  if (keys.length === 0) {
    throw new TypeError('token: a JWKS without keys');
  }
  const seen = new Set<string>();
  const out = keys.map((k, i) => {
    if (!(k instanceof Key)) {
      throw new TypeError(`token: JWKS key #${i} is not a Key`);
    }
    const jwk = k.jwk;
    if (jwk === undefined) {
      throw new TypeError(`token: JWKS key #${i} has no public key to publish: an HMAC key`);
    }
    if (!k.kid) {
      throw new TypeError(`token: JWKS key #${i} has no key ID: set one with withKeyId`);
    }
    if (seen.has(k.kid)) {
      throw new TypeError(`token: JWKS key ID "${k.kid}" used twice`);
    }
    seen.add(k.kid);
    const { kty, ...rest } = jwk;
    return { kty, kid: k.kid, use: 'sig', alg: k.alg, ...rest };
  });
  return JSON.stringify({ keys: out });
}

/**
 * Issues the tokens a Client sends to Centrifugo PRO: its token method is the
 * client's getBearerToken. It signs a token with api and reuses it for half
 * its lifetime, so a token sent has at least half of it left.
 *
 * ```ts
 * const tokens = new ApiTokens({
 *   key: apiKey,   // its own key, not the client tokens'
 *   claims: { audience: 'centrifugo-api', scope: ['centrifugo:api'] },
 * });
 * const client = new Client({ apiEndpoint, getBearerToken: tokens.token });
 * ```
 *
 * currentKey, when set, returns the key to sign each new token with instead of
 * key - the key active now, when keys rotate. A key must be published in the
 * JWKS before it signs: Centrifugo PRO refuses a token whose key it can't
 * find. claims must leave expiresAt and issuedAt unset: the tokens are issued
 * when needed and expire ttl milliseconds later (5 minutes by default).
 */
export class ApiTokens {
  readonly #claims: ApiClaims;
  readonly #key: Key | undefined;
  readonly #currentKey: (() => Key | Promise<Key>) | undefined;
  readonly #ttl: number;
  #token: Promise<string> | undefined;
  #refreshAt = 0;

  constructor(options: {
    claims: ApiClaims;
    key?: Key;
    currentKey?: () => Key | Promise<Key>;
    /** Milliseconds a token is valid: 5 minutes by default. */
    ttl?: number;
  }) {
    checkKeys(options, ['claims', 'key', 'currentKey', 'ttl'], 'ApiTokens option', (m) => new TypeError(`token: ${m}`));
    const { claims, key, currentKey, ttl = 300_000 } = options;
    checkKeys(claims, API_CLAIMS, 'API token claim', (m) => new TypeError(`token: ${m}`), {
      ...WIRE_NAMES,
      sub: 'subject',
    });
    if ((key === undefined) === (currentKey === undefined)) {
      throw new TypeError('token: ApiTokens takes key or currentKey, one of them');
    }
    if (claims.expiresAt !== undefined || claims.issuedAt !== undefined) {
      throw new TypeError('token: ApiTokens sets expiresAt and issuedAt itself: leave them unset, and set ttl');
    }
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
      throw new TypeError('token: ApiTokens ttl must be a positive number of milliseconds');
    }
    this.#claims = claims;
    this.#key = key;
    this.#currentKey = currentKey;
    this.#ttl = ttl;
  }

  /**
   * A token valid for at least half of ttl, signing a new one when the
   * previous one has less left. Bound to its ApiTokens: pass it on as it is.
   * Concurrent calls share one signing.
   */
  readonly token = (): Promise<string> => {
    const now = Date.now();
    if (this.#token !== undefined && now < this.#refreshAt) {
      return this.#token;
    }
    this.#refreshAt = now + this.#ttl / 2;
    const signing = (async () => {
      const key = this.#currentKey !== undefined ? await this.#currentKey() : this.#key!;
      return api(key, { ...this.#claims, issuedAt: new Date(now), expiresAt: new Date(now + this.#ttl) });
    })();
    this.#token = signing;
    // A failed signing is not reused.
    signing.catch(() => {
      if (this.#token === signing) {
        this.#token = undefined;
      }
    });
    return signing;
  };
}

// Encoding claims.

const CAP_FIELDS = [
  ['channels', 0, 1],
  ['allow', 0, 1],
  ['match', 0],
] as const;

/** The RFC 7519 claims Centrifugo reads, in the order the spec's vectors use: sub, exp, iat, jti, aud, iss. */
function registered(
  user: string,
  expiresAt: Expiry | Date,
  issuedAt: Date | undefined,
  id: string | undefined,
  audience: string | undefined,
  issuer: string | undefined,
): string[] {
  if (typeof user !== 'string') {
    throw new TypeError(`token: user must be a string, not ${kindOf(user)}`);
  }
  const p = [`"sub":${JSON.stringify(user)}`];
  if (expiresAt === undefined) {
    throw new TypeError('token: expiresAt is required: a Date, or NEVER for a token accepted forever');
  }
  if (expiresAt !== NEVER) {
    p.push(`"exp":${unix(expiresAt, 'expiresAt')}`);
  }
  p.push(`"iat":${issuedAt !== undefined ? unix(issuedAt, 'issuedAt') : Math.floor(Date.now() / 1000)}`);
  stringClaim(p, 'jti', id);
  stringClaim(p, 'aud', audience);
  stringClaim(p, 'iss', issuer);
  return p;
}

function unix(d: unknown, name: string): number {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new TypeError(`token: ${name} must be a valid Date, not ${kindOf(d)}`);
  }
  return Math.floor(d.getTime() / 1000);
}

/** The "expire_at" claim: left out (undefined), 0 for never, or a time. */
function sessionExpiry(at: Expiry | undefined, name: string): number | undefined {
  if (at === undefined) {
    return undefined;
  }
  return at === NEVER ? 0 : unix(at, name);
}

function stringClaim(p: string[], name: string, v: string | undefined): void {
  if (v !== undefined && v !== '') {
    if (typeof v !== 'string') {
      throw new TypeError(`token: ${name} must be a string, not ${kindOf(v)}`);
    }
    p.push(`${JSON.stringify(name)}:${JSON.stringify(v)}`);
  }
}

function payloadClaim(p: string[], name: string, v: unknown): void {
  // A payload which is not JSON fails here, not in Centrifugo.
  if (v !== undefined) {
    p.push(`${JSON.stringify(name)}:${encodePayload(v, name)}`);
  }
}

function messageClaim(p: string[], name: string, v: object | undefined, fields: Parameters<typeof encode>[0]): void {
  if (v !== undefined) {
    const j = encode(fields, v, name);
    if (j !== '{}') {
      p.push(`${JSON.stringify(name)}:${j}`);
    }
  }
}

function strings(list: readonly unknown[], name: string): string[] {
  return list.map((s, i) => {
    if (typeof s !== 'string') {
      throw new TypeError(`token: ${name}[${i}] must be a string, not ${kindOf(s)}`);
    }
    return s;
  });
}

function subscribeOptions(o: SubscribeOptions, path: string): string {
  const p: string[] = [];
  if (o.info !== undefined) {
    p.push(`"info":${encodePayload(o.info, `${path}.info`)}`);
  }
  stringClaim(p, 'b64info', o.b64info);
  if (o.data !== undefined) {
    p.push(`"data":${encodePayload(o.data, `${path}.data`)}`);
  }
  stringClaim(p, 'b64data', o.b64data);
  messageClaim(p, 'override', o.override, SubscribeOptionOverrideFields);
  messageClaim(p, 'server_tags_filter', o.serverTagsFilter, FilterNodeFields);
  return `{${p.join(',')}}`;
}

async function sign(key: Key, claims: string[]): Promise<string> {
  if (!(key instanceof Key)) {
    throw new TypeError('token: key must be a Key');
  }
  const header = `{"alg":${JSON.stringify(key.alg)},"typ":"JWT"${key.kid ? `,"kid":${JSON.stringify(key.kid)}` : ''}}`;
  const signed = `${b64(new TextEncoder().encode(header))}.${b64(new TextEncoder().encode(`{${claims.join(',')}}`))}`;
  return `${signed}.${b64(await key.sign(new TextEncoder().encode(signed)))}`;
}

/** @internal Base64url, unpadded. */
export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g)!, (b) => Number.parseInt(b, 16));
}

/** The OIDs in a DER structure, as hex: enough to tell a PKCS #8 key's algorithm and curve. */
function derOids(der: Uint8Array): string[] {
  const out: string[] = [];
  const walk = (start: number, end: number) => {
    let i = start;
    while (i < end) {
      const tag = der[i]!;
      let len = der[i + 1]!;
      let hdr = 2;
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let j = 0; j < n; j++) {
          len = (len << 8) | der[i + 2 + j]!;
        }
        hdr += n;
      }
      const body = i + hdr;
      if (tag === 0x06) {
        out.push([...der.subarray(body, body + len)].map((b) => b.toString(16).padStart(2, '0')).join(''));
      } else if (tag === 0x30 || tag === 0xa0) {
        walk(body, body + len);
      }
      i = body + len;
    }
  };
  walk(0, der.length);
  return out;
}
