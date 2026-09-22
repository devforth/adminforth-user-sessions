# AdminForth User Sessions plugin

Shows admin user their active sessions (one per browser they signed in from) and lets them revoke
any of those sessions. Logging out revokes the session as well, so its auth token stops working
immediately instead of staying valid until it expires.

Full documentation: [adminforth.dev/docs/tutorial/Plugins/user-sessions](https://adminforth.dev/docs/tutorial/Plugins/user-sessions/)

## Installation

```bash
npm i @adminforth/user-sessions @adminforth/key-value-adapter-redis --save
```

```ts title="./index.ts"
import UserSessionsPlugin from '@adminforth/user-sessions';
import RedisKeyValueAdapter from '@adminforth/key-value-adapter-redis';

export const admin = new AdminForth({
  ...
  globalPlugins: [
    new UserSessionsPlugin({
      keyValueAdapter: new RedisKeyValueAdapter({ redisUrl: process.env.REDIS_URL }),
    }),
  ],
  ...
});
```

Sessions then appear under "Active sessions" in the user menu settings.

To let a privileged user see and revoke sessions of other users, add `canManageOtherUsersSessions`.
The same block then appears on the show page of the users resource:

```ts
new UserSessionsPlugin({
  keyValueAdapter,
  canManageOtherUsersSessions: async (adminUser) => adminUser.dbUser.role === 'superadmin',
})
```

Without this option, sessions of other users are not shown and can't be revoked by anybody.

## How it works

- AdminForth puts a unique session id into every issued auth JWT.
- `auth.afterSessionCreated` hook stores `<user pk>:<session id>` in the key-value adapter, with
  the same expiration as the token, holding `ip`, `country`, `user_agent`, `created_at` and
  `last_used_at`.
- `auth.adminUserAuthorize` hook checks that the session of the request is still stored, and
  refreshes its `last_used_at`. A session which is not stored is rejected with 401.
- `auth.beforeLogout` hook and the revoke endpoints delete the stored session.

Because a missing record means "revoked", the store must outlive the app process: use Redis (or
another shared, persistent adapter) in production. With an in-memory adapter every restart signs
all users out. Installing the plugin also signs out everyone who was logged in before it.

Requests authorized without a session id — MCP api keys, or tokens issued before the plugin was
installed — are left alone.

## Options

| Option | Default | Description |
|---|---|---|
| `keyValueAdapter` | required | Where active sessions are stored |
| `collection` | `adminforth-user-sessions` | Collection (key prefix) used in the adapter |
| `countryHeader` | `CF-IPCountry` | Header with two-letter country code set by your CDN. Empty string disables it |
| `canManageOtherUsersSessions` | — | `(adminUser) => Promise<boolean>`. When it returns true, that user sees and can revoke sessions of other users on the users show page |
| `resolveCountry` | — | `({ ip, headers }) => Promise<string \| null>`, called when the header did not tell the country |
| `lastUsedThrottleSeconds` | `60` | How often `last_used_at` is refreshed, one adapter write per refresh |

The `Device` column shows the browser and OS parsed from the stored `User-Agent` (e.g.
`Chrome 131 on macOS`) with a desktop/mobile/tablet icon. The raw header is stored as it came, so
parsing always runs on the current plugin version.

Client IP is taken from `adminforth.auth.getClientIp`, so configure `auth.clientIpHeader` when
running behind a proxy — otherwise the IP is not trustworthy and is `null` for private addresses.

## Development

```bash
pnpm i
# hooks this plugin uses are not released yet, so point it at a local adminforth checkout
# (every `pnpm i` resets this link back to the published package)
pnpm link ../../adminforth
pnpm test
pnpm build
```
