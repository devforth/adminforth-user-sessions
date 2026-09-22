import type { AdminUser, KeyValueAdapter, PluginsCommonOptions } from "adminforth";

/**
 * What is stored in key-value adapter under `<user pk>:<session id>` key for every active session.
 * Raw user agent is kept as it came, so the list always shows it parsed by the current plugin version.
 */
export interface UserSessionRecord {
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
}

/**
 * Browser and device the session was created from, parsed out of the stored user agent.
 */
export interface SessionDevice {
  browser: string | null;
  os: string | null;
  type: 'desktop' | 'mobile' | 'tablet';
}

/**
 * One session as it is returned to the settings page.
 */
export interface UserSessionListItem extends UserSessionRecord {
  sessionId: string;
  isCurrent: boolean;
  /** Null when the session was stored without a user agent. */
  device: SessionDevice | null;
}

export interface PluginOptions extends PluginsCommonOptions {
  /**
   * Adapter where active sessions are stored. Redis adapter is recommended: sessions must survive
   * app restarts, be shared between app instances and expire on their own.
   */
  keyValueAdapter: KeyValueAdapter;

  /**
   * Collection (key prefix) used in the adapter. Default is `adminforth-user-sessions`.
   */
  collection?: string;

  /**
   * Request header with two-letter country code of client, set by CDN or reverse proxy.
   * Default is `CF-IPCountry` (Cloudflare). Set to empty string to not read country from headers.
   */
  countryHeader?: string;

  /**
   * Called when country was not resolved from {@link PluginOptions.countryHeader},
   * e.g. to look the IP up in your own GeoIP database. Should return two-letter country code.
   */
  resolveCountry?: (params: { ip: string | null, headers: Record<string, string> }) => Promise<string | null>;

  /**
   * Allows a privileged user (e.g. superadmin) to see and revoke sessions of other users on the
   * show page of the users resource. Return `true` when `adminUser` is allowed to do it.
   *
   * When the option is not set, sessions of other users are not shown on the show page and
   * can't be managed by anybody.
   */
  canManageOtherUsersSessions?: (adminUser: AdminUser) => Promise<boolean>;

  /**
   * How often `last_used_at` of a session is refreshed, in seconds. Default is 60.
   * Every refresh is one write to the adapter, so lower values give more precise
   * "last used" at cost of more writes.
   */
  lastUsedThrottleSeconds?: number;
}
