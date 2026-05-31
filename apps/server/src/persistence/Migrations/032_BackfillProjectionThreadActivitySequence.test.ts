import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("032_BackfillProjectionThreadActivitySequence", (it) => {
  it.effect("backfills projected activity sequence from matching orchestration events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 31 });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-existing-sequence',
            'thread-1',
            NULL,
            'info',
            'turn.plan.updated',
            'Plan updated',
            '{}',
            99,
            '2026-05-30T20:12:37.304Z'
          ),
          (
            'activity-final-plan',
            'thread-1',
            NULL,
            'info',
            'turn.plan.updated',
            'Plan updated',
            '{}',
            NULL,
            '2026-05-30T20:12:37.304Z'
          ),
          (
            'activity-without-event',
            'thread-1',
            NULL,
            'info',
            'turn.plan.updated',
            'Plan updated',
            '{}',
            NULL,
            '2026-05-30T20:12:37.304Z'
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
            42,
            'event-final-plan',
            'thread',
            'thread-1',
            1,
            'thread.activity-appended',
            '2026-05-30T20:12:37.304Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","activity":{"id":"activity-final-plan"}}',
            '{}'
          ),
          (
            43,
            'event-existing-sequence',
            'thread',
            'thread-1',
            2,
            'thread.activity-appended',
            '2026-05-30T20:12:37.305Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"threadId":"thread-1","activity":{"id":"activity-existing-sequence"}}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 32 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly sequence: number | null;
      }>`
        SELECT
          activity_id AS "activityId",
          sequence
        FROM projection_thread_activities
        ORDER BY activity_id ASC
      `;

      assert.deepStrictEqual(rows, [
        { activityId: "activity-existing-sequence", sequence: 99 },
        { activityId: "activity-final-plan", sequence: 42 },
        { activityId: "activity-without-event", sequence: null },
      ]);
    }),
  );
});
