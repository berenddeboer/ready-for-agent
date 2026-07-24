ALTER TABLE `config` ADD `backend_model_prefs` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `config` SET `backend_model_prefs` = json_object(
  CASE
    WHEN `selected_agent_backend` IS NULL OR trim(`selected_agent_backend`) = ''
      THEN 'opencode'
    ELSE `selected_agent_backend`
  END,
  json_object(
    'defaultModel', `default_model`,
    'defaultThinkingLevel', `default_thinking_level`,
    'reviewModel', `review_model`,
    'reviewThinkingLevel', `review_thinking_level`
  )
);--> statement-breakpoint
ALTER TABLE `repository` ADD `backend_model_prefs` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `repository`
SET `backend_model_prefs` = json_object(
  COALESCE(
    (
      SELECT CASE
        WHEN c.`selected_agent_backend` IS NULL OR trim(c.`selected_agent_backend`) = ''
          THEN 'opencode'
        ELSE c.`selected_agent_backend`
      END
      FROM `config` c
      WHERE c.`id` = 'default'
    ),
    'opencode'
  ),
  json_object(
    'defaultModel', `default_model`,
    'defaultThinkingLevel', `default_thinking_level`,
    'reviewModel', `review_model`,
    'reviewThinkingLevel', `review_thinking_level`
  )
)
WHERE `default_model` IS NOT NULL
   OR `default_thinking_level` IS NOT NULL
   OR `review_model` IS NOT NULL
   OR `review_thinking_level` IS NOT NULL;
