CREATE TABLE "tombstone_cid" (
	"id" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"ftid" text,
	"maps_url" text NOT NULL,
	"title" text,
	"settled_url" text,
	"noticed_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "tombstone_cid_cid_unique" UNIQUE("cid")
);
