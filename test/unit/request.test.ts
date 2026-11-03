import { describe, expect, it } from 'vitest';
import { FakeCentrifugo } from './fake.ts';

describe('requests', () => {
  it('send a presence wrapper whenever it is set, even empty', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    await c.deviceUpdate({
      ids: ['d'],
      userUpdate: { user: '' },
      timezoneUpdate: { timezone: '' },
      localeUpdate: { locale: '' },
      metaUpdate: { meta: {} },
    });
    expect(fake.last.json).toEqual({
      ids: ['d'],
      user_update: {},
      timezone_update: {},
      locale_update: {},
      meta_update: {},
    });
    await c.deviceUpdate({ ids: ['d'], timezoneUpdate: { timezone: 'Europe/Berlin' } });
    expect(fake.last.json).toEqual({ ids: ['d'], timezone_update: { timezone: 'Europe/Berlin' } });
    // Left unset, it changes nothing: not sent.
    await c.deviceUpdate({ ids: ['d'] });
    expect(fake.last.json).toEqual({ ids: ['d'] });
    // A BoolValue alike: false is sent, unset is not.
    await c.subscribe({ channel: 'a', user: 'u', override: { presence: false } });
    expect(fake.last.json).toEqual({ channel: 'a', user: 'u', override: { presence: { value: false } } });
  });

  it('do not send any other message set but empty', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    await c.subscribe({ channel: 'a', user: 'u', override: {}, recoverSince: { offset: 0, epoch: '' } });
    expect(fake.last.json).toEqual({ channel: 'a', user: 'u' });
    await c.sendPushNotification({
      recipient: { fcmTokens: ['t'] },
      notification: { fcm: { message: { notification: { title: 't' } } } },
      limitStrategy: {},
    });
    expect(fake.last.json).not.toHaveProperty('limit_strategy');
  });
});
