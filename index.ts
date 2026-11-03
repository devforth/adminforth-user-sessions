import { AdminForthPlugin, afLogger, convertPeriodToSeconds, Filters, Sorts } from "adminforth";
import type {
  AdminForthComponentDeclarationFull,
  AdminUser,
  AdminUserAuthorizeFunction,
  AfterLoginFailedFunction,
  AfterSessionCreatedFunction,
  BeforeLogoutFunction,
  HttpExtra,
  IAdminForth,
  IAdminForthHttpResponse,
  IHttpServer,
  KeyValueAdapter,
} from "adminforth";
import { z } from "zod";
import { FailedLoginsBuffer } from "./failedLoginsBuffer.js";
import { checkNonce, createNonce } from "./sessionNonce.js";
import type {
  KnownDeviceRecord,
  LoginHistoryOptions,
  NewLoginReason,
  PluginOptions,
  RevokeTokenPayload,
  SessionDevice,
  SessionNonce,
  UserSessionListItem,
  UserSessionRecord,
} from "./types.js";
import { parseUserAgent } from "./userAgent.js";

const DEFAULT_COLLECTION = 'adminforth-user-sessions';
const DEFAULT_COUNTRY_HEADER = 'CF-IPCountry';
const DEFAULT_LAST_USED_THROTTLE_SECONDS = 60;
const DEFAULT_NONCE_ROTATION_MINUTES = 5;
// way longer than a request takes between reading the session and writing it back in touchSession
const REVOKE_REPEAT_DELAY_MS = 5000;
const ENDPOINTS_PREFIX = '/plugin/user-sessions';
// listing is done for one user only, so the limit is just a sanity cap
const PER_USER_LIST_LIMIT = 500;
// sessions of all users are revoked in batches, so the whole store is never loaded at once
const REVOKE_ALL_BATCH_SIZE = 500;
// real user agents are well under this; the header itself is client-controlled and can be ~16KB
const USER_AGENT_MAX_LENGTH = 512;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const DEVICE_COOKIE = 'device';
const NONCE_COOKIE = 'session_nonce';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_DEVICE_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
const REVOKE_TOKEN_TYPE = 'userSessionRevoke';
const REVOKE_PAGE_PATH = 'user-sessions/revoke';
const INVALID_LINK_ERROR = 'Link is invalid or expired';
const DEFAULT_FAILED_LOGS_INTERVAL = '1m';
const DEFAULT_MAX_IPS_PER_LOG = 100;
const DEFAULT_MAX_FAILED_LOGS_PER_USER = 100;
// IPv6 is at most 45 characters; the IP comes from client-controlled headers and becomes a JSON key
const IP_MAX_LENGTH = 64;

const listBodySchema = z.object({
  userPk: z.string().optional(),
}).strict();

const revokeBodySchema = z.object({
  sessionId: z.string(),
  userPk: z.string().optional(),
}).strict();

const tokenBodySchema = z.object({
  token: z.string(),
}).strict();

export default class UserSessionsPlugin extends AdminForthPlugin {
  options: PluginOptions;
  pluginsScope: 'global' = 'global';
  private loginHistoryPkColumn?: string;
  private failedLogins?: FailedLoginsBuffer;

  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
    this.shouldHaveSingleInstancePerWholeApp = () => true;
  }

  instanceUniqueRepresentation(): string {
    return 'single';
  }

  modifyGlobalConfig(adminforth: IAdminForth) {
    super.modifyGlobalConfig(adminforth);

    const auth = adminforth.config.auth!;
    if (!auth.afterSessionCreated) {
      throw new Error(
        'User sessions plugin requires AdminForth which supports auth.afterSessionCreated hook, please update adminforth package'
      );
    }

    (auth.afterSessionCreated as AfterSessionCreatedFunction[]).push(
      async ({ pk, username, sessionId, expiresInSeconds, extra }) => {
        const session = await this.storeSession(pk, sessionId, expiresInSeconds, extra);
        if (this.options.loginHistory) {
          await this.logSignIn(this.options.loginHistory, pk, session);
        }
        if (this.options.onNewLogin && extra) {
          await this.trackDevice({ pk, username, sessionId, expiresInSeconds, extra, session });
        }
      }
    );

    if (this.options.loginHistory) {
      this.trackFailedLogins(this.options.loginHistory);
    }

    // unshifted: a revoked session must be rejected before any other hook lets it do work
    (auth.adminUserAuthorize as AdminUserAuthorizeFunction[]).unshift(
      // params are declared optional by AdminForth type, but are always passed
      async (params) => this.authorizeSession(params!.adminUser, params!.extra!)
    );

    (auth.beforeLogout as BeforeLogoutFunction[]).push(
      async ({ adminUser }) => {
        if (!adminUser?.sessionId) {
          return;
        }
        // older AdminForth releases abort logout and keep the auth cookie when a beforeLogout hook throws
        try {
          await this.revokeSession(userKey(adminUser.pk, adminUser.sessionId));
        } catch (e) {
          afLogger.error(`UserSessionsPlugin: failed to revoke session on logout: ${e}`);
        }
      }
    );

    auth.userMenuSettingsPages ??= [];
    auth.userMenuSettingsPages.push({
      icon: 'lucide:monitor-smartphone',
      pageLabel: 'Active sessions',
      slug: 'user-sessions',
      component: this.componentPath('UserSessions.vue'),
      // page is dropped from /get_config when isVisible is not set
      isVisible: () => true,
    });

    if (this.options.canManageOtherUsersSessions) {
      this.showSessionsOnUsersResource(adminforth, auth.usersResourceId!);
    }

    if (this.options.onNewLogin) {
      // opened from a notification, so it must work without signing in
      adminforth.config.customization.customPages.push({
        path: `/${REVOKE_PAGE_PATH}`,
        component: { file: this.componentPath('RevokeSession.vue'), meta: { sidebarAndHeader: 'none' } },
      });
    }
  }

  validateConfigAfterDiscover(adminforth: IAdminForth) {
    const loginHistory = this.options.loginHistory;
    if (!loginHistory) {
      return;
    }
    const resource = adminforth.config.resources.find((res) => res.resourceId === loginHistory.resourceId);
    if (!resource) {
      throw new Error(`UserSessionsPlugin: loginHistory resource "${loginHistory.resourceId}" not found`);
    }
    for (const columnName of Object.values(loginHistory.resourceColumns)) {
      if (!resource.columns.some((column) => column.name === columnName)) {
        throw new Error(`UserSessionsPlugin: column "${columnName}" not found in loginHistory resource "${resource.resourceId}"`);
      }
    }
    this.loginHistoryPkColumn = resource.columns.find((column) => column.primaryKey)!.name;

    // started after discovery only: data API doesn't work before it, and bundling at build time never discovers
    const intervalMs = convertPeriodToSeconds(loginHistory.failedLogsInterval ?? DEFAULT_FAILED_LOGS_INTERVAL) * 1000;
    setInterval(() => {
      this.storeFailedLogins(loginHistory, this.failedLogins!).catch((e) => {
        afLogger.error(`UserSessionsPlugin: failed to store failed login attempts: ${e}`);
      });
    }, intervalMs).unref();
  }

  private async logSignIn(loginHistory: LoginHistoryOptions, pk: string | null, session: UserSessionRecord) {
    const columns = loginHistory.resourceColumns;
    const { error } = await this.adminforth.resource(loginHistory.resourceId).create({
      [columns.userIdColumnName]: pk,
      [columns.successColumnName]: true,
      [columns.attemptsColumnName]: 1,
      [columns.ipColumnName]: session.ip,
      [columns.countryColumnName]: session.country,
      [columns.userAgentColumnName]: session.user_agent,
      [columns.createdAtColumnName]: session.created_at,
    });
    if (error) {
      afLogger.error(`UserSessionsPlugin: failed to store sign-in in login history: ${error}`);
    }
  }

  /**
   * Counts failed password attempts in memory, `validateConfigAfterDiscover` starts writing them once per
   * `failedLogsInterval`, so database load does not grow with the rate of a bruteforce.
   */
  private trackFailedLogins(loginHistory: LoginHistoryOptions) {
    const auth = this.adminforth.config.auth!;
    if (!auth.afterLoginFailed) {
      throw new Error(
        'User sessions plugin requires AdminForth which supports auth.afterLoginFailed hook to store login history, please update adminforth package'
      );
    }

    const failedLogins = new FailedLoginsBuffer(loginHistory.maxIpsPerLog ?? DEFAULT_MAX_IPS_PER_LOG);
    this.failedLogins = failedLogins;
    (auth.afterLoginFailed as AfterLoginFailedFunction[]).push(
      async ({ pk, reason, extra }) => {
        // unknown usernames are not stored: anyone could create records for them at will,
        // and a mistyped username is often the password
        if (reason !== 'invalid_password') {
          return;
        }
        // typed as string, but private addresses (e.g. localhost) come as null
        const ip = this.adminforth.auth.getClientIp(extra.headers)?.slice(0, IP_MAX_LENGTH) ?? null;
        await failedLogins.add(pk!, ip, () => this.resolveCountry(ip, extra.headers));
      }
    );
  }

  /**
   * Writes one record per user with counted attempts, then deletes failed attempts records of the user
   * above `maxFailedLogsPerUser`.
   */
  private async storeFailedLogins(loginHistory: LoginHistoryOptions, failedLogins: FailedLoginsBuffer) {
    const columns = loginHistory.resourceColumns;
    const resource = this.adminforth.resource(loginHistory.resourceId);
    const pkColumn = this.loginHistoryPkColumn!;

    for (const [pk, userLogins] of failedLogins.drain()) {
      const { error } = await resource.create({
        [columns.userIdColumnName]: pk,
        [columns.successColumnName]: false,
        [columns.attemptsColumnName]: userLogins.attempts,
        [columns.ipsColumnName]: Object.fromEntries(userLogins.ips),
        [columns.createdAtColumnName]: userLogins.first_attempt_at,
      });
      if (error) {
        afLogger.error(`UserSessionsPlugin: failed to store failed login attempts of user ${pk}: ${error}`);
      }

      const outdated = await resource.list(
        [Filters.EQ(columns.userIdColumnName, pk), Filters.EQ(columns.successColumnName, false)],
        undefined,
        loginHistory.maxFailedLogsPerUser ?? DEFAULT_MAX_FAILED_LOGS_PER_USER,
        Sorts.DESC(columns.createdAtColumnName),
        [pkColumn],
      );
      await Promise.all(outdated.map((record) => resource.delete(record[pkColumn])));
    }
  }

  /**
   * Adds sessions block to the show page of the users resource, so privileged users can see and
   * revoke sessions of the user they are looking at.
   */
  private showSessionsOnUsersResource(adminforth: IAdminForth, usersResourceId: string) {
    const usersResource = adminforth.config.resources.find(
      (resource) => resource.resourceId === usersResourceId,
    )!;
    const pageInjections = (usersResource.options!.pageInjections ??= {});
    const showInjections = (pageInjections.show ??= {});
    showInjections.bottom ??= [];

    (showInjections.bottom as AdminForthComponentDeclarationFull[]).push({
      file: this.componentPath('UserSessionsOfUser.vue'),
      meta: {
        primaryKeyField: usersResource.columns.find((column) => column.primaryKey)!.name,
      },
    });
  }

  /**
   * Own sessions are always managable, sessions of other users only when the app allows it.
   */
  private async canManage(adminUser: AdminUser, userPk: string | null): Promise<boolean> {
    if (String(userPk) === String(adminUser.pk)) {
      return true;
    }
    return this.options.canManageOtherUsersSessions
      ? await this.options.canManageOtherUsersSessions(adminUser)
      : false;
  }

  private get kv(): KeyValueAdapter {
    return this.options.keyValueAdapter;
  }

  private get collection(): string {
    return this.options.collection ?? DEFAULT_COLLECTION;
  }

  private get devicesCollection(): string {
    return `${this.collection}-devices`;
  }

  private async storeSession(
    pk: string | null, sessionId: string, expiresInSeconds: number, extra?: HttpExtra,
  ): Promise<UserSessionRecord> {
    const headers = extra?.headers ?? {};
    const ip = extra ? this.adminforth.auth.getClientIp(headers) : null;
    const now = new Date().toISOString();
    const record: UserSessionRecord = {
      ip,
      country: await this.resolveCountry(ip, headers),
      user_agent: headers['user-agent']?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      created_at: now,
      last_used_at: now,
    };
    // the browser gets the nonce along with the auth cookie, a session signed in without a response is not checked
    let nonce: SessionNonce | undefined;
    if (this.options.onSessionCopied && extra) {
      nonce = createNonce();
      this.setNonceCookie(extra.response, nonce.current, expiresInSeconds);
    }
    await this.kv.set(userKey(pk, sessionId), JSON.stringify({ ...record, nonce }), expiresInSeconds, this.collection);
    return record;
  }

  private setNonceCookie(response: IAdminForthHttpResponse, value: string, expirySeconds?: number) {
    this.adminforth.auth.setCustomCookie({
      response,
      payload: { name: NONCE_COOKIE, value, expirySeconds, httpOnly: true },
    });
  }

  /**
   * Recognizes the browser by a long-lived device cookie and reports the sign-in when the device or
   * the country is new for the user. The first sign-in of a user is reported too, its device is new.
   */
  private async trackDevice({ pk, username, sessionId, expiresInSeconds, extra, session }: {
    pk: string | null,
    username: string,
    sessionId: string,
    expiresInSeconds: number,
    extra: HttpExtra,
    session: UserSessionRecord,
  }) {
    const auth = this.adminforth.auth;
    const cookie = auth.getCustomCookie({ cookies: extra.cookies, name: DEVICE_COOKIE });
    // the cookie comes from the client, a malformed one is replaced like a missing one
    const deviceId = cookie && UUID_RE.test(cookie) ? cookie : crypto.randomUUID();
    // set again on every sign-in: browsers cap cookie lifetime, Chromium at 400 days
    auth.setCustomCookie({
      response: extra.response,
      payload: { name: DEVICE_COOKIE, value: deviceId, expirySeconds: KNOWN_DEVICE_TTL_SECONDS, httpOnly: true },
    });

    const knownDevices = await this.listOfUser<KnownDeviceRecord>(pk, this.devicesCollection);
    const device = parseUserAgent(session.user_agent, false);
    const known = knownDevices.find(([id]) => id === deviceId)?.[1];
    // a known cookie in another browser was copied there, so the device is not the known one
    const previous = known && isSameDevice(known.device, device) ? known : undefined;
    const { country } = session;

    const reasons: NewLoginReason[] = [];
    if (!previous) {
      reasons.push('new_device');
    }
    if (country && !knownDevices.some(([, record]) => record.countries.includes(country))) {
      reasons.push('new_country');
    }

    const countries = previous?.countries ?? [];
    const now = new Date().toISOString();
    const record: KnownDeviceRecord = {
      device,
      countries: country && !countries.includes(country) ? [...countries, country] : countries,
      first_seen: previous?.first_seen ?? now,
      last_seen: now,
    };
    await this.kv.set(userKey(pk, deviceId), JSON.stringify(record), KNOWN_DEVICE_TTL_SECONDS, this.devicesCollection);

    if (!reasons.length) {
      return;
    }

    const tokenPayload: RevokeTokenPayload = { pk, sessionId, deviceId };
    const token = auth.issueJWT(tokenPayload, REVOKE_TOKEN_TYPE, expiresInSeconds);
    // not awaited: a slow handler (e.g. a request to Slack) must not delay the sign-in
    this.options.onNewLogin!({
      pk,
      username,
      session: { ...session, sessionId, device: parseUserAgent(session.user_agent) },
      reasons,
      revokePath: `${this.adminforth.config.baseUrlSlashed}${REVOKE_PAGE_PATH}?token=${token}`,
    }).catch((e) => {
      afLogger.error(`UserSessionsPlugin: onNewLogin failed: ${e}`);
    });
  }

  private async verifyRevokeToken(token: string): Promise<RevokeTokenPayload | null> {
    return await this.adminforth.auth.verify(token, REVOKE_TOKEN_TYPE, false) as RevokeTokenPayload | null;
  }

  /**
   * Revokes every stored session of every user, the caller's own one included, so everybody is signed
   * out on their next request. Known devices are kept. Returns the number of revoked sessions.
   */
  async revokeAllSessions(): Promise<number> {
    let revoked = 0;
    let keys: string[];
    do {
      const rows = await this.kv.listByPrefix('', REVOKE_ALL_BATCH_SIZE, this.collection);
      keys = rows.map((row) => Object.keys(row)[0]);
      await Promise.all(keys.map((key) => this.revokeSession(key)));
      revoked += keys.length;
    } while (keys.length === REVOKE_ALL_BATCH_SIZE);
    return revoked;
  }

  /**
   * Deletes the session, then deletes it once more a bit later: a request which read the session
   * right before the first delete may still write it back while refreshing `last_used_at`.
   */
  private async revokeSession(key: string) {
    await this.kv.delete(key, this.collection);
    setTimeout(() => {
      this.kv.delete(key, this.collection).catch((e) => {
        afLogger.error(`UserSessionsPlugin: failed to repeat revoke of session: ${e}`);
      });
    }, REVOKE_REPEAT_DELAY_MS).unref();
  }

  private async resolveCountry(ip: string | null, headers: Record<string, string>): Promise<string | null> {
    const headerName = this.options.countryHeader ?? DEFAULT_COUNTRY_HEADER;
    if (headerName) {
      const fromHeader = String(headers[headerName.toLowerCase()] ?? '').toUpperCase();
      // CDNs answer with a placeholder (e.g. Cloudflare sends XX) when they can't tell the country
      if (COUNTRY_CODE_RE.test(fromHeader) && fromHeader !== 'XX') {
        return fromHeader;
      }
    }
    if (this.options.resolveCountry) {
      return await this.options.resolveCountry({ ip, headers });
    }
    return null;
  }

  private async authorizeSession(adminUser: AdminUser, extra: HttpExtra): Promise<{ allowed: boolean, error?: string }> {
    if (!adminUser.sessionId) {
      // no session to check: request is done by an api key (e.g. MCP plugin) or by a token
      // issued before this plugin was installed
      return { allowed: true };
    }

    const key = userKey(adminUser.pk, adminUser.sessionId);
    const stored = await this.kv.get(key, this.collection);
    if (!stored) {
      return { allowed: false, error: 'Session was revoked' };
    }

    const record = JSON.parse(stored) as UserSessionRecord;
    let nonce = record.nonce;
    // sessions signed in before onSessionCopied was set have no nonce and are not checked
    if (this.options.onSessionCopied && nonce) {
      const cookie = this.adminforth.auth.getCustomCookie({ cookies: extra.cookies, name: NONCE_COOKIE });
      const rotationIntervalMs = (this.options.nonceRotationMinutes ?? DEFAULT_NONCE_ROTATION_MINUTES) * 60 * 1000;
      const check = checkNonce(nonce, cookie, new Date(), rotationIntervalMs);
      if (!check) {
        await this.revokeCopiedSession(key, adminUser, record, extra);
        return { allowed: false, error: 'Session is used in two browsers' };
      }
      // a websocket handshake can't set it, the browser gets it on the next request with the previous value
      if (check.sendCookie) {
        this.setNonceCookie(extra.response, check.nonce.current, secondsLeft(adminUser.exp));
      }
      nonce = check.nonce;
    }

    await this.touchSession(key, { ...record, nonce }, adminUser.exp, nonce !== record.nonce);
    return { allowed: true };
  }

  /**
   * Revokes a session found in two browsers and reports it. The request may come from either of them,
   * so both are signed out.
   */
  private async revokeCopiedSession(key: string, adminUser: AdminUser, record: UserSessionRecord, extra: HttpExtra) {
    await this.revokeSession(key);

    const { nonce, ...session } = record;
    const ip = this.adminforth.auth.getClientIp(extra.headers);
    // not awaited: a slow handler (e.g. a request to Slack) must not delay the response
    this.resolveCountry(ip, extra.headers)
      .then((country) => this.options.onSessionCopied!({
        pk: adminUser.pk,
        username: adminUser.username,
        session: { ...session, sessionId: adminUser.sessionId!, device: parseUserAgent(session.user_agent) },
        request: { ip, country, device: parseUserAgent(extra.headers['user-agent']) },
      }))
      .catch((e) => {
        afLogger.error(`UserSessionsPlugin: onSessionCopied failed: ${e}`);
      });
  }

  /**
   * Writes the session back when its nonce changed, and to refresh `last_used_at` not more often than once per
   * `lastUsedThrottleSeconds`. Record is rewritten, so remaining lifetime of the token is re-applied as expiration.
   */
  private async touchSession(key: string, record: UserSessionRecord, tokenExpiresAt: number | undefined, nonceChanged: boolean) {
    const throttleMs = (this.options.lastUsedThrottleSeconds ?? DEFAULT_LAST_USED_THROTTLE_SECONDS) * 1000;
    if (!nonceChanged && Date.now() - new Date(record.last_used_at).getTime() < throttleMs) {
      return;
    }

    const expiresInSeconds = secondsLeft(tokenExpiresAt);
    if (expiresInSeconds !== undefined && expiresInSeconds <= 0) {
      return;
    }

    await this.kv.set(
      key,
      JSON.stringify({ ...record, last_used_at: new Date().toISOString() }),
      expiresInSeconds,
      this.collection,
    );
  }

  /**
   * Records of one user in the collection as `[id, record]` pairs, keys there are `<user pk>:<id>`.
   */
  private async listOfUser<T>(pk: string | null, collection: string): Promise<[string, T][]> {
    const rows = await this.kv.listByPrefix(`${pk}:`, PER_USER_LIST_LIMIT, collection);
    return rows.map((row) => {
      const [key] = Object.keys(row);
      return [key.slice(key.lastIndexOf(':') + 1), JSON.parse(row[key]) as T];
    });
  }

  private async listSessions(userPk: string | null, currentSessionId?: string): Promise<UserSessionListItem[]> {
    const records = await this.listOfUser<UserSessionRecord>(userPk, this.collection);

    return records
      .map(([sessionId, { nonce, ...record }]) => ({
        ...record,
        sessionId,
        isCurrent: sessionId === currentSessionId,
        device: parseUserAgent(record.user_agent),
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/list`,
      request_schema: listBodySchema,
      handler: async ({ adminUser, body }) => {
        const userPk = body.userPk ?? adminUser.pk;
        if (!await this.canManage(adminUser, userPk)) {
          return { allowed: false, sessions: [] };
        }
        const ipsVisible = this.options.canSeeIps ? await this.options.canSeeIps(adminUser) : true;
        const sessions = await this.listSessions(userPk, adminUser.sessionId);
        return {
          allowed: true,
          ipsVisible,
          sessions: ipsVisible ? sessions : sessions.map((session) => ({ ...session, ip: null })),
        };
      },
    });

    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/revoke`,
      request_schema: revokeBodySchema,
      handler: async ({ adminUser, body, response }) => {
        const userPk = body.userPk ?? adminUser.pk;
        if (!await this.canManage(adminUser, userPk)) {
          response.setStatus(403);
          return { error: 'Not allowed to manage sessions of this user' };
        }
        await this.revokeSession(userKey(userPk, body.sessionId));
        return { ok: true };
      },
    });

    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/revoke-others`,
      request_schema: listBodySchema,
      handler: async ({ adminUser, body, response }) => {
        const userPk = body.userPk ?? adminUser.pk;
        if (!await this.canManage(adminUser, userPk)) {
          response.setStatus(403);
          return { error: 'Not allowed to manage sessions of this user' };
        }
        // session the request is made with survives, for another user it means all of their sessions go
        const sessions = await this.listSessions(userPk, adminUser.sessionId);
        const revoked = sessions.filter((session) => !session.isCurrent);
        await Promise.all(revoked.map((session) => this.revokeSession(userKey(userPk, session.sessionId))));
        return { ok: true, revoked: revoked.length };
      },
    });

    // endpoints of the page linked from onNewLogin notifications: the token is the only credential there
    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/session-by-token`,
      noAuth: true,
      agent: { hiddenFromAgents: true },
      request_schema: tokenBodySchema,
      handler: async ({ body, response }) => {
        const token = await this.verifyRevokeToken(body.token);
        if (!token) {
          response.setStatus(400);
          return { error: INVALID_LINK_ERROR };
        }
        const stored = await this.kv.get(userKey(token.pk, token.sessionId), this.collection);
        if (!stored) {
          return { session: null };
        }
        const { ip, country, user_agent, created_at } = JSON.parse(stored) as UserSessionRecord;
        return { session: { ip, country, created_at, device: parseUserAgent(user_agent) } };
      },
    });

    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/revoke-by-token`,
      noAuth: true,
      agent: { hiddenFromAgents: true },
      request_schema: tokenBodySchema,
      handler: async ({ body, response }) => {
        const token = await this.verifyRevokeToken(body.token);
        if (!token) {
          response.setStatus(400);
          return { error: INVALID_LINK_ERROR };
        }
        await Promise.all([
          this.revokeSession(userKey(token.pk, token.sessionId)),
          // the device is not trusted anymore, so the next sign-in from it is reported again
          this.kv.delete(userKey(token.pk, token.deviceId), this.devicesCollection),
        ]);
        return { ok: true };
      },
    });
  }
}

function userKey(pk: string | null, id: string): string {
  return `${pk}:${id}`;
}

/**
 * Remaining lifetime of the auth token, undefined when its expiration is unknown.
 */
function secondsLeft(tokenExpiresAt?: number): number | undefined {
  return tokenExpiresAt ? tokenExpiresAt - Math.floor(Date.now() / 1000) : undefined;
}

function isSameDevice(a: SessionDevice | null, b: SessionDevice | null): boolean {
  return a?.browser === b?.browser && a?.os === b?.os && a?.type === b?.type;
}
