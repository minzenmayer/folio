-- Phase 14b — Garden redesign · Backfill (run AFTER 0011)
-- Initial temperatures from existing signals. Idempotent — safe to re-run.
-- See spec section 8 step 2.

-- ideas: visited recency
UPDATE ideas
   SET temperature = 'hot',
       temperature_updated_at = now()
 WHERE last_visited_at >= now() - interval '14 days';

UPDATE ideas
   SET temperature = 'warm',
       temperature_updated_at = now()
 WHERE last_visited_at >= now() - interval '30 days'
   AND last_visited_at <  now() - interval '14 days'
   AND temperature != 'hot';

UPDATE ideas
   SET temperature = 'cool',
       temperature_updated_at = now()
 WHERE (last_visited_at <  now() - interval '30 days' OR last_visited_at IS NULL)
   AND temperature NOT IN ('hot', 'warm');

-- existing extracted_ideas keep their default 'cool'; per Payton's call no smart-bucketing for v1.
