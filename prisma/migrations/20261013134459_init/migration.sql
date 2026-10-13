-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('facebook', 'instagram', 'tiktok');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('draft', 'validated', 'scheduled', 'publishing', 'published', 'needs_review', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('pending', 'claimed', 'produced', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('pending', 'publishing', 'reconciling', 'published', 'failed', 'blocked', 'skipped');

-- CreateEnum
CREATE TYPE "ImageOrigin" AS ENUM ('ai_generated', 'licensed_photo', 'licensed_photo_enhanced');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('pending', 'approved', 'rejected', 'quarantined');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('unverified', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('official', 'government', 'academic', 'ngo', 'encyclopedia', 'media', 'other');

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "governorate" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "landscape_type" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "scene_briefs" TEXT[],
    "geo_verified" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_hours" INTEGER,
    "last_featured_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publisher" TEXT,
    "kind" "SourceKind" NOT NULL,
    "accessed_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_facts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "claim_en" TEXT NOT NULL,
    "claim_ar" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'unverified',
    "verified_at" TIMESTAMPTZ(3),
    "verification_method" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID,
    "origin" "ImageOrigin" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'pending',
    "parent_asset_id" UUID,
    "source_url" TEXT,
    "source_page_url" TEXT,
    "author" TEXT,
    "license_code" TEXT,
    "license_url" TEXT,
    "attribution_text" TEXT,
    "attribution_required" BOOLEAN NOT NULL DEFAULT false,
    "rights_verified" BOOLEAN NOT NULL DEFAULT false,
    "rights_verified_at" TIMESTAMPTZ(3),
    "rights_notes" TEXT,
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "ai_edited" BOOLEAN NOT NULL DEFAULT false,
    "ai_model" TEXT,
    "prompt_name" TEXT,
    "prompt_version" INTEGER,
    "generation_params" JSONB,
    "langfuse_trace_id" TEXT,
    "audit_result" JSONB,
    "storage_key" TEXT,
    "public_url" TEXT,
    "mime_type" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "sha256" CHAR(64),
    "phash" CHAR(16),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot_at" TIMESTAMPTZ(3) NOT NULL,
    "local_date" DATE NOT NULL,
    "local_time" CHAR(5) NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'pending',
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "lease_expires_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "skip_reason" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "image_asset_id" UUID,
    "status" "PostStatus" NOT NULL DEFAULT 'draft',
    "title" TEXT,
    "caption_derja" TEXT,
    "caption_en" TEXT,
    "hashtags" TEXT[],
    "alt_text" TEXT,
    "disclosure_derja" TEXT,
    "disclosure_en" TEXT,
    "supported_claims" JSONB,
    "review_reasons" TEXT[],
    "content_hash" CHAR(64),
    "caption_model" TEXT,
    "caption_prompt_version" INTEGER,
    "langfuse_trace_id" TEXT,
    "scheduled_for" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_publications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error" TEXT,
    "external_container_id" TEXT,
    "external_post_id" TEXT,
    "permalink" TEXT,
    "response_meta" JSONB,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "publication_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "http_status" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "request_id" TEXT,
    "response" JSONB,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_status_transitions" (
    "id" BIGSERIAL NOT NULL,
    "post_id" UUID NOT NULL,
    "from_status" "PostStatus",
    "to_status" "PostStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_status_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "generation_errors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stage" TEXT NOT NULL,
    "slot_id" UUID,
    "post_id" UUID,
    "location_id" UUID,
    "error_code" TEXT,
    "message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_slug_key" ON "locations"("slug");

-- CreateIndex
CREATE INDEX "locations_active_last_featured_at_idx" ON "locations"("active", "last_featured_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_sources_url_key" ON "research_sources"("url");

-- CreateIndex
CREATE INDEX "location_facts_location_id_status_idx" ON "location_facts"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "location_facts_location_id_claim_en_key" ON "location_facts"("location_id", "claim_en");

-- CreateIndex
CREATE UNIQUE INDEX "image_assets_storage_key_key" ON "image_assets"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "image_assets_sha256_key" ON "image_assets"("sha256");

-- CreateIndex
CREATE INDEX "image_assets_phash_idx" ON "image_assets"("phash");

-- CreateIndex
CREATE INDEX "image_assets_location_id_status_idx" ON "image_assets"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "publish_slots_slot_at_key" ON "publish_slots"("slot_at");

-- CreateIndex
CREATE INDEX "publish_slots_status_slot_at_idx" ON "publish_slots"("status", "slot_at");

-- CreateIndex
CREATE INDEX "publish_slots_local_date_idx" ON "publish_slots"("local_date");

-- CreateIndex
CREATE UNIQUE INDEX "posts_slot_id_key" ON "posts"("slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_content_hash_key" ON "posts"("content_hash");

-- CreateIndex
CREATE INDEX "posts_status_scheduled_for_idx" ON "posts"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "posts_location_id_created_at_idx" ON "posts"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_publications_status_next_attempt_at_idx" ON "platform_publications"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_publications_post_id_platform_key" ON "platform_publications"("post_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_publication_id_attempt_no_key" ON "publish_attempts"("publication_id", "attempt_no");

-- CreateIndex
CREATE INDEX "post_status_transitions_post_id_at_idx" ON "post_status_transitions"("post_id", "at");

-- CreateIndex
CREATE INDEX "generation_errors_created_at_idx" ON "generation_errors"("created_at");

-- CreateIndex
CREATE INDEX "generation_errors_stage_created_at_idx" ON "generation_errors"("stage", "created_at");

-- AddForeignKey
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_facts" ADD CONSTRAINT "location_facts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_facts" ADD CONSTRAINT "location_facts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "research_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_parent_asset_id_fkey" FOREIGN KEY ("parent_asset_id") REFERENCES "image_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "publish_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_image_asset_id_fkey" FOREIGN KEY ("image_asset_id") REFERENCES "image_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_publications" ADD CONSTRAINT "platform_publications_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "platform_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_status_transitions" ADD CONSTRAINT "post_status_transitions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_errors" ADD CONSTRAINT "generation_errors_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "publish_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_errors" ADD CONSTRAINT "generation_errors_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_errors" ADD CONSTRAINT "generation_errors_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
