import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_BackfillProjectionThreadUpdatedAtFromLatestTurn", (it) => {
  it.effect(
    "backfills stale projection thread updated_at from latest turn and session timestamps",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 32 });

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-stale-turn',
            'project-1',
            'Stale Turn',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-stale-turn',
            '2026-05-29T17:50:00.000Z',
            '2026-05-29T17:57:04.125Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-stale-session',
            'project-1',
            'Stale Session',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-05-29T17:50:00.000Z',
            '2026-05-29T17:57:04.125Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-fresh',
            'project-1',
            'Fresh',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-fresh',
            '2026-05-29T17:50:00.000Z',
            '2026-05-29T18:10:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-ignores-non-latest-turn',
            'project-1',
            'Ignores Non Latest Turn',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-current',
            '2026-05-29T17:50:00.000Z',
            '2026-05-29T18:02:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
      `;

        yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-stale-turn',
            'turn-stale-turn',
            NULL,
            NULL,
            'interrupted',
            '2026-05-29T17:58:00.000Z',
            '2026-05-29T17:59:00.000Z',
            '2026-05-29T18:03:45.744Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-fresh',
            'turn-fresh',
            NULL,
            NULL,
            'completed',
            '2026-05-29T17:58:00.000Z',
            '2026-05-29T17:59:00.000Z',
            '2026-05-29T18:03:45.744Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-ignores-non-latest-turn',
            'turn-current',
            NULL,
            NULL,
            'completed',
            '2026-05-29T18:00:00.000Z',
            '2026-05-29T18:01:00.000Z',
            '2026-05-29T18:02:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-ignores-non-latest-turn',
            'turn-non-latest',
            NULL,
            NULL,
            'completed',
            '2026-05-29T18:20:00.000Z',
            '2026-05-29T18:21:00.000Z',
            '2026-05-29T18:22:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode,
          provider_instance_id
        )
        VALUES
          (
            'thread-stale-turn',
            'ready',
            'codex',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-05-29T18:01:00.000Z',
            'full-access',
            'codex'
          ),
          (
            'thread-stale-session',
            'ready',
            'codex',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-05-29T18:04:00.000Z',
            'full-access',
            'codex'
          ),
          (
            'thread-fresh',
            'ready',
            'codex',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-05-29T18:04:00.000Z',
            'full-access',
            'codex'
          )
      `;

        yield* runMigrations({ toMigrationInclusive: 33 });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly updatedAt: string;
        }>`
        SELECT
          thread_id AS "threadId",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

        assert.deepStrictEqual(rows, [
          { threadId: "thread-fresh", updatedAt: "2026-05-29T18:10:00.000Z" },
          { threadId: "thread-ignores-non-latest-turn", updatedAt: "2026-05-29T18:02:00.000Z" },
          { threadId: "thread-stale-session", updatedAt: "2026-05-29T18:04:00.000Z" },
          { threadId: "thread-stale-turn", updatedAt: "2026-05-29T18:03:45.744Z" },
        ]);
      }),
  );
});
