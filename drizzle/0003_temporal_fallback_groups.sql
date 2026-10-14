-- Primary group of each archive event link (docs/event-matching.md). Existing events were
-- formed by Protect metadata only, so each of them is exactly one primary group; by convention
-- its ID is the archive event's ID. Added nullable, filled, then made NOT NULL, so the
-- migration also works on databases with data.
ALTER TABLE "archive_event_clips" ADD COLUMN "primary_group_id" uuid;--> statement-breakpoint
UPDATE "archive_event_clips" SET "primary_group_id" = "archive_event_id";--> statement-breakpoint
ALTER TABLE "archive_event_clips" ALTER COLUMN "primary_group_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_event_protect_events" ADD COLUMN "primary_group_id" uuid;--> statement-breakpoint
UPDATE "archive_event_protect_events" SET "primary_group_id" = "archive_event_id";--> statement-breakpoint
ALTER TABLE "archive_event_protect_events" ALTER COLUMN "primary_group_id" SET NOT NULL;
