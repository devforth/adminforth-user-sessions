import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminforthMock = vi.hoisted(() => {
  class AdminForthPlugin {
    adminforth: any;
    pluginInstanceId = 'test-plugin';
    shouldHaveSingleInstancePerWholeApp: () => boolean = () => false;

    constructor(public options: any, _metaUrl: string) {}

    modifyGlobalConfig(adminforth: any) {
      this.adminforth = adminforth;
    }

    componentPath(file: string) {
      return `component:${file}`;
    }
  }

  return { AdminForthPlugin };
});

vi.mock('adminforth', () => adminforthMock);

const UserSessionsPlugin = (await import('../index.js')).default;

class MemoryKeyValueAdapter {
  entries = new Map<string, { value: string, expiresInSeconds?: number }>();

  private actualKey(key: string, collection?: string) {
    return collection ? `${collection}:${key}` : key;
  }

  async get(key: string, collection?: string) {
    return this.entries.get(this.actualKey(key, collection))?.value ?? null;
  }

  async set(key: string, value: string, expiresInSeconds?: number, collection?: string) {
    this.entries.set(this.actualKey(key, collection), { value, expiresInSeconds });
  }

  async delete(key: string, collection?: string) {
    this.entries.delete(this.actualKey(key, collection));
  }

  async listByPrefix(prefix: string, limit: number, collection?: string) {
    const actualPrefix = this.actualKey(prefix, collection);
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(actualPrefix))
      .slice(0, limit)
      .map(([key, { value }]) => ({ [collection ? key.slice(collection.length + 1) : key]: value }));
  }
}

const USER = { pk: 'user-1', username: 'adminforth', dbUser: {} };
const HEADERS = { 'x-forwarded-for': '8.8.8.8', 'cf-ipcountry': 'DE' };

function createAdminforth() {
  return {
    config: {
      auth: {
        afterSessionCreated: [] as any[],
        adminUserAuthorize: [] as any[],
        beforeLogout: [] as any[],
        userMenuSettingsPages: undefined as any,
      },
    },
    auth: {
      getClientIp: (headers: Record<string, string>) => headers['x-forwarded-for'] ?? null,
    },
  };
}

function extraOf(headers: Record<string, string> = HEADERS) {
  return { headers } as any;
}

let kv: MemoryKeyValueAdapter;
let adminforth: ReturnType<typeof createAdminforth>;

function activate(options: Record<string, any> = {}) {
  const plugin = new UserSessionsPlugin({ keyValueAdapter: kv as any, ...options });
  plugin.modifyGlobalConfig(adminforth as any);
  return plugin;
}

function hooks() {
  const auth = adminforth.config.auth;
  return {
    sessionCreated: auth.afterSessionCreated[0],
    authorize: auth.adminUserAuthorize[0],
    logout: auth.beforeLogout[0],
  };
}

function endpointsOf(plugin: any) {
  const registered: Record<string, Function> = {};
  plugin.setupEndpoints({
    endpoint: ({ method, path, handler }: any) => { registered[`${method} ${path}`] = handler; },
  });
  return registered;
}

async function login(sessionId: string, expiresInSeconds = 3600, headers = HEADERS) {
  await hooks().sessionCreated({
    pk: USER.pk,
    username: USER.username,
    sessionId,
    expiresInSeconds,
    adminforth,
    extra: extraOf(headers),
  });
}

function storedSession(sessionId: string) {
  return JSON.parse(kv.entries.get(`adminforth-user-sessions:${USER.pk}:${sessionId}`)!.value);
}

beforeEach(() => {
  kv = new MemoryKeyValueAdapter();
  adminforth = createAdminforth();
});

describe('activation', () => {
  it('registers auth hooks and the settings page', () => {
    const plugin = activate();

    expect(adminforth.config.auth.afterSessionCreated).toHaveLength(1);
    expect(adminforth.config.auth.adminUserAuthorize).toHaveLength(1);
    expect(adminforth.config.auth.beforeLogout).toHaveLength(1);
    expect(adminforth.config.auth.userMenuSettingsPages).toEqual([
      expect.objectContaining({
        slug: 'user-sessions',
        component: 'component:UserSessions.vue',
        // without isVisible the page never reaches the frontend
        isVisible: expect.any(Function),
      }),
    ]);
    expect(plugin.pluginsScope).toEqual('global');
  });

  it('refuses to work with adminforth which has no afterSessionCreated hook', () => {
    delete (adminforth.config.auth as any).afterSessionCreated;

    expect(() => activate()).toThrow(/afterSessionCreated/);
  });
});

describe('session lifecycle', () => {
  it('stores ip, country and timestamps for created session, expiring with its token', async () => {
    activate();
    await login('session-1', 900);

    expect(storedSession('session-1')).toEqual({
      ip: '8.8.8.8',
      country: 'DE',
      created_at: expect.any(String),
      last_used_at: expect.any(String),
    });
    expect(kv.entries.get(`adminforth-user-sessions:${USER.pk}:session-1`)!.expiresInSeconds).toEqual(900);
  });

  it('allows request of stored session and rejects revoked one', async () => {
    activate();
    await login('session-1');
    const adminUser = { ...USER, sessionId: 'session-1' };

    expect(await hooks().authorize({ adminUser })).toEqual({ allowed: true });

    await kv.delete(`${USER.pk}:session-1`, 'adminforth-user-sessions');

    expect(await hooks().authorize({ adminUser })).toEqual({ allowed: false, error: 'Session was revoked' });
  });

  it('allows requests which have no session, like api key ones', async () => {
    activate();

    expect(await hooks().authorize({ adminUser: { ...USER } })).toEqual({ allowed: true });
  });

  it('revokes session on logout', async () => {
    activate();
    await login('session-1');

    await hooks().logout({ adminUser: { ...USER, sessionId: 'session-1' } });

    expect(await kv.get(`${USER.pk}:session-1`, 'adminforth-user-sessions')).toBeNull();
  });

  it('does not fail logout of a session which was never stored', async () => {
    activate();

    await expect(hooks().logout({ adminUser: null })).resolves.toBeUndefined();
  });
});

describe('last used time', () => {
  it('is not rewritten on every request', async () => {
    activate();
    await login('session-1');
    const createdAt = storedSession('session-1').last_used_at;

    await hooks().authorize({ adminUser: { ...USER, sessionId: 'session-1' } });

    expect(storedSession('session-1').last_used_at).toEqual(createdAt);
  });

  it('is refreshed when throttle time passed, keeping remaining lifetime of the token', async () => {
    activate({ lastUsedThrottleSeconds: 0 });
    await login('session-1', 3600);
    const { created_at: createdAt, last_used_at: lastUsedAt } = storedSession('session-1');
    const tokenExpiresAt = Math.floor(Date.now() / 1000) + 1800;

    await vi.waitFor(async () => {
      await hooks().authorize({ adminUser: { ...USER, sessionId: 'session-1', exp: tokenExpiresAt } });
      expect(storedSession('session-1').last_used_at).not.toEqual(lastUsedAt);
    });

    const entry = kv.entries.get(`adminforth-user-sessions:${USER.pk}:session-1`)!;
    expect(entry.expiresInSeconds).toBeGreaterThan(1790);
    expect(entry.expiresInSeconds).toBeLessThanOrEqual(1800);
    expect(storedSession('session-1').created_at).toEqual(createdAt);
  });

  it('does not resurrect a session whose token already expired', async () => {
    activate({ lastUsedThrottleSeconds: 0 });
    await login('session-1');
    const lastUsedAt = storedSession('session-1').last_used_at;

    await hooks().authorize({
      adminUser: { ...USER, sessionId: 'session-1', exp: Math.floor(Date.now() / 1000) - 10 },
    });

    expect(storedSession('session-1').last_used_at).toEqual(lastUsedAt);
  });
});

describe('country', () => {
  it('is read from configured header', async () => {
    activate({ countryHeader: 'X-Geo-Country' });
    await login('session-1', 3600, { 'x-forwarded-for': '8.8.8.8', 'x-geo-country': 'pl' });

    expect(storedSession('session-1').country).toEqual('PL');
  });

  it('falls back to resolveCountry when header does not tell it', async () => {
    const resolveCountry = vi.fn(async () => 'UA');
    activate({ resolveCountry });
    await login('session-1', 3600, { 'x-forwarded-for': '8.8.8.8', 'cf-ipcountry': 'XX' });

    expect(resolveCountry).toHaveBeenCalledWith({
      ip: '8.8.8.8',
      headers: { 'x-forwarded-for': '8.8.8.8', 'cf-ipcountry': 'XX' },
    });
    expect(storedSession('session-1').country).toEqual('UA');
  });

  it('stays unknown when nothing can tell it', async () => {
    activate();
    await login('session-1', 3600, {});

    expect(storedSession('session-1')).toEqual(expect.objectContaining({ ip: null, country: null }));
  });
});

describe('endpoints', () => {
  it('lists sessions of the user, newest first, marking the current one', async () => {
    const plugin = activate();
    const endpoints = endpointsOf(plugin);
    await login('older');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await login('newer');
    // session of another user must not be listed
    await kv.set('user-2:foreign', '{}', 3600, 'adminforth-user-sessions');

    const { sessions } = await endpoints['GET /plugin/user-sessions/list']({
      adminUser: { ...USER, sessionId: 'older' },
    });

    expect(sessions.map((session: any) => session.sessionId)).toEqual(['newer', 'older']);
    expect(sessions.map((session: any) => session.isCurrent)).toEqual([false, true]);
  });

  it('revokes one session', async () => {
    const plugin = activate();
    const endpoints = endpointsOf(plugin);
    await login('session-1');
    await login('session-2');

    await endpoints['POST /plugin/user-sessions/revoke']({
      adminUser: { ...USER, sessionId: 'session-1' },
      body: { sessionId: 'session-2' },
    });

    expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).toBeNull();
    expect(await kv.get(`${USER.pk}:session-1`, 'adminforth-user-sessions')).not.toBeNull();
  });

  it('revokes every session except the current one', async () => {
    const plugin = activate();
    const endpoints = endpointsOf(plugin);
    await login('session-1');
    await login('session-2');
    await login('session-3');

    const result = await endpoints['POST /plugin/user-sessions/revoke-others']({
      adminUser: { ...USER, sessionId: 'session-1' },
    });

    expect(result).toEqual({ ok: true, revoked: 2 });
    expect(await kv.get(`${USER.pk}:session-1`, 'adminforth-user-sessions')).not.toBeNull();
    expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).toBeNull();
    expect(await kv.get(`${USER.pk}:session-3`, 'adminforth-user-sessions')).toBeNull();
  });
});
