import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  const PERIOD_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

  return {
    AdminForthPlugin,
    afLogger: { error: vi.fn() },
    convertPeriodToSeconds: (period: string) => Number(period.slice(0, -1)) * PERIOD_SECONDS[period.slice(-1)],
    Filters: { EQ: (field: string, value: any) => ({ field, value }) },
    Sorts: { DESC: (field: string) => ({ field, direction: 'desc' }) },
  };
});

vi.mock('adminforth', () => adminforthMock);

const UserSessionsPlugin = (await import('../index.js')).default;
const { parseUserAgent } = await import('../userAgent.js');

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

class MemoryResource {
  records: Record<string, any>[] = [];
  private nextId = 1;

  async create(record: Record<string, any>) {
    this.records.push({ id: this.nextId++, ...record });
    return { ok: true, createdRecord: record };
  }

  async list(filters: { field: string, value: any }[], _limit: number | undefined, offset: number, sort: { field: string }) {
    return this.records
      .filter((record) => filters.every(({ field, value }) => record[field] === value))
      .sort((a, b) => b[sort.field].localeCompare(a[sort.field]))
      .slice(offset);
  }

  async delete(id: number) {
    this.records = this.records.filter((record) => record.id !== id);
    return true;
  }
}

const LOGIN_HISTORY = {
  resourceId: 'login_history',
  resourceColumns: {
    userIdColumnName: 'user_id',
    successColumnName: 'success',
    attemptsColumnName: 'attempts',
    ipColumnName: 'ip',
    countryColumnName: 'country',
    userAgentColumnName: 'user_agent',
    ipsColumnName: 'ips',
    createdAtColumnName: 'created_at',
  },
};

const USER = { pk: 'user-1', username: 'adminforth', dbUser: {} };
const CHROME_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'x-forwarded-for': '8.8.8.8', 'cf-ipcountry': 'DE', 'user-agent': CHROME_MAC_UA };
const DEVICE_COOKIE = 'adminforth_test_device';

function createAdminforth() {
  const loginHistory = new MemoryResource();
  return {
    loginHistory,
    resource: () => loginHistory,
    config: {
      resources: [{
        resourceId: 'adminuser',
        columns: [{ name: 'id', primaryKey: true }],
        options: {},
      }, {
        resourceId: 'login_history',
        columns: [{ name: 'id', primaryKey: true }, ...Object.values(LOGIN_HISTORY.resourceColumns).map((name) => ({ name }))],
        options: {},
      }] as any[],
      auth: {
        usersResourceId: 'adminuser',
        afterSessionCreated: [] as any[],
        afterLoginFailed: [] as any[],
        adminUserAuthorize: [] as any[],
        beforeLogout: [] as any[],
        userMenuSettingsPages: undefined as any,
      },
      customization: {
        customPages: [] as any[],
      },
      baseUrlSlashed: '/admin/',
    },
    auth: {
      getClientIp: (headers: Record<string, string>) => headers['x-forwarded-for'] ?? null,
      getCustomCookie: ({ cookies, name }: any) =>
        cookies.find((cookie: any) => cookie.key === `adminforth_test_${name}`)?.value ?? null,
      setCustomCookie: ({ response, payload }: any) => { response.cookies.push(payload); },
      // readable stand-in for a signed JWT, verify rejects tokens of other types like the real one
      issueJWT: (payload: object, type: string) => Buffer.from(JSON.stringify({ ...payload, t: type })).toString('base64url'),
      verify: async (token: string, type: string) => {
        try {
          const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
          return decoded.t === type ? decoded : null;
        } catch {
          return null;
        }
      },
    },
  };
}

function extraOf(headers: Record<string, string> = HEADERS, deviceId?: string) {
  return {
    headers,
    cookies: deviceId ? [{ key: DEVICE_COOKIE, value: deviceId }] : [],
    response: { cookies: [] as any[] },
  } as any;
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

function responseStub() {
  return { status: 200, setStatus(code: number) { this.status = code; } };
}

function endpointsOf(plugin: any) {
  const registered: Record<string, Function> = {};
  plugin.setupEndpoints({
    endpoint: ({ method, path, handler }: any) => { registered[`${method} ${path}`] = handler; },
  });
  return registered;
}

async function login(sessionId: string, expiresInSeconds = 3600, headers: Record<string, string> = HEADERS, deviceId?: string) {
  const extra = extraOf(headers, deviceId);
  await hooks().sessionCreated({
    pk: USER.pk,
    username: USER.username,
    sessionId,
    expiresInSeconds,
    adminforth,
    extra,
  });
  return extra;
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

  it('does not touch the users resource when managing other users is not allowed', () => {
    activate();

    expect(adminforth.config.resources[0].options).toEqual({});
  });

  it('shows sessions on the users show page when managing other users is allowed', () => {
    activate({ canManageOtherUsersSessions: async () => true });

    expect(adminforth.config.resources[0].options.pageInjections.show.bottom).toEqual([
      { file: 'component:UserSessionsOfUser.vue', meta: { primaryKeyField: 'id' } },
    ]);
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
      user_agent: CHROME_MAC_UA,
      created_at: expect.any(String),
      last_used_at: expect.any(String),
    });
    expect(kv.entries.get(`adminforth-user-sessions:${USER.pk}:session-1`)!.expiresInSeconds).toEqual(900);
  });

  it('truncates an oversized user agent before storing it', async () => {
    activate();
    await login('session-1', 3600, { ...HEADERS, 'user-agent': 'Version/' + '1'.repeat(15800) });

    expect(storedSession('session-1').user_agent).toHaveLength(512);
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

  it('does not fail logout when key-value store is unavailable', async () => {
    activate();
    await login('session-1');
    kv.delete = async () => { throw new Error('connection refused'); };

    await expect(hooks().logout({ adminUser: { ...USER, sessionId: 'session-1' } })).resolves.toBeUndefined();
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

describe('revoke racing with a request of the revoked session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // makes the revoke land right between the session check and the write of last_used_at
  function revokeOnNextWrite(revoke: () => Promise<unknown>) {
    const set = kv.set.bind(kv);
    kv.set = async (...args: Parameters<typeof set>) => {
      kv.set = set;
      await revoke();
      await set(...args);
    };
  }

  it('deletes the session again after the request wrote it back', async () => {
    const endpoints = endpointsOf(activate({ lastUsedThrottleSeconds: 0 }));
    await login('session-1');
    await login('session-2');
    const adminUser = { ...USER, sessionId: 'session-2' };
    revokeOnNextWrite(() => endpoints['POST /plugin/user-sessions/revoke']({
      adminUser: { ...USER, sessionId: 'session-1' },
      body: { sessionId: 'session-2' },
      response: responseStub(),
    }));

    await hooks().authorize({ adminUser });
    expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5000);

    expect(await hooks().authorize({ adminUser })).toEqual({ allowed: false, error: 'Session was revoked' });
  });

  it('deletes the session again after logout', async () => {
    activate({ lastUsedThrottleSeconds: 0 });
    await login('session-1');
    const adminUser = { ...USER, sessionId: 'session-1' };
    revokeOnNextWrite(() => hooks().logout({ adminUser }));

    await hooks().authorize({ adminUser });
    await vi.advanceTimersByTimeAsync(5000);

    expect(await kv.get(`${USER.pk}:session-1`, 'adminforth-user-sessions')).toBeNull();
  });

  it('logs a failed repeated delete instead of throwing it', async () => {
    const endpoints = endpointsOf(activate());
    await login('session-1');
    await endpoints['POST /plugin/user-sessions/revoke']({
      adminUser: USER,
      body: { sessionId: 'session-1' },
      response: responseStub(),
    });
    kv.delete = async () => { throw new Error('connection refused'); };

    await vi.advanceTimersByTimeAsync(5000);

    expect(adminforthMock.afLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/failed to repeat revoke.*connection refused/),
    );
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

describe('device', () => {
  it('is parsed out of the stored user agent when sessions are listed', async () => {
    const endpoints = endpointsOf(activate());
    await login('session-1');

    const { sessions } = await endpoints['POST /plugin/user-sessions/list']({ adminUser: USER, body: {} });

    expect(sessions[0].device).toEqual({ browser: 'Chrome 131', os: 'macOS', type: 'desktop' });
  });

  it('is null for a session stored without a user agent', async () => {
    const endpoints = endpointsOf(activate());
    await login('session-1', 3600, {});

    const { sessions } = await endpoints['POST /plugin/user-sessions/list']({ adminUser: USER, body: {} });

    expect(sessions[0]).toEqual(expect.objectContaining({ user_agent: null, device: null }));
  });
});

describe('user agent parsing', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      { browser: 'Safari 18', os: 'iOS 18', type: 'mobile' },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1',
      { browser: 'Safari 17', os: 'iOS 17', type: 'tablet' },
    ],
    [
      'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari 15', os: 'iOS 15', type: 'mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome 130', os: 'Android 14', type: 'mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      { browser: 'Chrome 129', os: 'Android 13', type: 'tablet' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      { browser: 'Edge 131', os: 'Windows', type: 'desktop' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      { browser: 'Firefox 133', os: 'Linux', type: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet 23', os: 'Android 12', type: 'mobile' },
    ],
    [
      'curl/8.7.1',
      { browser: null, os: null, type: 'desktop' },
    ],
  ])('recognizes %s', (userAgent, expected) => {
    expect(parseUserAgent(userAgent)).toEqual(expected);
  });

  it('gives nothing for a missing user agent', () => {
    expect(parseUserAgent(null)).toBeNull();
  });

  it('leaves versions out when asked', () => {
    expect(parseUserAgent(CHROME_MAC_UA, false)).toEqual({ browser: 'Chrome', os: 'macOS', type: 'desktop' });
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

    const { sessions } = await endpoints['POST /plugin/user-sessions/list']({
      adminUser: { ...USER, sessionId: 'older' },
      body: {},
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
      response: responseStub(),
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
      body: {},
      response: responseStub(),
    });

    expect(result).toEqual({ ok: true, revoked: 2 });
    expect(await kv.get(`${USER.pk}:session-1`, 'adminforth-user-sessions')).not.toBeNull();
    expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).toBeNull();
    expect(await kv.get(`${USER.pk}:session-3`, 'adminforth-user-sessions')).toBeNull();
  });

  it('treats sessions as own for integer primary key, which the users show page sends as a string', async () => {
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions: async () => false }));
    await hooks().sessionCreated({
      pk: 7, username: 'someone', sessionId: 'own-session', expiresInSeconds: 3600, adminforth, extra: extraOf(),
    });

    const result = await endpoints['POST /plugin/user-sessions/list']({
      adminUser: { ...USER, pk: 7, sessionId: 'own-session' },
      body: { userPk: '7' },
    });

    expect(result.allowed).toBe(true);
    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'own-session', isCurrent: true })]);
  });
});

describe('IP addresses', () => {
  it('are listed when no callback is configured', async () => {
    const endpoints = endpointsOf(activate());
    await login('session-1');

    const result = await endpoints['POST /plugin/user-sessions/list']({ adminUser: USER, body: {} });

    expect(result.ipsVisible).toBe(true);
    expect(result.sessions[0].ip).toBe('8.8.8.8');
  });

  it('are listed to a user the callback allows', async () => {
    const canSeeIps = vi.fn(async () => true);
    const endpoints = endpointsOf(activate({ canSeeIps }));
    await login('session-1');

    const result = await endpoints['POST /plugin/user-sessions/list']({ adminUser: USER, body: {} });

    expect(canSeeIps).toHaveBeenCalledWith(USER);
    expect(result.ipsVisible).toBe(true);
    expect(result.sessions[0].ip).toBe('8.8.8.8');
  });

  it('are left out of the response for a user the callback rejects, even for own sessions', async () => {
    const endpoints = endpointsOf(activate({ canSeeIps: async () => false }));
    await login('session-1');

    const result = await endpoints['POST /plugin/user-sessions/list']({ adminUser: USER, body: {} });

    expect(result.ipsVisible).toBe(false);
    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'session-1', ip: null, country: 'DE' })]);
    expect(JSON.stringify(result)).not.toContain('8.8.8.8');
  });
});

describe('sessions of other users', () => {
  const SUPERADMIN = { pk: 'user-2', username: 'root', dbUser: { role: 'superadmin' }, sessionId: 'own-session' };

  async function loginOf(pk: string, sessionId: string) {
    await hooks().sessionCreated({
      pk, username: 'someone', sessionId, expiresInSeconds: 3600, adminforth, extra: extraOf(),
    });
  }

  it('are listed to a user the callback allows', async () => {
    const canManageOtherUsersSessions = vi.fn(async (adminUser: any) => adminUser.dbUser.role === 'superadmin');
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions }));
    await login('their-session');

    const result = await endpoints['POST /plugin/user-sessions/list']({
      adminUser: SUPERADMIN,
      body: { userPk: USER.pk },
    });

    expect(canManageOtherUsersSessions).toHaveBeenCalledWith(SUPERADMIN);
    expect(result.allowed).toBe(true);
    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: 'their-session', isCurrent: false }),
    ]);
  });

  it('are hidden from a user the callback rejects', async () => {
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions: async () => false }));
    await login('their-session');

    expect(await endpoints['POST /plugin/user-sessions/list']({
      adminUser: SUPERADMIN,
      body: { userPk: USER.pk },
    })).toEqual({ allowed: false, sessions: [] });
  });

  it('are hidden when no callback is configured', async () => {
    const endpoints = endpointsOf(activate());
    await login('their-session');

    expect(await endpoints['POST /plugin/user-sessions/list']({
      adminUser: SUPERADMIN,
      body: { userPk: USER.pk },
    })).toEqual({ allowed: false, sessions: [] });
  });

  it('are revoked by an allowed user', async () => {
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions: async () => true }));
    await login('their-session');

    const result = await endpoints['POST /plugin/user-sessions/revoke']({
      adminUser: SUPERADMIN,
      body: { sessionId: 'their-session', userPk: USER.pk },
      response: responseStub(),
    });

    expect(result).toEqual({ ok: true });
    expect(await kv.get(`${USER.pk}:their-session`, 'adminforth-user-sessions')).toBeNull();
  });

  it('survive a revoke attempt of a user the callback rejects', async () => {
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions: async () => false }));
    await login('their-session');
    const response = responseStub();

    const result = await endpoints['POST /plugin/user-sessions/revoke']({
      adminUser: SUPERADMIN,
      body: { sessionId: 'their-session', userPk: USER.pk },
      response,
    });

    expect(result).toEqual({ error: expect.any(String) });
    expect(response.status).toEqual(403);
    expect(await kv.get(`${USER.pk}:their-session`, 'adminforth-user-sessions')).not.toBeNull();
  });

  it('are all revoked at once, keeping the session of the one who revokes', async () => {
    const endpoints = endpointsOf(activate({ canManageOtherUsersSessions: async () => true }));
    await login('their-first');
    await login('their-second');
    await loginOf(SUPERADMIN.pk, SUPERADMIN.sessionId);

    const result = await endpoints['POST /plugin/user-sessions/revoke-others']({
      adminUser: SUPERADMIN,
      body: { userPk: USER.pk },
      response: responseStub(),
    });

    expect(result).toEqual({ ok: true, revoked: 2 });
    expect(await kv.get(`${USER.pk}:their-first`, 'adminforth-user-sessions')).toBeNull();
    expect(await kv.get(`${USER.pk}:their-second`, 'adminforth-user-sessions')).toBeNull();
    expect(await kv.get(`${SUPERADMIN.pk}:${SUPERADMIN.sessionId}`, 'adminforth-user-sessions')).not.toBeNull();
  });
});

describe('revoking all sessions', () => {
  it('revokes sessions of every user, keeping their known devices', async () => {
    const plugin = activate({ onNewLogin: async () => {} });
    await login('session-1');
    await hooks().sessionCreated({
      pk: 'user-2', username: 'root', sessionId: 'session-2', expiresInSeconds: 3600, adminforth, extra: extraOf(),
    });

    expect(await plugin.revokeAllSessions()).toEqual(2);
    expect(await hooks().authorize({ adminUser: { ...USER, sessionId: 'session-1' } }))
      .toEqual({ allowed: false, error: 'Session was revoked' });
    expect(await kv.listByPrefix('', 10, 'adminforth-user-sessions')).toEqual([]);
    expect(await kv.listByPrefix('', 10, 'adminforth-user-sessions-devices')).toHaveLength(2);
  });

  it('revokes more sessions than fit into one batch', async () => {
    const plugin = activate();
    for (let i = 0; i < 501; i++) {
      await login(`session-${i}`);
    }

    expect(await plugin.revokeAllSessions()).toEqual(501);
    expect(await kv.listByPrefix('', 1, 'adminforth-user-sessions')).toEqual([]);
  });
});

describe('new login notifications', () => {
  const FIREFOX_LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';
  const DEVICES_COLLECTION = 'adminforth-user-sessions-devices';

  function deviceCookieOf(extra: any) {
    return extra.response.cookies.find((cookie: any) => cookie.name === 'device');
  }

  function knownDevice(deviceId: string) {
    const entry = kv.entries.get(`${DEVICES_COLLECTION}:${USER.pk}:${deviceId}`);
    return entry && JSON.parse(entry.value);
  }

  /**
   * Signs in once from a new browser, so the user has a known device and later sign-ins are compared with it.
   * Mocks are cleared, so only the later sign-ins are seen by the callback.
   */
  async function firstLogin() {
    const extra = await login('first-session');
    vi.clearAllMocks();
    return deviceCookieOf(extra).value as string;
  }

  function tokenOf(revokePath: string) {
    return new URL(revokePath, 'https://admin.example.com').searchParams.get('token')!;
  }

  it('registers the revoke page only when the callback is set', () => {
    activate();
    expect(adminforth.config.customization.customPages).toEqual([]);

    adminforth = createAdminforth();
    activate({ onNewLogin: vi.fn(async () => {}) });
    expect(adminforth.config.customization.customPages).toEqual([{
      path: '/user-sessions/revoke',
      component: { file: 'component:RevokeSession.vue', meta: { sidebarAndHeader: 'none' } },
    }]);
  });

  it('does not track devices without the callback', async () => {
    activate();
    const extra = await login('session-1');

    expect(extra.response.cookies).toEqual([]);
    expect([...kv.entries.keys()].some((key) => key.startsWith(DEVICES_COLLECTION))).toBe(false);
  });

  it('reports the first sign-in of a user, remembering its device', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });

    const extra = await login('session-1');

    const cookie = deviceCookieOf(extra);
    expect(cookie).toEqual({
      name: 'device',
      value: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expirySeconds: 2 * 365 * 24 * 60 * 60,
      httpOnly: true,
    });
    expect(knownDevice(cookie.value)).toEqual({
      device: { browser: 'Chrome', os: 'macOS', type: 'desktop' },
      countries: ['DE'],
      first_seen: expect.any(String),
      last_seen: expect.any(String),
    });
    expect(onNewLogin).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['new_device', 'new_country'] }));
  });

  it('does not report a sign-in from a known device and country, renewing the cookie', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    const deviceId = await firstLogin();

    const extra = await login('session-2', 3600, HEADERS, deviceId);

    expect(onNewLogin).not.toHaveBeenCalled();
    expect(deviceCookieOf(extra).value).toEqual(deviceId);
  });

  it('does not report a browser update', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    const deviceId = await firstLogin();

    await login('session-2', 3600, { ...HEADERS, 'user-agent': CHROME_MAC_UA.replace('Chrome/131', 'Chrome/140') }, deviceId);

    expect(onNewLogin).not.toHaveBeenCalled();
  });

  it('reports a browser without the device cookie as a new device', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    await firstLogin();

    await login('session-2', 900);

    expect(onNewLogin).toHaveBeenCalledWith({
      pk: USER.pk,
      username: USER.username,
      session: expect.objectContaining({
        sessionId: 'session-2',
        ip: '8.8.8.8',
        country: 'DE',
        device: { browser: 'Chrome 131', os: 'macOS', type: 'desktop' },
      }),
      reasons: ['new_device'],
      revokePath: expect.stringMatching(/^\/admin\/user-sessions\/revoke\?token=/),
    });
  });

  it('reports a new country of a known device, remembering it', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    const deviceId = await firstLogin();

    await login('session-2', 3600, { ...HEADERS, 'cf-ipcountry': 'FR' }, deviceId);
    await login('session-3', 3600, HEADERS, deviceId);

    expect(onNewLogin).toHaveBeenCalledTimes(1);
    expect(onNewLogin).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['new_country'] }));
    expect(knownDevice(deviceId).countries).toEqual(['DE', 'FR']);
  });

  it('skips the country check when the country is unknown', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    const deviceId = await firstLogin();

    await login('session-2', 3600, { 'x-forwarded-for': '8.8.8.8', 'user-agent': CHROME_MAC_UA }, deviceId);

    expect(onNewLogin).not.toHaveBeenCalled();
  });

  it('reports a known device cookie copied into another browser as a new device', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    const deviceId = await firstLogin();

    await login('session-2', 3600, { ...HEADERS, 'user-agent': FIREFOX_LINUX_UA }, deviceId);

    expect(onNewLogin).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['new_device'] }));
  });

  it('replaces a malformed device cookie', async () => {
    const onNewLogin = vi.fn(async () => {});
    activate({ onNewLogin });
    await firstLogin();

    const extra = await login('session-2', 3600, HEADERS, '../../other-user:device');

    expect(deviceCookieOf(extra).value).toMatch(/^[0-9a-f-]{36}$/);
    expect(onNewLogin).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['new_device'] }));
  });

  it('logs a failed callback without failing the sign-in', async () => {
    activate({ onNewLogin: async () => { throw new Error('slack is down'); } });
    await firstLogin();

    await expect(login('session-2')).resolves.toBeDefined();

    await vi.waitFor(() => {
      expect(adminforthMock.afLogger.error).toHaveBeenCalledWith(expect.stringMatching(/onNewLogin failed.*slack is down/));
    });
  });

  describe('revoke page', () => {
    async function reportedLogin(sessionId: string) {
      const onNewLogin = vi.fn(async (_params: any) => {});
      const endpoints = endpointsOf(activate({ onNewLogin }));
      await firstLogin();
      const extra = await login(sessionId);
      return {
        endpoints,
        token: tokenOf(onNewLogin.mock.calls[0][0].revokePath),
        deviceId: deviceCookieOf(extra).value as string,
      };
    }

    it('shows the reported session', async () => {
      const { endpoints, token } = await reportedLogin('session-2');

      const result = await endpoints['POST /plugin/user-sessions/session-by-token']({ body: { token }, response: responseStub() });

      expect(result).toEqual({
        session: {
          ip: '8.8.8.8',
          country: 'DE',
          created_at: expect.any(String),
          device: { browser: 'Chrome 131', os: 'macOS', type: 'desktop' },
        },
      });
    });

    it('tells that the reported session has already ended', async () => {
      const { endpoints, token } = await reportedLogin('session-2');
      await kv.delete(`${USER.pk}:session-2`, 'adminforth-user-sessions');

      const result = await endpoints['POST /plugin/user-sessions/session-by-token']({ body: { token }, response: responseStub() });

      expect(result).toEqual({ session: null });
    });

    it('rejects a token of another type', async () => {
      const { endpoints } = await reportedLogin('session-2');
      const response = responseStub();
      const token = adminforth.auth.issueJWT({ pk: USER.pk, sessionId: 'session-2', deviceId: 'x' }, 'tempResetPassword');

      const result = await endpoints['POST /plugin/user-sessions/revoke-by-token']({ body: { token }, response });

      expect(result).toEqual({ error: 'Link is invalid or expired' });
      expect(response.status).toEqual(400);
      expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).not.toBeNull();
    });

    it('ends the reported session and forgets its device', async () => {
      const { endpoints, token, deviceId } = await reportedLogin('session-2');

      const result = await endpoints['POST /plugin/user-sessions/revoke-by-token']({ body: { token }, response: responseStub() });

      expect(result).toEqual({ ok: true });
      expect(await kv.get(`${USER.pk}:session-2`, 'adminforth-user-sessions')).toBeNull();
      expect(await kv.get(`${USER.pk}:first-session`, 'adminforth-user-sessions')).not.toBeNull();
      expect(knownDevice(deviceId)).toBeUndefined();
    });
  });
});

describe('login history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function activateWithHistory(options: Record<string, any> = {}, pluginOptions: Record<string, any> = {}) {
    const plugin = activate({ ...pluginOptions, loginHistory: { ...LOGIN_HISTORY, ...options } });
    plugin.validateConfigAfterDiscover(adminforth as any);
    return plugin;
  }

  async function failLogin(ip: string, reason = 'invalid_password', pk: string | null = USER.pk) {
    await adminforth.config.auth.afterLoginFailed[0]({
      username: USER.username,
      pk,
      reason,
      adminforth,
      extra: extraOf({ ...HEADERS, 'x-forwarded-for': ip }),
    });
  }

  const nextInterval = () => vi.advanceTimersByTimeAsync(60_000);
  const failedRecords = () => adminforth.loginHistory.records.filter((record) => !record.success);

  it('stores failed attempts only when the option is set', () => {
    activate();

    expect(adminforth.config.auth.afterLoginFailed).toHaveLength(0);
  });

  it('refuses to store login history with adminforth which has no afterLoginFailed hook', () => {
    delete (adminforth.config.auth as any).afterLoginFailed;

    expect(() => activate({ loginHistory: LOGIN_HISTORY })).toThrow(/afterLoginFailed/);
  });

  it('refuses a resource without a configured column', () => {
    adminforth.config.resources[1].columns = adminforth.config.resources[1].columns.filter((column: any) => column.name !== 'ips');

    expect(() => activateWithHistory()).toThrow(/column "ips" not found/);
  });

  it('stores sign-in right away with ip, country and user agent', async () => {
    activateWithHistory();
    await login('session-1');

    expect(adminforth.loginHistory.records).toEqual([{
      id: 1,
      user_id: USER.pk,
      success: true,
      attempts: 1,
      ip: '8.8.8.8',
      country: 'DE',
      user_agent: CHROME_MAC_UA,
      created_at: expect.any(String),
    }]);
  });

  it('writes attempts from different IPs of an interval as one record', async () => {
    activateWithHistory();
    for (let i = 1; i <= 10; i++) {
      await failLogin(`10.0.0.${i}`);
    }

    expect(failedRecords()).toEqual([]);

    await nextInterval();

    expect(failedRecords()).toHaveLength(1);
    expect(failedRecords()[0]).toEqual({
      id: 1,
      user_id: USER.pk,
      success: false,
      attempts: 10,
      ips: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`10.0.0.${i + 1}`, { attempts: 1, country: 'DE' }])),
      created_at: expect.any(String),
    });
  });

  it('counts repeated attempts from an IP and resolves its country once', async () => {
    const resolveCountry = vi.fn(async () => 'FR');
    activateWithHistory({}, { countryHeader: '', resolveCountry });
    for (let i = 0; i < 5; i++) {
      await failLogin('10.0.0.1');
    }
    await nextInterval();

    expect(failedRecords()[0].ips).toEqual({ '10.0.0.1': { attempts: 5, country: 'FR' } });
    expect(resolveCountry).toHaveBeenCalledTimes(1);
  });

  it('keeps maxIpsPerLog IPs in a record and still counts attempts from the rest', async () => {
    activateWithHistory({ maxIpsPerLog: 2 });
    await failLogin('10.0.0.1');
    await failLogin('10.0.0.2');
    await failLogin('10.0.0.3');
    await failLogin('10.0.0.1');
    await nextInterval();

    expect(failedRecords()[0].attempts).toEqual(4);
    expect(Object.keys(failedRecords()[0].ips)).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('truncates an oversized IP from client headers', async () => {
    activateWithHistory();
    await failLogin('1'.repeat(1000));
    await nextInterval();

    expect(Object.keys(failedRecords()[0].ips)[0]).toHaveLength(64);
  });

  it('counts attempts from an unknown IP without adding it to ips', async () => {
    activateWithHistory();
    await adminforth.config.auth.afterLoginFailed[0]({
      username: USER.username,
      pk: USER.pk,
      reason: 'invalid_password',
      adminforth,
      extra: extraOf({ 'user-agent': CHROME_MAC_UA }),
    });
    await failLogin('10.0.0.1');
    await nextInterval();

    expect(failedRecords()[0].attempts).toEqual(2);
    expect(failedRecords()[0].ips).toEqual({ '10.0.0.1': { attempts: 1, country: 'DE' } });
  });

  it('does not store attempts with unknown username or rejected before credentials check', async () => {
    activateWithHistory();
    await failLogin('10.0.0.1', 'user_not_found', null);
    await failLogin('10.0.0.1', 'rejected', null);
    await nextInterval();

    expect(failedRecords()).toEqual([]);
  });

  it('writes a record per interval with attempts and nothing for an interval without them', async () => {
    activateWithHistory();
    await failLogin('10.0.0.1');
    await nextInterval();
    await nextInterval();
    await failLogin('10.0.0.1');
    await failLogin('10.0.0.1');
    await nextInterval();

    expect(failedRecords().map((record) => record.attempts)).toEqual([1, 2]);
  });

  it('does not write failed attempts until database discovery, which never happens while bundling', async () => {
    activate({ loginHistory: LOGIN_HISTORY });
    await failLogin('10.0.0.1');
    await nextInterval();

    expect(failedRecords()).toEqual([]);
  });

  it('honors failedLogsInterval', async () => {
    activateWithHistory({ failedLogsInterval: '5m' });
    await failLogin('10.0.0.1');
    await nextInterval();

    expect(failedRecords()).toEqual([]);

    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(failedRecords()).toHaveLength(1);
  });

  it('keeps maxFailedLogsPerUser newest failed records of a user and all sign-ins', async () => {
    activateWithHistory({ maxFailedLogsPerUser: 2 });
    await login('session-1');
    for (let i = 1; i <= 3; i++) {
      await failLogin(`10.0.0.${i}`);
      await nextInterval();
    }

    expect(failedRecords().map((record) => Object.keys(record.ips))).toEqual([['10.0.0.2'], ['10.0.0.3']]);
    expect(adminforth.loginHistory.records.filter((record) => record.success)).toHaveLength(1);
  });
});
