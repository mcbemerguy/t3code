import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const ensureProviderDeliveryColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "provider_delivery_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN provider_delivery_json TEXT
    `;
  }
});

const backfillActivitySequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP TABLE IF EXISTS temp.tmp_projection_thread_activity_sequences
  `;

  yield* sql`
    CREATE TEMP TABLE tmp_projection_thread_activity_sequences (
      thread_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (thread_id, activity_id)
    )
  `;

  yield* sql`
    INSERT INTO tmp_projection_thread_activity_sequences (thread_id, activity_id, sequence)
    SELECT thread_id, activity_id, sequence
    FROM (
      SELECT
        stream_id AS thread_id,
        json_extract(payload_json, '$.activity.id') AS activity_id,
        sequence,
        ROW_NUMBER() OVER (
          PARTITION BY stream_id, json_extract(payload_json, '$.activity.id')
          ORDER BY sequence DESC
        ) AS row_number
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.activity-appended'
        AND json_extract(payload_json, '$.activity.id') IS NOT NULL
    ) AS activity_event
    WHERE row_number = 1
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET sequence = (
      SELECT activity_sequence.sequence
      FROM tmp_projection_thread_activity_sequences AS activity_sequence
      WHERE activity_sequence.thread_id = projection_thread_activities.thread_id
        AND activity_sequence.activity_id = projection_thread_activities.activity_id
    )
    WHERE sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM tmp_projection_thread_activity_sequences AS activity_sequence
        WHERE activity_sequence.thread_id = projection_thread_activities.thread_id
          AND activity_sequence.activity_id = projection_thread_activities.activity_id
      )
  `;

  yield* sql`
    DROP TABLE temp.tmp_projection_thread_activity_sequences
  `;
});

const backfillThreadUpdatedAt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP TABLE IF EXISTS temp.tmp_projection_thread_updated_at_backfill
  `;

  yield* sql`
    CREATE TEMP TABLE tmp_projection_thread_updated_at_backfill AS
    SELECT
      candidate.thread_id,
      MAX(candidate.candidate_at) AS updated_at
    FROM (
      SELECT
        thread_id,
        created_at AS candidate_at
      FROM projection_threads
      UNION ALL
      SELECT
        thread_id,
        updated_at AS candidate_at
      FROM projection_threads
      UNION ALL
      SELECT
        threads.thread_id,
        turns.requested_at AS candidate_at
      FROM projection_threads AS threads
      INNER JOIN projection_turns AS turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE turns.requested_at IS NOT NULL
      UNION ALL
      SELECT
        threads.thread_id,
        turns.started_at AS candidate_at
      FROM projection_threads AS threads
      INNER JOIN projection_turns AS turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE turns.started_at IS NOT NULL
      UNION ALL
      SELECT
        threads.thread_id,
        turns.completed_at AS candidate_at
      FROM projection_threads AS threads
      INNER JOIN projection_turns AS turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE turns.completed_at IS NOT NULL
      UNION ALL
      SELECT
        sessions.thread_id,
        sessions.updated_at AS candidate_at
      FROM projection_thread_sessions AS sessions
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = sessions.thread_id
      WHERE sessions.updated_at IS NOT NULL
    ) AS candidate
    WHERE candidate.candidate_at IS NOT NULL
    GROUP BY candidate.thread_id
  `;

  yield* sql`
    UPDATE projection_threads
    SET updated_at = (
      SELECT backfill.updated_at
      FROM tmp_projection_thread_updated_at_backfill AS backfill
      WHERE backfill.thread_id = projection_threads.thread_id
    )
    WHERE EXISTS (
      SELECT 1
      FROM tmp_projection_thread_updated_at_backfill AS backfill
      WHERE backfill.thread_id = projection_threads.thread_id
        AND backfill.updated_at > projection_threads.updated_at
    )
  `;

  yield* sql`
    DROP TABLE temp.tmp_projection_thread_updated_at_backfill
  `;
});

export default Effect.gen(function* () {
  yield* ensureProviderDeliveryColumn;
  yield* backfillActivitySequence;
  yield* backfillThreadUpdatedAt;
});
