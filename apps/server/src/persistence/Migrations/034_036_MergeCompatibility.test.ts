import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const makeLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql(table)})`;
    return new Set(columns.map((column) => column.name));
  });

const migrationRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: number; readonly name: string }>`
    SELECT migration_id AS id, name
    FROM effect_sql_migrations
    ORDER BY migration_id
  `;
});

const expectedFreshMigrations = [
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "ProjectionThreadMessageProviderDelivery"],
  [32, "BackfillProjectionThreadActivitySequence"],
  [33, "BackfillProjectionThreadUpdatedAtFromLatestTurn"],
  [34, "ProjectionCustomAcpCompatibility"],
  [35, "AuthAuthorizationScopes"],
  [36, "AuthPairingProofKeyThumbprint"],
  [37, "ProjectionThreadSessionWorkflowRuns"],
];

makeLayer()("034_037_MergeCompatibility fresh database", (it) => {
  it.effect("migrates through custom ACP and upstream auth migrations", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();

      const projectionThreadMessageColumns = yield* columnNames("projection_thread_messages");
      const projectionThreadSessionColumns = yield* columnNames("projection_thread_sessions");
      const pairingColumns = yield* columnNames("auth_pairing_links");
      const sessionColumns = yield* columnNames("auth_sessions");
      const rows = yield* migrationRows;

      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        expectedFreshMigrations,
      );
      assert.strictEqual(rows.at(-1)?.id, 37);
      assert.isTrue(projectionThreadMessageColumns.has("provider_delivery_json"));
      assert.isTrue(projectionThreadSessionColumns.has("workflow_runs_json"));
      assert.isTrue(pairingColumns.has("scopes"));
      assert.isTrue(pairingColumns.has("proof_key_thumbprint"));
      assert.isFalse(pairingColumns.has("role"));
      assert.isTrue(sessionColumns.has("scopes"));
      assert.isFalse(sessionColumns.has("role"));
    }),
  );
});

makeLayer()("034_037_MergeCompatibility current custom ACP database", (it) => {
  it.effect("upgrades a database already migrated through current custom ACP migration 33", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 33 });

      const executed = yield* runMigrations();
      const projectionThreadMessageColumns = yield* columnNames("projection_thread_messages");
      const projectionThreadSessionColumns = yield* columnNames("projection_thread_sessions");
      const pairingColumns = yield* columnNames("auth_pairing_links");
      const sessionColumns = yield* columnNames("auth_sessions");
      const rows = yield* migrationRows;

      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [
          [34, "ProjectionCustomAcpCompatibility"],
          [35, "AuthAuthorizationScopes"],
          [36, "AuthPairingProofKeyThumbprint"],
          [37, "ProjectionThreadSessionWorkflowRuns"],
        ],
      );
      assert.deepStrictEqual(
        rows.slice(-7).map(({ id, name }) => [id, name]),
        [
          [31, "ProjectionThreadMessageProviderDelivery"],
          [32, "BackfillProjectionThreadActivitySequence"],
          [33, "BackfillProjectionThreadUpdatedAtFromLatestTurn"],
          [34, "ProjectionCustomAcpCompatibility"],
          [35, "AuthAuthorizationScopes"],
          [36, "AuthPairingProofKeyThumbprint"],
          [37, "ProjectionThreadSessionWorkflowRuns"],
        ],
      );
      assert.isTrue(projectionThreadMessageColumns.has("provider_delivery_json"));
      assert.isTrue(projectionThreadSessionColumns.has("workflow_runs_json"));
      assert.isTrue(pairingColumns.has("scopes"));
      assert.isTrue(pairingColumns.has("proof_key_thumbprint"));
      assert.isFalse(pairingColumns.has("role"));
      assert.isTrue(sessionColumns.has("scopes"));
      assert.isFalse(sessionColumns.has("role"));
    }),
  );
});
