ALTER TABLE `osu_score_rank_highest`
RENAME COLUMN IF EXISTS `updated_at` TO `achieved_at`;

ALTER TABLE `osu_score_rank_history`
RENAME COLUMN IF EXISTS `updated_at` TO `latest_rank_date`;

ANALYZE TABLE `osu_score_rank_highest`, `osu_score_rank_history`, `osu_score_user_data`;
