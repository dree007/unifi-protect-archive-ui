-- Favorites and collections of archived clips (docs/database.md): metadata only, instance-wide
-- (no user accounts). Links cascade with their clip or collection; footage is never touched.
CREATE TABLE "collection_clips" (
	"collection_id" uuid NOT NULL,
	"archived_clip_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_clips_collection_id_archived_clip_id_pk" PRIMARY KEY("collection_id","archived_clip_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_name_not_blank" CHECK (btrim("collections"."name") <> ''),
	CONSTRAINT "collections_name_length" CHECK (char_length("collections"."name") <= 60)
);
--> statement-breakpoint
CREATE TABLE "favorite_clips" (
	"archived_clip_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_clips" ADD CONSTRAINT "collection_clips_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_clips" ADD CONSTRAINT "collection_clips_archived_clip_id_archived_clips_id_fk" FOREIGN KEY ("archived_clip_id") REFERENCES "public"."archived_clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_clips" ADD CONSTRAINT "favorite_clips_archived_clip_id_archived_clips_id_fk" FOREIGN KEY ("archived_clip_id") REFERENCES "public"."archived_clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_clips_archived_clip_id_idx" ON "collection_clips" USING btree ("archived_clip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_name_unique_idx" ON "collections" USING btree (lower("name"));