import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
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
