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

/**
 * What is stored in key-value adapter under `<user pk>:<device id>` key for every device the user signed in from.
 * Device id is a random id kept in a long-lived cookie of the browser.
 */
export interface KnownDeviceRecord {
  /** Browser and OS without versions, so a browser update does not make the device look new. */
  device: SessionDevice | null;
  /** Every country the user signed in from on this device. */
  countries: string[];
  first_seen: string;
  last_seen: string;
}

export type NewLoginReason = 'new_device' | 'new_country';

export interface NewLoginParams {
  pk: string | null;
  username: string;
  session: Omit<UserSessionListItem, 'isCurrent'>;
  reasons: NewLoginReason[];
  /**
   * Path of the page where the user sees this sign-in and can end the session, with a token in the query.
   * It starts with `baseUrl` of the app, prepend the origin of your admin panel to make a link:
   * the origin of the sign-in request is controlled by whoever signed in, so the plugin doesn't use it.
   */
  revokePath: string;
}

/**
 * Payload of the token in {@link NewLoginParams.revokePath}.
 */
export interface RevokeTokenPayload {
  pk: string | null;
  sessionId: string;
  deviceId: string;
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

  /**
   * Called after a sign-in from a device or a country the user has not signed in from before, e.g. to
   * notify the user in email or Slack. The first sign-in of a user is reported as well.
   *
   * Devices are recognized by a long-lived cookie and are tracked only while the option is set.
   * The callback is not awaited, so a slow handler doesn't delay the sign-in, its errors are logged.
   */
  onNewLogin?: (params: NewLoginParams) => Promise<void>;
}
