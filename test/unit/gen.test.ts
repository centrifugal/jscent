import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../gen/proto.ts';
import { constGroups, constName, emptyHasMeaning, isPresence, isRequired, listedValues } from '../../gen/rules.ts';
import * as apiConsts from '../../src/index.ts';
import * as proxyConsts from '../../src/proxy/index.ts';

const api = parse(readFileSync(new URL('../../proto/api.proto', import.meta.url), 'utf8'), 'api.proto');

describe('the generator', () => {
  // Found in api.proto's comments, and pinned here: a changed comment fails
  // this test rather than silently changing what is sent or checked.
  it('finds the presence wrappers and the required fields whose empty value has a meaning', () => {
    expect(api.messages.filter(isPresence).map((m) => m.name)).toEqual([
      'BoolValue',
      'Int32Value',
      'DeviceUserUpdate',
      'DeviceTimezoneUpdate',
      'DeviceLocaleUpdate',
      'DeviceMetaUpdate',
    ]);
    const unchecked = api.messages.flatMap((m) =>
      m.fields.filter((f) => isRequired(f) && emptyHasMeaning(f)).map((f) => `${m.name}.${f.name}`),
    );
    expect(unchecked).toEqual([
      'InvalidateUserTokensRequest.user',
      'DeviceUserUpdate.user',
      'DeviceTimezoneUpdate.timezone',
      'DeviceLocaleUpdate.locale',
      'DeviceMetaUpdate.meta',
      'UserTopicUpdateRequest.user',
    ]);
  });

  it('takes only the plain "Required." as required', () => {
    const field = (doc: string) => ({ name: 'f', type: 'string', repeated: false, mapKey: '', doc: [doc] });
    expect(isRequired(field('channel is the channel. Required.'))).toBe(true);
    expect(isRequired(field('data is the data. Required unless b64data is set.'))).toBe(false);
    expect(isRequired(field('expire_at is the time. Required when the request sets limit_strategy.'))).toBe(false);
    expect(emptyHasMeaning(field('user is the user. Required. "" detaches it.'))).toBe(true);
    expect(emptyHasMeaning(field('meta is the meta. Required. An empty map clears it.'))).toBe(true);
    expect(emptyHasMeaning(field('An empty value is refused. channel is the channel. Required.'))).toBe(false);
  });
});

describe('constants', () => {
  const field = (name: string, doc: string) => ({ name, type: 'string', repeated: false, mapKey: '', doc: [doc] });
  const message = (name: string, ...fields: ReturnType<typeof field>[]) => ({ name, doc: [], fields });

  it('are read from the "One of:" sentence', () => {
    expect(listedValues(['op is the operation. Required. One of: add, remove, set.'])).toEqual([
      'add',
      'remove',
      'set',
    ]);
    expect(listedValues(['provider is the provider. Required. One of: fcm,', 'hms, apns, webpush.'])).toEqual([
      'fcm',
      'hms',
      'apns',
      'webpush',
    ]);
    expect(listedValues(['channel is the channel. Required.'])).toBeUndefined();
    expect(() => listedValues(['One of: a, b'])).toThrow('period');
    expect(() => listedValues(['One of: A, b.'])).toThrow('not a value');
    expect(() => listedValues(['One of: a, a.'])).toThrow('twice');
  });

  it('are named by field and value, by message too where fields of one name differ', () => {
    const names = (messages: ReturnType<typeof message>[]) =>
      constGroups(messages, () => true).flatMap((g) => g.values.map((v) => constName(g, v)));
    expect(
      names([
        message('A', field('op', 'One of: add, remove.')),
        message('B', field('op', 'One of: add, remove.')),
        message('FilterNode', field('op', 'One of: and, or.'), field('key_mode', 'One of: if_new.')),
      ]),
    ).toEqual(['OP_ADD', 'OP_REMOVE', 'FILTER_NODE_OP_AND', 'FILTER_NODE_OP_OR', 'KEY_MODE_IF_NEW']);
    // A tie names every group by its message.
    expect(names([message('A', field('op', 'One of: add.')), message('C', field('op', 'One of: and.'))])).toEqual([
      'A_OP_ADD',
      'C_OP_AND',
    ]);
    // Only the messages included count.
    expect(
      constGroups(
        [message('A', field('op', 'One of: add.')), message('C', field('op', 'One of: and.'))],
        (n) => n === 'A',
      ).flatMap((g) => g.values.map((v) => constName(g, v))),
    ).toEqual(['OP_ADD']);
  });

  it('equal their values, in the API and in the proxy, each named by the rule within its proto', () => {
    const proxyProto = parse(readFileSync(new URL('../../proto/proxy.proto', import.meta.url), 'utf8'), 'proxy.proto');
    for (const [schema, mod] of [
      [api, apiConsts],
      [proxyProto, proxyConsts],
    ] as const) {
      const groups = constGroups(schema.messages, () => true);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        for (const v of g.values) {
          expect((mod as Record<string, unknown>)[constName(g, v)], constName(g, v)).toBe(v);
        }
      }
    }
    expect(apiConsts.FILTER_NODE_OP_AND).toBe('and');
    expect(apiConsts.OP_ADD).toBe('add');
    expect(proxyConsts.OP_AND).toBe('and');
    expect(apiConsts.PROVIDER_FCM).toBe('fcm');
    expect(apiConsts.PLATFORM_IOS).toBe('ios');
    expect(proxyConsts.ENCODING_BINARY).toBe('binary');
  });
});
