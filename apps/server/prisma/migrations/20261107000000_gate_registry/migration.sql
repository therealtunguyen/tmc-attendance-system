BEGIN;

-- The old registry has no factory, location, direction or device mapping to backfill.
-- Fail before changing anything instead of inventing operational gate configuration.
-- See docs/gate-registry.md for the rollout plan when legacy registry rows exist.
LOCK TABLE "Edge", "Gate" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "Edge") OR EXISTS (SELECT 1 FROM "Gate") THEN
        RAISE EXCEPTION 'Gate registry migration requires an explicit backfill for existing Edge/Gate rows'
            USING HINT = 'Prepare the factory/location/direction/turnstile mapping described in docs/gate-registry.md. No rows have been changed.';
    END IF;
END;
$$;

CREATE TYPE "GateDirection" AS ENUM ('IN', 'OUT');

ALTER TABLE "Edge" ADD COLUMN "factoryId" TEXT NOT NULL;

ALTER TABLE "Gate"
    ADD COLUMN "factoryId" TEXT NOT NULL,
    ADD COLUMN "location" TEXT NOT NULL,
    ADD COLUMN "direction" "GateDirection" NOT NULL,
    ADD COLUMN "turnstileId" TEXT NOT NULL,
    ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "Edge_factoryId_key" ON "Edge"("factoryId");
CREATE UNIQUE INDEX "Edge_id_factoryId_key" ON "Edge"("id", "factoryId");
CREATE UNIQUE INDEX "Gate_turnstileId_key" ON "Gate"("turnstileId");
CREATE INDEX "Gate_factoryId_idx" ON "Gate"("factoryId");
CREATE INDEX "Gate_edgeId_factoryId_idx" ON "Gate"("edgeId", "factoryId");

ALTER TABLE "Gate" DROP CONSTRAINT "Gate_edgeId_fkey";
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_edgeId_factoryId_fkey"
    FOREIGN KEY ("edgeId", "factoryId") REFERENCES "Edge"("id", "factoryId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot express CHECK constraints. Reject whitespace-only registry values,
-- including tabs and newlines; API validation will also trim accepted strings.
ALTER TABLE "Edge"
    ADD CONSTRAINT "Edge_id_nonblank" CHECK ("id" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Edge_name_nonblank" CHECK ("name" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Edge_factoryId_nonblank" CHECK ("factoryId" ~ '[^[:space:]]');

ALTER TABLE "Gate"
    ADD CONSTRAINT "Gate_id_nonblank" CHECK ("id" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Gate_name_nonblank" CHECK ("name" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Gate_factoryId_nonblank" CHECK ("factoryId" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Gate_edgeId_nonblank" CHECK ("edgeId" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Gate_location_nonblank" CHECK ("location" ~ '[^[:space:]]'),
    ADD CONSTRAINT "Gate_turnstileId_nonblank" CHECK ("turnstileId" ~ '[^[:space:]]');

COMMIT;
