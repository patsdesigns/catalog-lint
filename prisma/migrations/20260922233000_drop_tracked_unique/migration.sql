-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrackedMetafield" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "pattern" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_TrackedMetafield" ("createdAt", "id", "key", "name", "namespace", "pattern", "productType", "required", "shop", "type") SELECT "createdAt", "id", "key", "name", "namespace", "pattern", "productType", "required", "shop", "type" FROM "TrackedMetafield";
DROP TABLE "TrackedMetafield";
ALTER TABLE "new_TrackedMetafield" RENAME TO "TrackedMetafield";
CREATE UNIQUE INDEX "TrackedMetafield_shop_namespace_key_key" ON "TrackedMetafield"("shop", "namespace", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

