import type { KeyValueAdapter, PluginsCommonOptions } from "adminforth";

/**
 * What is stored in key-value adapter under `<user pk>:<session id>` key for every active session.
 */
export interface UserSessionRecord {
  ip: string | null;
  country: string | null;
  created_at: string;
  last_used_at: string;
}

/**
 * One session as it is returned to the settings page.
 */
export interface UserSessionListItem extends UserSessionRecord {
  sessionId: string;
  isCurrent: boolean;
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
   * How often `last_used_at` of a session is refreshed, in seconds. Default is 60.
   * Every refresh is one write to the adapter, so lower values give more precise
   * "last used" at cost of more writes.
   */
  lastUsedThrottleSeconds?: number;
}
