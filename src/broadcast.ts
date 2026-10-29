import { ApiError, BroadcastFailedChannelsError, DecodeError, errorJSON } from './errors.ts';
import { type PublishResult, PublishResultFields } from './generated/api.ts';
import { decode, kindOf } from './wire.ts';

/** The outcome of a broadcast in one channel. */
export interface ChannelResult {
  /** The channel, as the request named it. */
  readonly channel: string;
  /** The publication's position in the channel's history, when it succeeded. */
  readonly result: PublishResult | undefined;
  /**
   * Undefined when the publication succeeded; the channel's ApiError, or the
   * error of the whole broadcast when it failed as a whole.
   */
  readonly error: Error | undefined;
  /** How many times the channel was sent: more than 1 when broadcastWithRetry retried it. */
  readonly attempts: number;
}

/**
 * The outcome of a broadcast: one entry per channel, in the order the request
 * listed them. JSON.stringify renders it with Centrifugo's field names:
 * `{channels, idempotency_key, attempts, replied}`, each channel as
 * `{channel, result, error, attempts}` - result when it succeeded, error,
 * `{code, message}`, when it failed.
 */
export class BroadcastResult {
  /** Every channel's outcome. */
  readonly channels: ChannelResult[];
  /**
   * The key the broadcast was sent with: the request's, or the one
   * broadcastWithRetry made when the request had none. A later retry with it
   * does not publish again into the channels which got the publication.
   */
  readonly idempotencyKey: string;
  /**
   * How many times the broadcast was tried: 1 from broadcast, up to
   * maxAttempts from broadcastWithRetry, 0 when it was refused before sending.
   */
  readonly attempts: number;
  /**
   * True when Centrifugo carried the broadcast out and replied for every
   * channel, the failed ones included; false when it failed as a whole.
   */
  readonly replied: boolean;

  /** Every field as the result has it: for test doubles, say. */
  constructor(channels: ChannelResult[], idempotencyKey = '', attempts = 1, replied = true) {
    this.channels = channels;
    this.idempotencyKey = idempotencyKey;
    this.attempts = attempts;
    this.replied = replied;
  }

  /** The channels which did not get the publication, with their errors, in the order of the request. */
  get failed(): ChannelResult[] {
    return this.channels.filter((c) => c.error !== undefined);
  }

  toJSON(): Record<string, unknown> {
    return {
      channels: this.channels.map((c) => ({
        channel: c.channel,
        ...(c.error === undefined ? { result: c.result ?? {} } : { error: errorJSON(c.error) }),
        attempts: c.attempts,
      })),
      idempotency_key: this.idempotencyKey,
      attempts: this.attempts,
      replied: this.replied,
    };
  }

  /** @internal The result of a broadcast which failed as a whole: every channel failed with error. */
  static failedAsWhole(channels: readonly string[], error: Error, attempts: number, key: string): BroadcastResult {
    return new BroadcastResult(
      channels.map((channel) => ({ channel, result: undefined, error, attempts })),
      key,
      attempts,
      false,
    );
  }

  /** @internal The result of a broadcast Centrifugo replied to: one response per channel, in order. */
  static fromWire(v: unknown, path: string, channels: readonly string[], key: string): BroadcastResult {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new DecodeError(`${path}: expected an object, got ${kindOf(v)}`);
    }
    const responses = (v as { responses?: unknown }).responses ?? [];
    if (!Array.isArray(responses)) {
      throw new DecodeError(`${path}.responses: expected an array, got ${kindOf(responses)}`);
    }
    if (responses.length !== channels.length) {
      throw new DecodeError(`got ${responses.length} replies for ${channels.length} channels`);
    }
    const out = responses.map((r: unknown, i): ChannelResult => {
      const where = `${path}.responses[${i}]`;
      if (typeof r !== 'object' || r === null || Array.isArray(r)) {
        throw new DecodeError(`${where}: expected an object, got ${kindOf(r)}`);
      }
      const rr = r as { error?: unknown; result?: unknown };
      const channel = channels[i]!;
      if (rr.error !== undefined && rr.error !== null) {
        return { channel, result: undefined, error: apiError(rr.error, `${where}.error`, ''), attempts: 1 };
      }
      return {
        channel,
        result: decode(PublishResultFields, rr.result ?? {}, `${where}.result`),
        error: undefined,
        attempts: 1,
      };
    });
    return new BroadcastResult(out, key, 1, true);
  }

  /** @internal This result, or BroadcastFailedChannelsError carrying it when any channel failed. */
  check(): BroadcastResult {
    const failed = this.failed;
    if (failed.length > 0) {
      throw new BroadcastFailedChannelsError(failed, this.channels.length, this);
    }
    return this;
  }
}

/** @internal The ApiError of an error object in a reply. */
export function apiError(v: unknown, path: string, proMethod: string): ApiError {
  const e = decode<{ code: number; message: string; temporary: boolean }>(
    [
      ['code', 2],
      ['message', 0],
      ['temporary', 1],
    ],
    v,
    path,
  );
  return ApiError.fromCode(e.code, e.message, e.temporary, proMethod);
}
