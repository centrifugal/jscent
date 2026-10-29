import { RawJSON } from './payload.ts';
import { encodeRequest } from './validate.ts';

/**
 * An API call left for Centrifugo's async consumers to make: written to a
 * PostgreSQL outbox table, a Kafka topic, a Redis stream - made with
 * `command.publish({ ... })` and the like. See
 * https://centrifugal.dev/docs/server/consumers.
 *
 * Consumers take it as its method and payload apart - the outbox table's
 * method and payload columns, a message attribute - or as the JSON message
 * `{"method": ..., "payload": ...}` of toString (Kafka, NATS JetStream).
 * JSON.stringify gives that message too, also of a command inside another
 * value, with payload as a JSON object.
 *
 * Within a partition a consumer keeps commands in order: a channel's commands
 * keep their order only when every writer derives their partition from the
 * channel the same way - the channel as a Kafka message key, say.
 *
 * ```ts
 * const cmd = command.publish({ channel: 'news', data: { text: 'hi' } });
 * await sql`INSERT INTO centrifugo_outbox (method, payload, partition) VALUES (${cmd.method}, ${cmd.payload}, 0)`;
 * ```
 *
 * The outbox table's payload column is jsonb, and `cmd.payload` goes into it
 * as it is: JSON text, which PostgreSQL stores as the object.
 */
export interface Command {
  /** The API method, such as "publish". */
  readonly method: string;
  /** The request, as JSON text. */
  readonly payload: string;
  /** The command as one JSON message: `{"method": ..., "payload": ...}`. */
  toString(): string;
  /**
   * The message of toString for JSON.stringify: payload a JSON object.
   * toString keeps the payload's text exactly - integers past 2^53 included -
   * where a JSON.stringify of your own parses and writes it again.
   */
  toJSON(): { method: string; payload: RawJSON };
}

/**
 * The command making the API call: the request is checked as a client checks
 * it before sending - an invalid one throws InvalidRequestError here, rather
 * than in Centrifugo, whose consumers drop a command they cannot run - and
 * encoded.
 *
 * @internal
 */
export function newCommand(method: string, request: object): Command {
  const payload = encodeRequest(method, request);
  return {
    method,
    payload,
    toString: () => `{"method":${JSON.stringify(method)},"payload":${payload}}`,
    toJSON: () => ({ method, payload: new RawJSON(payload) }),
  };
}
