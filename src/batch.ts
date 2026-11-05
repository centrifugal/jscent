import { apiError, BroadcastResult } from './broadcast.ts';
import type { Client } from './client.ts';
import {
  BatchFailedCommandsError,
  BatchNotSentError,
  BatchSentError,
  CentError,
  DecodeError,
  errorJSON,
  InvalidRequestError,
} from './errors.ts';
import { BatchMethods, METHODS } from './generated/api.ts';
import { type CallOptions, checkCallOptions } from './request.ts';
import { encodeRequest } from './validate.ts';
import { decode } from './wire.ts';

/** The failure of one command of a batch. */
export interface FailedCommand {
  /** The command's position in the batch, from zero. */
  readonly index: number;
  /** Its API method, such as "publish". */
  readonly method: string;
  /**
   * The error its Pending throws: an ApiError, or a
   * BroadcastFailedChannelsError for a broadcast which failed in one or more
   * channels.
   */
  readonly error: Error;
}

/**
 * The outcome of a sent batch as a whole. Each command's own outcome is in the
 * Pending its method returned. JSON.stringify renders it as
 * `{replied, failed}`, each failed command as `{index, method, error}`, the
 * error as `{code, message}`.
 */
export class BatchResult {
  /**
   * True when Centrifugo replied to every command, the failed ones included;
   * false when the batch failed as a whole. True for an empty batch.
   */
  readonly replied: boolean;
  readonly #failed: FailedCommand[];

  /** For test doubles, say. */
  constructor(replied: boolean, failed: FailedCommand[] = []) {
    this.replied = replied;
    this.#failed = failed;
  }

  /** The commands which failed, with their errors, in the order they were added - as the error's failed lists them. */
  get failed(): FailedCommand[] {
    return [...this.#failed];
  }

  toJSON(): Record<string, unknown> {
    return {
      replied: this.replied,
      failed: this.#failed.map((f) => ({ index: f.index, method: f.method, error: errorJSON(f.error) })),
    };
  }
}

/** The outcome of one command of a batch, available once the batch is sent. */
export class Pending<T> {
  readonly #get: () => T;

  /** @internal */
  constructor(get: () => T) {
    this.#get = get;
  }

  /**
   * A Pending of no batch, whose result() returns value or throws error: for
   * test doubles of code which reads a batch's outcomes.
   */
  static resolved<T>(value: T): Pending<T>;
  static resolved<T = never>(value: undefined, error: Error): Pending<T>;
  static resolved<T>(value: T, error?: Error): Pending<T> {
    return new Pending(() => {
      if (error !== undefined) {
        throw error;
      }
      return value;
    });
  }

  /**
   * The command's result, or its error thrown: an ApiError for this command,
   * the error which failed the whole batch, or BatchNotSentError. A broadcast
   * throws BroadcastFailedChannelsError, carrying every channel's outcome,
   * when any channel failed.
   */
  result(): T {
    return this.#get();
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: Error };

/**
 * Commands sent to Centrifugo in one request. Create one with
 * `client.newBatch()`, add commands - a method per API method, each returning a
 * Pending - then send:
 *
 * ```ts
 * const batch = client.newBatch();
 * const pub = batch.publish({ channel: 'news', data: { text: 'hi' } });
 * const stats = batch.presenceStats({ channel: 'news' });
 * await batch.send();              // throws unless every command succeeded
 * pub.result().offset;
 * ```
 *
 * A batch is sent once, and is not safe for concurrent use.
 */
export class Batch extends BatchMethods {
  readonly #client: Client;
  readonly #parallel: boolean;
  readonly #commands: string[] = [];
  readonly #methods: string[] = [];
  readonly #invalid: (InvalidRequestError | undefined)[] = [];
  readonly #decoders: ((reply: Record<string, unknown>) => unknown)[] = [];
  #replies: Record<string, unknown>[] = [];
  readonly #outcomes = new Map<number, Outcome>();
  #error: Error | undefined;
  #sent = false;

  /** @internal */
  constructor(client: Client, parallel: boolean) {
    super();
    this.#client = client;
    this.#parallel = parallel;
  }

  /** How many commands were added. */
  get size(): number {
    return this.#commands.length;
  }

  /** @internal Adds a command: what the generated methods call. */
  protected override add<T>(method: string, request: object): Pending<T> {
    if (this.#sent) {
      throw new Error('jscent: command added to a batch that was already sent');
    }
    const i = this.#commands.length;
    let text = '';
    let invalid: InvalidRequestError | undefined;
    try {
      text = `{${JSON.stringify(method)}:${encodeRequest(method, request)}}`;
    } catch (e) {
      if (!(e instanceof InvalidRequestError)) {
        throw e;
      }
      invalid = e;
    }
    let decodeReply: (reply: Record<string, unknown>) => unknown;
    if (method === 'broadcast') {
      const r = request as { channels?: readonly string[]; idempotencyKey?: string };
      const channels = [...(r.channels ?? [])];
      const key = r.idempotencyKey ?? '';
      decodeReply = (reply) =>
        BroadcastResult.fromWire(reply.broadcast ?? {}, `replies[${i}].broadcast`, channels, key).check();
    } else {
      const fields = METHODS[method]?.result ?? [];
      decodeReply = (reply) => decode(fields, reply[method] ?? {}, `replies[${i}].${method}`);
    }
    this.#commands.push(text);
    this.#methods.push(method);
    this.#invalid.push(invalid);
    this.#decoders.push(decodeReply);
    return new Pending(() => this.#outcome(i) as T);
  }

  /**
   * Sends the batch and waits for Centrifugo's reply to every command.
   *
   * It resolves when every command succeeded. BatchFailedCommandsError means
   * one or more commands failed, up to all: every command got its own reply,
   * each Pending holds its outcome. Any other error means the batch failed as
   * a whole: no command got a reply, and every Pending throws that error. A
   * command the client can tell is invalid fails the whole batch before
   * anything is sent. An empty batch sends nothing.
   */
  async send(options?: CallOptions): Promise<BatchResult> {
    if (this.#sent) {
      throw new BatchSentError('batch already sent');
    }
    checkCallOptions(options);
    this.#sent = true;
    try {
      if (this.#commands.length === 0) {
        this.#client.checkOpen();
        return new BatchResult(true);
      }
      for (const [i, err] of this.#invalid.entries()) {
        if (err !== undefined) {
          throw new InvalidRequestError(`batch command #${i}: ${err.message}`, { cause: err.cause });
        }
      }
      const body = `{"commands":[${this.#commands.join(',')}]${this.#parallel ? ',"parallel":true' : ''}}`;
      this.#replies = await this.#client.sendBatch(body, this.#commands.length, options, false);
    } catch (e) {
      this.#error = e as Error;
      throw e;
    }
    const failed: FailedCommand[] = [];
    for (const [i, method] of this.#methods.entries()) {
      const out = this.#resolve(i);
      if (!out.ok) {
        failed.push({ index: i, method, error: out.error });
      }
    }
    const res = new BatchResult(true, failed);
    if (failed.length > 0) {
      throw new BatchFailedCommandsError(failed, this.#commands.length, res);
    }
    return res;
  }

  #outcome(i: number): unknown {
    if (!this.#sent) {
      throw new BatchNotSentError('batch not sent yet');
    }
    if (this.#error !== undefined) {
      throw this.#error;
    }
    const out = this.#resolve(i);
    if (!out.ok) {
      throw out.error;
    }
    return out.value;
  }

  /** Command i's outcome, decoded once, so that send's error holds the very error its Pending throws. */
  #resolve(i: number): Outcome {
    let out = this.#outcomes.get(i);
    if (out === undefined) {
      const reply = this.#replies[i]!;
      const err = commandError(reply, i, this.#methods[i]!);
      if (err !== undefined) {
        out = { ok: false, error: err };
      } else {
        try {
          out = { ok: true, value: this.#decoders[i]!(reply) };
        } catch (e) {
          if (!(e instanceof CentError)) {
            throw e;
          }
          out = { ok: false, error: e };
        }
      }
      this.#outcomes.set(i, out);
    }
    return out;
  }
}

/**
 * The error of a batch command's reply, if it has one. A PRO method's code 104
 * hints that the server may be Centrifugo OSS.
 *
 * @internal
 */
export function commandError(reply: Record<string, unknown>, i: number, method: string): Error | undefined {
  if (reply.error === undefined || reply.error === null) {
    return undefined;
  }
  const err = apiError(reply.error, `replies[${i}].error`, '');
  if (err.code === 104 && METHODS[method]?.pro) {
    return apiError(reply.error, `replies[${i}].error`, method);
  }
  return err;
}

/**
 * The replies of a batch of n commands.
 *
 * @internal
 */
export function batchReplies(d: unknown, n: number): Record<string, unknown>[] {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) {
    throw new DecodeError('batch: the reply is not a JSON object');
  }
  const body = d as { error?: unknown; replies?: unknown };
  if (body.error !== undefined && body.error !== null) {
    throw apiError(body.error, 'batch: error', '');
  }
  const replies = body.replies ?? [];
  if (!Array.isArray(replies) || !replies.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) {
    throw new DecodeError('batch: replies: expected an array of objects');
  }
  if (replies.length !== n) {
    throw new DecodeError(`batch: got ${replies.length} replies for ${n} commands`);
  }
  return replies as Record<string, unknown>[];
}
