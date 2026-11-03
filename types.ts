import type { AdminUser, KeyValueAdapter, PeriodString, PluginsCommonOptions } from "adminforth";

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
  /**
   * Present for sessions signed in while {@link PluginOptions.onSessionCopied} is set.
   * It is a secret of the browser, so it is never sent to the frontend or passed to callbacks.
   */
  nonce?: SessionNonce;
}

/**
 * State of the nonce cookie of a session. Its value is replaced from time to time, so a copy of the session
 * in another browser falls behind and gives itself away with an outdated value.
 */
export interface SessionNonce {
  /** Value the browser should send. */
  current: string;
  /** When a request with `current` came first, null until then: the browser may not have got it yet. */
  current_seen_at: string | null;
  /** Value replaced by `current`, still accepted from requests sent before the browser got `current`. */
  previous: string | null;
  /**
   * Value which becomes `current` on the next rotation. It is chosen in advance, so parallel requests
   * which rotate at once give the browser the same value.
   */
  next: string;
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
export interface UserSessionListItem extends Omit<UserSessionRecord, 'nonce'> {
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

export interface SessionCopiedParams {
  pk: string | null;
  username: string;
  /** The session as it was signed in. It is revoked already, so both browsers are signed out of it. */
  session: Omit<UserSessionListItem, 'isCurrent'>;
  /**
   * Request which came with an outdated nonce cookie. It is sent either by the user or by whoever copied
   * the session, there is no way to tell which one.
   */
  request: {
    ip: string | null;
    country: string | null;
    device: SessionDevice | null;
  };
}

/**
 * Payload of the token in {@link NewLoginParams.revokePath}.
 */
export interface RevokeTokenPayload {
  pk: string | null;
  sessionId: string;
  deviceId: string;
}

/**
 * One IP in the `ips` column of a failed attempts record.
 */
export interface FailedLoginIp {
  attempts: number;
  country: string | null;
}

/**
 * Names of columns in the login history resource.
 *
 * A sign-in is stored with `ip`, `country` and `user_agent`, `attempts` is 1 and `ips` is empty.
 * Failed attempts of a user are stored as one record per {@link LoginHistoryOptions.failedLogsInterval}:
 * `attempts` is their total and `ips` is a JSON object of {@link FailedLoginIp} by IP,
 * `ip`, `country` and `user_agent` are empty.
 */
export interface LoginHistoryColumns {
  /** Should be same type as primary key of users resource. */
  userIdColumnName: string;
  /** Boolean, `true` for a sign-in, `false` for failed attempts. */
  successColumnName: string;
  /** Integer. */
  attemptsColumnName: string;
  /** String. */
  ipColumnName: string;
  /** String, two-letter country code. */
  countryColumnName: string;
  /** String, at least 512 characters. */
  userAgentColumnName: string;
  /** JSON. Enable `filterOptions.substringSearch` on it to find records by IP. */
  ipsColumnName: string;
  /** Datetime. For failed attempts it is the time of the first attempt in the record. */
  createdAtColumnName: string;
}

export interface LoginHistoryOptions {
  /**
   * Resource where sign-ins and failed sign-in attempts are stored.
   */
  resourceId: string;

  /**
   * Failed attempts are counted in memory and written as one record per user once per this period,
   * so a bruteforce of any rate costs one write per attacked user. Default is `1m`.
   * Attempts counted since the last write are lost on restart.
   */
  failedLogsInterval?: PeriodString;

  /**
   * How many IPs are kept in `ips` of one failed attempts record. Default is 100.
   * Attempts from other IPs are still counted in `attempts`.
   */
  maxIpsPerLog?: number;

  /**
   * How many failed attempts records are kept for one user, older ones are deleted. Default is 100.
   * Sign-ins are not limited, remove them by age with the auto-remove plugin.
   */
  maxFailedLogsPerUser?: number;

  resourceColumns: LoginHistoryColumns;
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
   * Decides whether `adminUser` sees IP addresses of sessions, own ones included, e.g. to hide them on a
   * public demo where everybody signs in as the same user. Return `true` to show them.
   *
   * When the option is not set, IPs are shown to everybody who sees the sessions.
   * Hidden IPs are not sent to the browser at all, the page shows them masked.
   */
  canSeeIps?: (adminUser: AdminUser) => Promise<boolean>;

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

  /**
   * Called when a session turns out to be used in two browsers, which means its cookies were copied,
   * e.g. stolen by malware. The session is revoked before the call, so both browsers are signed out.
   *
   * Every session gets a cookie with a nonce which is replaced every {@link PluginOptions.nonceRotationMinutes},
   * a request with an outdated nonce tells that another browser holds a copy. Only sessions signed in while
   * the option is set are checked.
   * The callback is not awaited, so a slow handler doesn't delay the response, its errors are logged.
   */
  onSessionCopied?: (params: SessionCopiedParams) => Promise<void>;

  /**
   * How often the nonce cookie of {@link PluginOptions.onSessionCopied} is replaced, in minutes. Default is 5.
   * Every replacement is two writes to the adapter: the replacement itself and the first request with the new value,
   * so lower values find a copy sooner at cost of more writes.
   */
  nonceRotationMinutes?: number;

  /**
   * Stores sign-ins and failed password attempts in a resource, see {@link LoginHistoryOptions}.
   */
  loginHistory?: LoginHistoryOptions;
}
