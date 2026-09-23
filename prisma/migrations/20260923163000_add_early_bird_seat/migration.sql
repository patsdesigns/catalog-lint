-- AlterTable
ALTER TABLE "EarlyBirdClaim" ADD COLUMN "seat" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "EarlyBirdClaim_seat_key" ON "EarlyBirdClaim"("seat");


-- Existing claims take their seat in the order they were made.
UPDATE "EarlyBirdClaim" SET "seat" = (SELECT COUNT(*) FROM "EarlyBirdClaim" AS e2 WHERE e2."id" <= "EarlyBirdClaim"."id") WHERE "seat" IS NULL;
