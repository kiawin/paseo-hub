-- Provider settings are keyed by the provider's own app id, so Slack can run more than one app.
-- The id is the verified identity's, the same one activations record. Add the column empty, fill it,
-- then require it.
ALTER TABLE "runtime_provider_configuration" ADD COLUMN "application_id" text;
--> statement-breakpoint
UPDATE "runtime_provider_configuration" SET "application_id" = "verified_external_identity"->>'id';
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ALTER COLUMN "application_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_pkey";
--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_application_id_pk" PRIMARY KEY("provider","application_id");
--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_pkey";
--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_provider_application_id_pk" PRIMARY KEY("provider","provider_application_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_provider_configuration_single_app_unique" ON "runtime_provider_configuration" USING btree ("provider") WHERE "runtime_provider_configuration"."provider" <> 'slack';
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_provider_activation_single_app_unique" ON "runtime_provider_activation" USING btree ("provider") WHERE "runtime_provider_activation"."provider" <> 'slack';
--> statement-breakpoint
-- Connections from before apps were recorded belong to the one stored Slack app, when there is one.
UPDATE "slack_connections" SET "provider_application_id" = (
  SELECT "application_id" FROM "runtime_provider_configuration" WHERE "provider" = 'slack'
)
WHERE "provider_application_id" IS NULL
  AND (SELECT count(*) FROM "runtime_provider_configuration" WHERE "provider" = 'slack') = 1;
--> statement-breakpoint
ALTER TABLE "slack_connections" DROP CONSTRAINT "slack_connections_team_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connections_application_team_unique" ON "slack_connections" USING btree ("provider_application_id","team_id");
