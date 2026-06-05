import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadSessionWorkflowRuns", (it) => {
  it.effect("backfills workflow runs from the latest persisted session event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            'thread-running-workflow',
            'ready',
            'pi',
            NULL,
            'full-access',
            NULL,
            NULL,
            '2026-06-05T00:00:02.000Z'
          ),
          (
            'thread-interrupted-workflow',
            'ready',
            'pi',
            NULL,
            'full-access',
            NULL,
            NULL,
            '2026-06-05T00:00:02.000Z'
          ),
          (
            'thread-without-workflow',
            'ready',
            'pi',
            NULL,
            'full-access',
            NULL,
            NULL,
            '2026-06-05T00:00:02.000Z'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            10,
            'event-running-workflow-old',
            'thread',
            'thread-running-workflow',
            1,
            'thread.session-set',
            '2026-06-05T00:00:01.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-running-workflow","session":{"threadId":"thread-running-workflow","status":"ready","providerName":"pi","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"workflowRuns":[],"updatedAt":"2026-06-05T00:00:01.000Z"}}',
            '{}'
          ),
          (
            11,
            'event-running-workflow-latest',
            'thread',
            'thread-running-workflow',
            2,
            'thread.session-set',
            '2026-06-05T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-running-workflow","session":{"threadId":"thread-running-workflow","status":"ready","providerName":"pi","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"workflowRuns":[{"runId":"workflow-run-1","status":"running","terminal":false,"lastSequence":7,"actions":["interrupt","abort"],"updatedAt":"2026-06-05T00:00:02.000Z"}],"updatedAt":"2026-06-05T00:00:02.000Z"}}',
            '{}'
          ),
          (
            12,
            'event-interrupted-workflow-latest',
            'thread',
            'thread-interrupted-workflow',
            1,
            'thread.session-set',
            '2026-06-05T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-interrupted-workflow","session":{"threadId":"thread-interrupted-workflow","status":"ready","providerName":"pi","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"workflowRuns":[{"runId":"workflow-run-2","status":"interrupted","terminal":false,"lastSequence":4,"actions":["continue","abort"],"updatedAt":"2026-06-05T00:00:02.000Z"}],"updatedAt":"2026-06-05T00:00:02.000Z"}}',
            '{}'
          ),
          (
            13,
            'event-without-workflow-latest',
            'thread',
            'thread-without-workflow',
            1,
            'thread.session-set',
            '2026-06-05T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-without-workflow","session":{"threadId":"thread-without-workflow","status":"ready","providerName":"pi","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"updatedAt":"2026-06-05T00:00:02.000Z"}}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly workflowRunsJson: string;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          workflow_runs_json AS "workflowRunsJson"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-interrupted-workflow",
          status: "ready",
          workflowRunsJson:
            '[{"runId":"workflow-run-2","status":"interrupted","terminal":false,"lastSequence":4,"actions":["continue","abort"],"updatedAt":"2026-06-05T00:00:02.000Z"}]',
        },
        {
          threadId: "thread-running-workflow",
          status: "running",
          workflowRunsJson:
            '[{"runId":"workflow-run-1","status":"running","terminal":false,"lastSequence":7,"actions":["interrupt","abort"],"updatedAt":"2026-06-05T00:00:02.000Z"}]',
        },
        {
          threadId: "thread-without-workflow",
          status: "ready",
          workflowRunsJson: "[]",
        },
      ]);
    }),
  );
});
