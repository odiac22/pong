-- Run offline against an authorized trace with trace_processor query -f.
-- Output is numeric metadata only, one row per app-associated display token.
-- Do not infer video content FPS from these app-window FrameTimeline events:
-- Android FrameTimeline does not cover SurfaceView content on all devices.
WITH app AS (
  SELECT a.* FROM actual_frame_timeline_slice AS a
  JOIN process AS p USING (upid)
  WHERE p.name = 'com.odiac22.pong2'
    AND a.layer_name LIKE '%com.odiac22.pong2%'
    AND a.surface_frame_token > 0 AND a.display_frame_token > 0
), sf AS (
  SELECT a.* FROM actual_frame_timeline_slice AS a
  JOIN process AS p USING (upid)
  WHERE p.name = '/system/bin/surfaceflinger'
    AND (a.surface_frame_token IS NULL OR a.surface_frame_token = 0)
    AND a.display_frame_token > 0
)
SELECT app.display_frame_token AS token,
  MAX(CASE WHEN sf.present_type != 'Dropped Frame' THEN sf.ts + sf.dur END) AS present_ns,
  MAX(CASE WHEN app.jank_type IS NOT NULL AND app.jank_type NOT IN ('None', 'Buffer Stuffing') THEN 1 ELSE 0 END) AS app_jank,
  MAX(CASE WHEN sf.jank_type IS NOT NULL AND sf.jank_type NOT IN ('None', 'Buffer Stuffing') THEN 1 ELSE 0 END) AS sf_jank,
  MAX(CASE WHEN app.present_type = 'Late Present' THEN 1 ELSE 0 END) AS app_late,
  MAX(CASE WHEN sf.present_type = 'Late Present' THEN 1 ELSE 0 END) AS sf_late,
  MAX(CASE WHEN app.jank_type = 'Buffer Stuffing' THEN 1 ELSE 0 END) AS buffer_stuffing,
  MAX(CASE WHEN app.present_type = 'Dropped Frame' THEN 1 ELSE 0 END) AS app_dropped,
  MAX(CASE WHEN sf.present_type = 'Dropped Frame' THEN 1 ELSE 0 END) AS sf_dropped
FROM app LEFT JOIN sf USING (display_frame_token)
GROUP BY app.display_frame_token
ORDER BY present_ns, token;
