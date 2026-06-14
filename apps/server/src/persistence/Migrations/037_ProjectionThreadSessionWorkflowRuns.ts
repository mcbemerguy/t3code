import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const ensureWorkflowRunsColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (!columns.some((column) => column.name === "workflow_runs_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN workflow_runs_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});

const backfillWorkflowRunsFromSessionEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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
        WHERE aggregate_kind = 'thread'
          AND event_type = 'thread.session-set'
          AND json_valid(payload_json)
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
});

const repairWorkflowSessionStatuses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

export default Effect.gen(function* () {
  yield* ensureWorkflowRunsColumn;
  yield* backfillWorkflowRunsFromSessionEvents;
  yield* repairWorkflowSessionStatuses;
});
