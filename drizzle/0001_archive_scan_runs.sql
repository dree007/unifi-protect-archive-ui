CREATE TABLE "archive_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"archive_root" text NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"day_directory_count" integer DEFAULT 0 NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_scan_runs_status_valid" CHECK ("archive_scan_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "archive_scan_runs_archive_root_not_blank" CHECK (btrim("archive_scan_runs"."archive_root") <> ''),
	CONSTRAINT "archive_scan_runs_finished_when_done" CHECK (("archive_scan_runs"."status" = 'running') = ("archive_scan_runs"."finished_at" is null)),
	CONSTRAINT "archive_scan_runs_counts_non_negative" CHECK (least("archive_scan_runs"."day_directory_count", "archive_scan_runs"."discovered_count", "archive_scan_runs"."updated_count", "archive_scan_runs"."unchanged_count", "archive_scan_runs"."failed_count", "archive_scan_runs"."warning_count", coalesce("archive_scan_runs"."missing_count", 0)) >= 0)
);
--> statement-breakpoint
CREATE INDEX "archive_scan_runs_status_started_at_idx" ON "archive_scan_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_scan_runs_single_running_idx" ON "archive_scan_runs" USING btree ("status") WHERE "archive_scan_runs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "archived_clips" ADD CONSTRAINT "archived_clips_file_path_relative" CHECK ("archived_clips"."file_path" !~ '^/' and "archived_clips"."file_path" !~ '(^|/)\.\.(/|$)');