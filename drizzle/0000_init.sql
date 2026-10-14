CREATE TABLE "cameras" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"protect_device_id" text NOT NULL,
	"name" text NOT NULL,
	"model" text,
	"mac" text,
	"state" text NOT NULL,
	"smart_detect_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cameras_protect_device_id_unique" UNIQUE("protect_device_id"),
	CONSTRAINT "cameras_protect_device_id_not_blank" CHECK (btrim("cameras"."protect_device_id") <> ''),
	CONSTRAINT "cameras_name_not_blank" CHECK (btrim("cameras"."name") <> ''),
	CONSTRAINT "cameras_state_valid" CHECK ("cameras"."state" in ('online', 'offline'))
);
--> statement-breakpoint
CREATE TABLE "archived_clips" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"camera_id" uuid,
	"camera_name" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"file_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size_bytes" bigint,
	"file_modified_at" timestamp with time zone,
	"day_directory" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archived_clips_file_path_unique" UNIQUE("file_path"),
	CONSTRAINT "archived_clips_camera_name_not_blank" CHECK (btrim("archived_clips"."camera_name") <> ''),
	CONSTRAINT "archived_clips_file_path_not_blank" CHECK (btrim("archived_clips"."file_path") <> ''),
	CONSTRAINT "archived_clips_file_name_not_blank" CHECK (btrim("archived_clips"."file_name") <> ''),
	CONSTRAINT "archived_clips_day_directory_not_blank" CHECK (btrim("archived_clips"."day_directory") <> ''),
	CONSTRAINT "archived_clips_end_not_before_start" CHECK ("archived_clips"."end_at" >= "archived_clips"."start_at"),
	CONSTRAINT "archived_clips_duration_ms_non_negative" CHECK ("archived_clips"."duration_ms" >= 0),
	CONSTRAINT "archived_clips_file_size_bytes_non_negative" CHECK ("archived_clips"."file_size_bytes" is null or "archived_clips"."file_size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "protect_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"protect_event_id" text NOT NULL,
	"camera_id" uuid,
	"protect_device_id" text NOT NULL,
	"event_type" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"smart_detect_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protect_events_protect_event_id_unique" UNIQUE("protect_event_id"),
	CONSTRAINT "protect_events_protect_event_id_not_blank" CHECK (btrim("protect_events"."protect_event_id") <> ''),
	CONSTRAINT "protect_events_protect_device_id_not_blank" CHECK (btrim("protect_events"."protect_device_id") <> ''),
	CONSTRAINT "protect_events_event_type_not_blank" CHECK (btrim("protect_events"."event_type") <> ''),
	CONSTRAINT "protect_events_end_not_before_start" CHECK ("protect_events"."end_at" is null or "protect_events"."end_at" >= "protect_events"."start_at"),
	CONSTRAINT "protect_events_received_order" CHECK ("protect_events"."last_received_at" >= "protect_events"."first_received_at")
);
--> statement-breakpoint
CREATE TABLE "archive_event_clips" (
	"archive_event_id" uuid NOT NULL,
	"archived_clip_id" uuid NOT NULL,
	CONSTRAINT "archive_event_clips_archive_event_id_archived_clip_id_pk" PRIMARY KEY("archive_event_id","archived_clip_id")
);
--> statement-breakpoint
CREATE TABLE "archive_event_protect_events" (
	"archive_event_id" uuid NOT NULL,
	"protect_event_id" uuid NOT NULL,
	CONSTRAINT "archive_event_protect_events_archive_event_id_protect_event_id_pk" PRIMARY KEY("archive_event_id","protect_event_id")
);
--> statement-breakpoint
CREATE TABLE "archive_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"metadata_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_events_metadata_status_valid" CHECK ("archive_events"."metadata_status" in ('matched', 'archiveOnly', 'pendingClip')),
	CONSTRAINT "archive_events_end_not_before_start" CHECK ("archive_events"."end_at" is null or "archive_events"."end_at" >= "archive_events"."start_at")
);
--> statement-breakpoint
ALTER TABLE "archived_clips" ADD CONSTRAINT "archived_clips_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protect_events" ADD CONSTRAINT "protect_events_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_event_clips" ADD CONSTRAINT "archive_event_clips_archive_event_id_archive_events_id_fk" FOREIGN KEY ("archive_event_id") REFERENCES "public"."archive_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_event_clips" ADD CONSTRAINT "archive_event_clips_archived_clip_id_archived_clips_id_fk" FOREIGN KEY ("archived_clip_id") REFERENCES "public"."archived_clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_event_protect_events" ADD CONSTRAINT "archive_event_protect_events_archive_event_id_archive_events_id_fk" FOREIGN KEY ("archive_event_id") REFERENCES "public"."archive_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_event_protect_events" ADD CONSTRAINT "archive_event_protect_events_protect_event_id_protect_events_id_fk" FOREIGN KEY ("protect_event_id") REFERENCES "public"."protect_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_clips_start_at_idx" ON "archived_clips" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "archived_clips_camera_id_start_at_idx" ON "archived_clips" USING btree ("camera_id","start_at");--> statement-breakpoint
CREATE INDEX "protect_events_protect_device_id_idx" ON "protect_events" USING btree ("protect_device_id");--> statement-breakpoint
CREATE INDEX "protect_events_start_at_idx" ON "protect_events" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "protect_events_camera_id_start_at_idx" ON "protect_events" USING btree ("camera_id","start_at");--> statement-breakpoint
CREATE INDEX "archive_event_clips_archived_clip_id_idx" ON "archive_event_clips" USING btree ("archived_clip_id");--> statement-breakpoint
CREATE INDEX "archive_event_protect_events_protect_event_id_idx" ON "archive_event_protect_events" USING btree ("protect_event_id");--> statement-breakpoint
CREATE INDEX "archive_events_start_at_idx" ON "archive_events" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "archive_events_metadata_status_start_at_idx" ON "archive_events" USING btree ("metadata_status","start_at");