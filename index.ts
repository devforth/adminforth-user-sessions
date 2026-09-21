import { AdminForthPlugin } from "adminforth";
import type {
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

const DEFAULT_COLLECTION = 'adminforth-user-sessions';
const DEFAULT_COUNTRY_HEADER = 'CF-IPCountry';
const DEFAULT_LAST_USED_THROTTLE_SECONDS = 60;
const ENDPOINTS_PREFIX = '/plugin/user-sessions';
// listing is done for one user only, so the limit is just a sanity cap
const SESSIONS_LIST_LIMIT = 500;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

const revokeBodySchema = z.object({
  sessionId: z.string(),
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

  private async listSessions(adminUser: AdminUser): Promise<UserSessionListItem[]> {
    const rows = await this.kv.listByPrefix(`${adminUser.pk}:`, SESSIONS_LIST_LIMIT, this.collection);

    return rows
      .map((row) => {
        const [key] = Object.keys(row);
        const sessionId = key.slice(key.lastIndexOf(':') + 1);
        return {
          ...JSON.parse(row[key]) as UserSessionRecord,
          sessionId,
          isCurrent: sessionId === adminUser.sessionId,
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'GET',
      path: `${ENDPOINTS_PREFIX}/list`,
      handler: async ({ adminUser }) => ({
        sessions: await this.listSessions(adminUser),
      }),
    });

    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/revoke`,
      request_schema: revokeBodySchema,
      handler: async ({ adminUser, body }) => {
        // key is built from pk of the caller, so one user can't revoke sessions of another one
        await this.kv.delete(sessionKey(adminUser.pk, body.sessionId), this.collection);
        return { ok: true };
      },
    });

    server.endpoint({
      method: 'POST',
      path: `${ENDPOINTS_PREFIX}/revoke-others`,
      handler: async ({ adminUser }) => {
        const sessions = await this.listSessions(adminUser);
        const revoked = sessions.filter((session) => !session.isCurrent);
        await Promise.all(
          revoked.map((session) => this.kv.delete(sessionKey(adminUser.pk, session.sessionId), this.collection))
        );
        return { ok: true, revoked: revoked.length };
      },
    });
  }
}

function sessionKey(pk: string | null, sessionId: string): string {
  return `${pk}:${sessionId}`;
}
