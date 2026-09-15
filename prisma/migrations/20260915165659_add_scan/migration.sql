-- CreateTable
CREATE TABLE "Scan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "clean" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "rules" TEXT NOT NULL,
    "findings" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Scan_shop_createdAt_idx" ON "Scan"("shop", "createdAt");
