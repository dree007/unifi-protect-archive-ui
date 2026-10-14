-- Current state of the background worker and its components (docs/background-worker.md): one
-- row per component, overwritten in place. No history: scan details stay in archive_scan_runs.
CREATE TABLE "background_component_status" (
	"component" text PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"state" text NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"instance_started_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error_message" text,
	"next_run_at" timestamp with time zone,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_component_status_component_valid" CHECK ("background_component_status"."component" in ('worker', 'protect', 'archiveScan', 'reconciliation')),
	CONSTRAINT "background_component_status_state_valid" CHECK ("background_component_status"."state" in ('starting', 'running', 'stopping', 'stopped', 'error', 'disabled', 'connecting', 'connected', 'reconnecting', 'authenticationError', 'idle', 'success')),
	CONSTRAINT "background_component_status_details_object" CHECK ("background_component_status"."details" is null or jsonb_typeof("background_component_status"."details") = 'object')
);
