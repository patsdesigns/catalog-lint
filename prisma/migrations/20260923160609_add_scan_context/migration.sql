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
    "catalogTotal" INTEGER NOT NULL DEFAULT 0,
    "readAt" DATETIME,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Scan" ("catalogTotal", "checks", "clean", "createdAt", "durationMs", "findings", "id", "names", "productIds", "readAt", "rules", "score", "shop", "total") SELECT "catalogTotal", "checks", "clean", "createdAt", "durationMs", "findings", "id", "names", "productIds", "readAt", "rules", "score", "shop", "total" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_shop_createdAt_idx" ON "Scan"("shop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
