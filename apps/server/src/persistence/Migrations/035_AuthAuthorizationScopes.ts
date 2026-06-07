import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const standardClientScopes = JSON.stringify([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
]);
const administrativeScopes = JSON.stringify([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
]);

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  const pairingLinksHaveScopes = hasColumn(pairingLinkColumns, "scopes");
  const pairingLinksHaveRole = hasColumn(pairingLinkColumns, "role");
  const sessionsHaveScopes = hasColumn(sessionColumns, "scopes");
  const sessionsHaveRole = hasColumn(sessionColumns, "role");

  if (!pairingLinksHaveScopes || pairingLinksHaveRole) {
    yield* sql`DROP TABLE IF EXISTS auth_pairing_links_scoped_migration`;
    yield* sql`
      CREATE TABLE auth_pairing_links_scoped_migration (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        scopes TEXT NOT NULL,
        subject TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      )
    `;

    if (pairingLinksHaveScopes) {
      yield* sql`
        INSERT INTO auth_pairing_links_scoped_migration (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        SELECT
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        FROM auth_pairing_links
      `;
    } else {
      yield* sql`
        INSERT INTO auth_pairing_links_scoped_migration (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        SELECT
          id,
          credential,
          method,
          CASE role
            WHEN 'owner' THEN ${administrativeScopes}
            ELSE ${standardClientScopes}
          END AS scopes,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        FROM auth_pairing_links
      `;
    }

    yield* sql`DROP TABLE auth_pairing_links`;
    yield* sql`ALTER TABLE auth_pairing_links_scoped_migration RENAME TO auth_pairing_links`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
    ON auth_pairing_links(revoked_at, consumed_at, expires_at)
  `;

  if (!sessionsHaveScopes || sessionsHaveRole) {
    yield* sql`DROP TABLE IF EXISTS auth_sessions_scoped_migration`;
    yield* sql`
      CREATE TABLE auth_sessions_scoped_migration (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        scopes TEXT NOT NULL,
        method TEXT NOT NULL,
        client_label TEXT,
        client_ip_address TEXT,
        client_user_agent TEXT,
        client_device_type TEXT NOT NULL DEFAULT 'unknown',
        client_os TEXT,
        client_browser TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_connected_at TEXT,
        revoked_at TEXT
      )
    `;

    if (sessionsHaveScopes) {
      yield* sql`
        INSERT INTO auth_sessions_scoped_migration (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        )
        SELECT
          session_id,
          subject,
          scopes,
          CASE method
            WHEN 'bearer-session-token' THEN 'bearer-access-token'
            ELSE method
          END AS method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        FROM auth_sessions
      `;
    } else {
      yield* sql`
        INSERT INTO auth_sessions_scoped_migration (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        )
        SELECT
          session_id,
          subject,
          CASE role
            WHEN 'owner' THEN ${administrativeScopes}
            ELSE ${standardClientScopes}
          END AS scopes,
          CASE method
            WHEN 'bearer-session-token' THEN 'bearer-access-token'
            ELSE method
          END AS method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        FROM auth_sessions
      `;
    }

    yield* sql`DROP TABLE auth_sessions`;
    yield* sql`ALTER TABLE auth_sessions_scoped_migration RENAME TO auth_sessions`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at)
  `;
});
