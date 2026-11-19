-- Provider settings are keyed by the provider's own app id, so Slack can run more than one app.
-- The id is the verified identity's, the same one activations record. Add the column empty, fill it,
-- then require it.
--
-- Every statement is safe to run again. This migration is fork-only, and each upstream sync can
-- renumber it with a newer journal "when". A database that already applied it under the old number
-- then runs it a second time, so it must finish without changing anything.
ALTER TABLE "runtime_provider_configuration" ADD COLUMN IF NOT EXISTS "application_id" text;
--> statement-breakpoint
UPDATE "runtime_provider_configuration" SET "application_id" = "verified_external_identity"->>'id'
WHERE "application_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ALTER COLUMN "application_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT IF EXISTS "runtime_provider_configuration_pkey";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_provider_configuration_provider_application_id_pk'
  ) THEN
    ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_application_id_pk" PRIMARY KEY("provider","application_id");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT IF EXISTS "runtime_provider_activation_pkey";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runtime_provider_activation_provider_provider_application_id_pk'
  ) THEN
    ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_provider_application_id_pk" PRIMARY KEY("provider","provider_application_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_provider_configuration_single_app_unique" ON "runtime_provider_configuration" USING btree ("provider") WHERE "runtime_provider_configuration"."provider" <> 'slack';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_provider_activation_single_app_unique" ON "runtime_provider_activation" USING btree ("provider") WHERE "runtime_provider_activation"."provider" <> 'slack';
--> statement-breakpoint
-- Connections from before apps were recorded belong to the one stored Slack app, when there is one.
UPDATE "slack_connections" SET "provider_application_id" = (
  SELECT "application_id" FROM "runtime_provider_configuration" WHERE "provider" = 'slack'
)
WHERE "provider_application_id" IS NULL
  AND (SELECT count(*) FROM "runtime_provider_configuration" WHERE "provider" = 'slack') = 1;
--> statement-breakpoint
ALTER TABLE "slack_connections" DROP CONSTRAINT IF EXISTS "slack_connections_team_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_connections_application_team_unique" ON "slack_connections" USING btree ("provider_application_id","team_id");
