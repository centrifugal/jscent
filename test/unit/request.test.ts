import { describe, expect, it } from 'vitest';
import { command, InvalidRequestError, OP_ADD, PLATFORM_ANDROID, PROVIDER_FCM } from '../../src/index.ts';
import { FakeCentrifugo, rejection } from './fake.ts';

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

describe('required fields', () => {
  const push = {
    recipient: { fcmTokens: ['t'] },
    notification: { fcm: { message: { notification: { title: 't' } } } },
  };

  it('fail before sending when unset or empty, naming their path', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    const cases: [Promise<unknown>, string][] = [
      // Plain JS callers, without the types' required properties.
      [c.history({} as never), 'invalid history request: channel is required'],
      [c.history({ channel: '' }), 'invalid history request: channel is required'],
      [c.presence({ channel: undefined } as never), 'invalid presence request: channel is required'],
      [c.publish({ data: 1 } as never), 'invalid publish request: channel is required'],
      [c.broadcast({ data: 1 } as never), 'invalid broadcast request: channels is required'],
      [c.broadcast({ channels: [], data: 1 }), 'invalid broadcast request: channels is required'],
      [c.getUserStatus({ users: [] }), 'invalid get_user_status request: users is required'],
      [c.sharedPollPublish({ channel: 'a', key: 'k', version: 0 }), 'shared_poll_publish request: version is required'],
      [
        c.deviceRegister({ provider: 'fcm', token: 't', platform: '' }),
        'invalid device_register request: platform is required',
      ],
      // A required message must be set, and not empty.
      [c.sendPushNotification({ ...push, recipient: {} }), 'send_push_notification request: recipient is required'],
      [c.sendPushNotification({ recipient: push.recipient } as never), 'notification is required'],
      // A nested message is checked when set, a list's elements each.
      [
        c.deviceUpdate({ ids: ['d'], topicsUpdate: { op: '', topics: ['t'] } }),
        'invalid device_update request: topicsUpdate.op is required',
      ],
      [
        c.sendPushNotification({
          ...push,
          limitStrategy: {
            rateLimit: {
              policies: [
                { rate: 1, intervalMs: 1000 },
                { rate: 0, intervalMs: 1000 },
              ],
            },
          },
        }),
        'limitStrategy.rateLimit.policies[1].rate is required',
      ],
      [
        c.sendPushNotification({ ...push, limitStrategy: { rateLimit: { policies: [{}] } } } as never),
        'limitStrategy.rateLimit.policies[0].rate is required',
      ],
      [
        c.sendPushNotification({ ...push, limitStrategy: { timeLimit: { sendAfterTime: '09:00' } } } as never),
        'limitStrategy.timeLimit.sendBeforeTime is required',
      ],
    ];
    for (const [call, message] of cases) {
      const err = await rejection(call);
      expect(err).toBeInstanceOf(InvalidRequestError);
      expect(err.message).toContain(message);
    }
    expect(fake.sent).toEqual([]);
    // A batch and a command check as a call does.
    const b = c.newBatch();
    b.history({ channel: 'a' });
    b.history({ channel: '' });
    const err = await rejection(b.send());
    expect(err.message).toContain('channel is required');
    expect(fake.sent).toEqual([]);
    expect(() => command.presence({ channel: '' })).toThrow('invalid presence request: channel is required');
  });

  it('leave an optional nested message alone when unset or empty', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    await c.sendPushNotification({ ...push, limitStrategy: { timeLimit: {} as never } });
    expect(fake.last.json).not.toHaveProperty('limit_strategy');
    await c.sendPushNotification({
      ...push,
      limitStrategy: { timeLimit: { sendAfterTime: '09:00', sendBeforeTime: '18:00' } },
    });
    expect(fake.last.json).toHaveProperty('limit_strategy', {
      time_limit: { send_after_time: '09:00', send_before_time: '18:00' },
    });
    expect(fake.sent.length).toBe(2);
  });

  it('send a field whose empty value has a meaning empty', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    // An empty user: anonymous users, the global binding, detached devices.
    await c.invalidateUserTokens({ user: '' });
    expect(fake.last.json).toEqual({});
    await c.userTopicUpdate({ user: '', op: 'add', topics: ['t'] });
    expect(fake.last.json).toEqual({ op: 'add', topics: ['t'] });
    await c.deviceUpdate({ ids: ['d'], userUpdate: { user: '' } });
    expect(fake.last.json).toEqual({ ids: ['d'], user_update: {} });
    expect(fake.sent.length).toBe(3);
  });
});

describe('constants', () => {
  it('are the values sent, and a value without one is still sent', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    await c.deviceRegister({ provider: PROVIDER_FCM, token: 't', platform: PLATFORM_ANDROID });
    expect(fake.last.json).toEqual({ provider: 'fcm', token: 't', platform: 'android' });
    await c.deviceTopicUpdate({ deviceId: 'd', op: OP_ADD, topics: ['t'] });
    expect(fake.last.json).toEqual({ device_id: 'd', op: 'add', topics: ['t'] });
    // Centrifugo may add values: a field is a string.
    await c.deviceRegister({ provider: 'future_provider', token: 't', platform: 'tv' });
    expect(fake.last.json).toEqual({ provider: 'future_provider', token: 't', platform: 'tv' });
  });
});
