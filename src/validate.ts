import { InvalidRequestError } from './errors.ts';
import { METHODS } from './generated/api.ts';
import { encode } from './wire.ts';

/**
 * A request's JSON, or InvalidRequestError for one the client can tell is
 * wrong: not encodable, a field it does not know, or - the only rules which
 * hold for every Centrifugo - a publication without a channel or data.
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
  const r = request as { channel?: unknown; channels?: unknown; data?: unknown; b64data?: unknown };
  if (method === 'publish') {
    if (!r.channel) {
      throw new InvalidRequestError('invalid publish request: channel is required');
    }
    if (r.data === undefined && !r.b64data) {
      throw new InvalidRequestError('invalid publish request: data or b64data is required');
    }
  } else if (method === 'broadcast') {
    if (!Array.isArray(r.channels) || r.channels.length === 0) {
      throw new InvalidRequestError('invalid broadcast request: channels is required');
    }
    if (r.data === undefined && !r.b64data) {
      throw new InvalidRequestError('invalid broadcast request: data or b64data is required');
    }
    for (const [i, ch] of (r.channels as unknown[]).entries()) {
      if (!ch) {
        throw new InvalidRequestError(`invalid broadcast request: channels[${i}] is empty`);
      }
    }
  }
  try {
    return encode(spec.request, request, '');
  } catch (e) {
    if (e instanceof InvalidRequestError) {
      throw new InvalidRequestError(`invalid ${method} request: ${e.message}`, { cause: e.cause });
    }
    throw e;
  }
}
