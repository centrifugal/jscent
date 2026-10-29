import { describe, expect, it } from 'vitest';

import {
  ConnectHandler,
  type ConnectRequest,
  Disconnect,
  RefreshHandler,
  type RefreshRequest,
} from '../../src/proxy/index.ts';
import { client, Stream, serve, stop, unique } from './setup.ts';

// testdata/centrifugo.json points the connect and refresh proxies at port 3100
// of the host, which Centrifugo reaches as host.docker.internal.
const PORT = Number(process.env.JSCENT_TEST_PROXY_PORT ?? 3100);

describe('proxy handlers called by Centrifugo', () => {
  it('connect and refresh', async () => {
    const c = await client();
    const user = unique('proxy-');
    const ch = `${user}-news`;
    const connects: ConnectRequest[] = [];
    const refreshes: RefreshRequest[] = [];
    const errors: unknown[] = [];
    const onError = (_: unknown, e: unknown) => errors.push(e);
    const connect = new ConnectHandler(
      (req) => {
        connects.push(req);
        if (!(req.data as { allow?: boolean }).allow) {
          throw new Disconnect(4501, 'unauthorized');
        }
        return {
          user,
          expireAt: Math.floor(Date.now() / 1000) + 2,
          info: { name: 'Alice' },
          data: { welcome: true },
          channels: [ch],
        };
      },
      { onError },
    );
    const refresh = new RefreshHandler(
      (req) => {
        refreshes.push(req);
        return { expired: true };
      },
      { onError },
    );
    const server = await serve(PORT, (req, res) =>
      req.url === '/connect' ? connect.node(req, res) : refresh.node(req, res),
    );
    try {
      // Refused: the connection is closed with the disconnect's code.
      const refused = new Stream({ data: { allow: false } });
      const msg = await refused.next();
      refused.close();
      expect(msg?.disconnect?.code).toBe(4501);
      expect([connects[0]!.transport, connects[0]!.protocol, connects[0]!.encoding]).toEqual([
        'uni_http_stream',
        'json',
        'json',
      ]);
      expect(connects[0]!.client).not.toBe('');

      // Accepted: the result's data and server-side channel reach the client,
      // and so does a publication into that channel.
      const s = new Stream({ data: { allow: true } });
      const reply = await s.next();
      expect(reply?.connect?.data).toEqual({ welcome: true });
      expect(Object.keys(reply?.connect?.subs ?? {})).toContain(ch);
      await c.publish({ channel: ch, data: { text: 'hello' } });
      expect(JSON.stringify(await s.next())).toContain('hello');
      const pres = Object.values((await c.presence({ channel: ch })).presence);
      expect(pres.map((i) => [i.user, i.connInfo])).toEqual([[user, { name: 'Alice' }]]);

      // It expires: Centrifugo asks the refresh proxy, which ends it.
      while ((await s.next()) !== undefined) {}
      expect(refreshes[0]?.user).toBe(user);
      expect(refreshes[0]?.client).toBe(reply?.connect?.client);
      expect(errors).toEqual([]);
    } finally {
      await stop(server);
    }
  }, 30_000);
});
