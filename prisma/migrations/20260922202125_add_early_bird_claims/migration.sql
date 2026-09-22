-- CreateTable
CREATE TABLE "EarlyBirdClaim" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active'
);

-- CreateIndex
CREATE UNIQUE INDEX "EarlyBirdClaim_shop_key" ON "EarlyBirdClaim"("shop");
