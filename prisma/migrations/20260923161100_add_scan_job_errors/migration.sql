-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ScanJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "expected" INTEGER NOT NULL DEFAULT 0,
    "objects" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ScanJob" ("createdAt", "error", "expected", "id", "objects", "operationId", "shop", "status", "updatedAt") SELECT "createdAt", "error", "expected", "id", "objects", "operationId", "shop", "status", "updatedAt" FROM "ScanJob";
DROP TABLE "ScanJob";
ALTER TABLE "new_ScanJob" RENAME TO "ScanJob";
CREATE INDEX "ScanJob_shop_status_idx" ON "ScanJob"("shop", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
