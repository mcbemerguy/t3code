import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_activities
    SET sequence = (
      SELECT event.sequence
      FROM orchestration_events AS event
      WHERE event.event_type = 'thread.activity-appended'
        AND json_extract(event.payload_json, '$.threadId') = projection_thread_activities.thread_id
        AND json_extract(event.payload_json, '$.activity.id') = projection_thread_activities.activity_id
      ORDER BY event.sequence DESC
      LIMIT 1
    )
    WHERE sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS event
        WHERE event.event_type = 'thread.activity-appended'
          AND json_extract(event.payload_json, '$.threadId') = projection_thread_activities.thread_id
          AND json_extract(event.payload_json, '$.activity.id') = projection_thread_activities.activity_id
      )
  `;
});
