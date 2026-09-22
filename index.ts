import { AdminForthPlugin } from "adminforth";
import type {
  AdminForthComponentDeclarationFull,
  AdminUser,
  AdminUserAuthorizeFunction,
  AfterSessionCreatedFunction,
  BeforeLogoutFunction,
  HttpExtra,
  IAdminForth,
  IHttpServer,
  KeyValueAdapter,
} from "adminforth";
import { z } from "zod";
import type { PluginOptions, UserSessionListItem, UserSessionRecord } from "./types.js";
import { parseUserAgent } from "./userAgent.js";

const DEFAULT_COLLECTION = 'adminforth-user-sessions';
const DEFAULT_COUNTRY_HEADER = 'CF-IPCountry';
const DEFAULT_LAST_USED_THROTTLE_SECONDS = 60;
const ENDPOINTS_PREFIX = '/plugin/user-sessions';
// listing is done for one user only, so the limit is just a sanity cap
const SESSIONS_LIST_LIMIT = 500;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

const listBodySchema = z.object({
  userPk: z.string().optional(),
}).strict();

const revokeBodySchema = z.object({
  sessionId: z.string(),
  userPk: z.string().optional(),
}).strict();

export default class UserSessionsPlugin extends AdminForthPlugin {
  options: PluginOptions;
  pluginsScope: 'global' = 'global';

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
      async ({ pk, sessionId, expiresInSeconds, extra }) => {
        await this.storeSession(pk, sessionId, expiresInSeconds, extra);
      }
    );

    // unshifted: a revoked session must be rejected before any other hook lets it do work
    (auth.adminUserAuthorize as AdminUserAuthorizeFunction[]).unshift(
      // params are declared optional by AdminForth type, but are always passed
      async (params) => this.authorizeSession(params!.adminUser)
    );

    (auth.beforeLogout as BeforeLogoutFunction[]).push(
      async ({ adminUser }) => {
        if (adminUser?.sessionId) {
          await this.kv.delete(sessionKey(adminUser.pk, adminUser.sessionId), this.collection);
        }
      }
    );

    auth.userMenuSettingsPages ??= [];
    auth.userMenuSettingsPages.push({
      icon: 'flowbite:desktop-pc-outline',
      pageLabel: 'Active sessions',
      slug: 'user-sessions',
      component: this.componentPath('UserSessions.vue'),
      // page is dropped from /get_config when isVisible is not set
      isVisible: () => true,
    });

    if (this.options.canManageOtherUsersSessions) {
      this.showSessionsOnUsersResource(adminforth, auth.usersResourceId!);
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
    if (userPk === adminUser.pk) {
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

  private async storeSession(pk: string | null, sessionId: string, expiresInSeconds: number, extra?: HttpExtra) {
    const headers = extra?.headers ?? {};
    const ip = extra ? this.adminforth.auth.getClientIp(headers) : null;
    const now = new Date().toISOString();
    const record: UserSessionRecord = {
      ip,
      country: await this.resolveCountry(ip, headers),
      user_agent: headers['user-agent'] ?? null,
      created_at: now,
      last_used_at: now,
    };
    await this.kv.set(sessionKey(pk, sessionId), JSON.stringify(record), expiresInSeconds, this.collection);
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

  private async authorizeSession(adminUser: AdminUser): Promise<{ allowed: boolean, error?: string }> {
    if (!adminUser.sessionId) {
      // no session to check: request is done by an api key (e.g. MCP plugin) or by a token
      // issued before this plugin was installed
      return { allowed: true };
    }

    const key = sessionKey(adminUser.pk, adminUser.sessionId);
    const stored = await this.kv.get(key, this.collection);
    if (!stored) {
      return { allowed: false, error: 'Session was revoked' };
    }

    await this.touchSession(key, JSON.parse(stored) as UserSessionRecord, adminUser.exp);
    return { allowed: true };
  }

  /**
   * Refreshes `last_used_at`, not more often than once per `lastUsedThrottleSeconds`.
   * Record is rewritten, so remaining lifetime of the token is re-applied as expiration.
   */
  private async touchSession(key: string, record: UserSessionRecord, tokenExpiresAt?: number) {
    const throttleMs = (this.options.lastUsedThrottleSeconds ?? DEFAULT_LAST_USED_THROTTLE_SECONDS) * 1000;
    if (Date.now() - new Date(record.last_used_at).getTime() < throttleMs) {
      return;
    }

    const expiresInSeconds = tokenExpiresAt ? tokenExpiresAt - Math.floor(Date.now() / 1000) : undefined;
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

  private async listSessions(userPk: string | null, currentSessionId?: string): Promise<UserSessionListItem[]> {
    const rows = await this.kv.listByPrefix(`${userPk}:`, SESSIONS_LIST_LIMIT, this.collection);

    return rows
      .map((row) => {
        const [key] = Object.keys(row);
        const sessionId = key.slice(key.lastIndexOf(':') + 1);
        const record = JSON.parse(row[key]) as UserSessionRecord;
        return {
          ...record,
          sessionId,
          isCurrent: sessionId === currentSessionId,
          device: parseUserAgent(record.user_agent),
        };
      })
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
        return { allowed: true, sessions: await this.listSessions(userPk, adminUser.sessionId) };
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
        await this.kv.delete(sessionKey(userPk, body.sessionId), this.collection);
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
        await Promise.all(
          revoked.map((session) => this.kv.delete(sessionKey(userPk, session.sessionId), this.collection))
        );
        return { ok: true, revoked: revoked.length };
      },
    });
  }
}

function sessionKey(pk: string | null, sessionId: string): string {
  return `${pk}:${sessionId}`;
}
