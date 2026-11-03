import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../gen/proto.ts';
import { emptyHasMeaning, isPresence, isRequired } from '../../gen/rules.ts';

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
