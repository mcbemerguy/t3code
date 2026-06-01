import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
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
