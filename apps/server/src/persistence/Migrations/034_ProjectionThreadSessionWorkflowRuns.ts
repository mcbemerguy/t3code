import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN workflow_runs_json TEXT NOT NULL DEFAULT '[]'
  `;

  yield* sql`
    WITH latest_session_events AS (
      SELECT
        latest.thread_id,
        latest.workflow_runs_json
      FROM (
        SELECT
          stream_id AS thread_id,
          json_extract(payload_json, '$.session.workflowRuns') AS workflow_runs_json,
          ROW_NUMBER() OVER (
            PARTITION BY stream_id
            ORDER BY sequence DESC
          ) AS row_number
        FROM orchestration_events
        WHERE event_type = 'thread.session-set'
      ) AS latest
      WHERE latest.row_number = 1
        AND json_type(latest.workflow_runs_json) = 'array'
    )
    UPDATE projection_thread_sessions
    SET workflow_runs_json = (
      SELECT latest_session_events.workflow_runs_json
      FROM latest_session_events
      WHERE latest_session_events.thread_id = projection_thread_sessions.thread_id
    )
    WHERE EXISTS (
      SELECT 1
      FROM latest_session_events
      WHERE latest_session_events.thread_id = projection_thread_sessions.thread_id
    )
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET status = 'running'
    WHERE EXISTS (
      SELECT 1
      FROM json_each(projection_thread_sessions.workflow_runs_json) AS run
      WHERE COALESCE(json_extract(run.value, '$.terminal'), 1) = 0
        AND json_extract(run.value, '$.status') IN ('running', 'recovering')
    )
  `;
});
