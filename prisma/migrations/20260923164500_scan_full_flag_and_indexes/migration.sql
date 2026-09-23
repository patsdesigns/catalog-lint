-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "clean" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "rules" TEXT NOT NULL,
    "findings" TEXT NOT NULL,
    "checks" TEXT NOT NULL DEFAULT '[]',
    "names" TEXT NOT NULL DEFAULT '[]',
    "context" TEXT NOT NULL DEFAULT '{}',
    "full" BOOLEAN NOT NULL DEFAULT false,
    "catalogTotal" INTEGER NOT NULL DEFAULT 0,
    "readAt" DATETIME,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Scan" ("catalogTotal", "checks", "clean", "context", "createdAt", "durationMs", "findings", "id", "names", "productIds", "readAt", "rules", "score", "shop", "total") SELECT "catalogTotal", "checks", "clean", "context", "createdAt", "durationMs", "findings", "id", "names", "productIds", "readAt", "rules", "score", "shop", "total" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_shop_createdAt_idx" ON "Scan"("shop", "createdAt");
CREATE INDEX "Scan_shop_full_createdAt_idx" ON "Scan"("shop", "full", "createdAt");
CREATE TABLE "new_Setting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vendorWhitelist" TEXT NOT NULL DEFAULT '[]',
    "metafieldRules" TEXT NOT NULL DEFAULT '[]',
    "disabledRules" TEXT NOT NULL DEFAULT '[]',
    "preset" TEXT NOT NULL DEFAULT 'everything',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Setting" ("disabledRules", "metafieldRules", "preset", "shop", "updatedAt", "vendorWhitelist") SELECT "disabledRules", "metafieldRules", "preset", "shop", "updatedAt", "vendorWhitelist" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FixLog_shop_undone_createdAt_idx" ON "FixLog"("shop", "undone", "createdAt");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");


-- Results saved before the flag existed were full scans as far as the trend is concerned.
UPDATE "Scan" SET "full" = 1;
