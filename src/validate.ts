import { InvalidRequestError } from './errors.ts';
import { METHODS } from './generated/api.ts';
import { encode } from './wire.ts';

/**
 * A request's JSON, or InvalidRequestError for one the client can tell is
 * wrong: not encodable, a field it does not know, a field the proto marks
 * "Required." without a value, or a publication without data - the only rules
 * which hold for every Centrifugo.
 *
 * @internal
 */
export function encodeRequest(method: string, request: unknown): string {
  const spec = METHODS[method];
  if (spec === undefined || method === 'batch') {
    throw new InvalidRequestError(`"${method}" is not a method of the Centrifugo server API`);
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new InvalidRequestError(`invalid ${method} request: it must be an object of its fields`);
  }
  let json: string;
  try {
    json = encode(spec.request, request, '');
  } catch (e) {
    if (e instanceof InvalidRequestError) {
      throw new InvalidRequestError(`invalid ${method} request: ${e.message}`, { cause: e.cause });
    }
    throw e;
  }
  // The fields the proto marks "Required." are checked by encode; the data
  // rules are the spec's.
  const r = request as { channels?: unknown[]; data?: unknown; b64data?: unknown };
  if (method === 'publish' || method === 'broadcast') {
    if (r.data === undefined && !r.b64data) {
      throw new InvalidRequestError(`invalid ${method} request: data or b64data is required`);
    }
  }
  if (method === 'broadcast') {
    for (const [i, ch] of (r.channels ?? []).entries()) {
      if (!ch) {
        throw new InvalidRequestError(`invalid broadcast request: channels[${i}] is empty`);
      }
    }
  }
  return json;
}
