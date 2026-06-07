import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const makeLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

makeLayer()("035_AuthAuthorizationScopes role cutover", (it) => {
  it.effect("migrates role-based auth records to scoped auth tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          created_at,
          expires_at
        )
        VALUES (
          'link-owner',
          'bootstrap-owner',
          'desktop-bootstrap',
          'owner',
          'desktop',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          issued_at,
          expires_at
        )
        VALUES (
          'session-client',
          'phone',
          'client',
          'bearer-session-token',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      const pairingRows = yield* sql<{ readonly id: string; readonly scopes: string }>`
        SELECT id, scopes FROM auth_pairing_links
      `;
      const sessionRows = yield* sql<{
        readonly sessionId: string;
        readonly method: string;
        readonly scopes: string;
      }>`
        SELECT session_id AS "sessionId", method, scopes FROM auth_sessions
      `;

      assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
      assert.isFalse(pairingColumns.some((column) => column.name === "role"));
      assert.isTrue(sessionColumns.some((column) => column.name === "scopes"));
      assert.isFalse(sessionColumns.some((column) => column.name === "role"));
      assert.deepStrictEqual(pairingRows, [
        {
          id: "link-owner",
          scopes:
            '["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read","access:read","access:write","relay:write"]',
        },
      ]);
      assert.deepStrictEqual(sessionRows, [
        {
          sessionId: "session-client",
          method: "bearer-access-token",
          scopes:
            '["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"]',
        },
      ]);
    }),
  );
});

makeLayer()("035_AuthAuthorizationScopes scoped compatibility", (it) => {
  it.effect("preserves already-scoped auth tables on compatibility rerun", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`DROP TABLE auth_pairing_links`;
      yield* sql`DROP TABLE auth_sessions`;
      yield* sql`
        CREATE TABLE auth_pairing_links (
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
      yield* sql`
        CREATE TABLE auth_sessions (
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
      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          created_at,
          expires_at
        )
        VALUES (
          'link-scoped',
          'credential-scoped',
          'desktop-bootstrap',
          '["orchestration:read"]',
          'desktop',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          issued_at,
          expires_at
        )
        VALUES (
          'session-scoped',
          'desktop',
          '["orchestration:read"]',
          'browser-session-cookie',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const pairingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;
      const sessionRows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
      `;

      assert.deepStrictEqual(pairingRows, [{ id: "link-scoped" }]);
      assert.deepStrictEqual(sessionRows, [{ sessionId: "session-scoped" }]);
    }),
  );
});
