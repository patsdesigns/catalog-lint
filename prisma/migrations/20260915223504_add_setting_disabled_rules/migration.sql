-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Setting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vendorWhitelist" TEXT NOT NULL DEFAULT '[]',
    "metafieldRules" TEXT NOT NULL DEFAULT '[]',
    "disabledRules" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Setting" ("metafieldRules", "shop", "updatedAt", "vendorWhitelist") SELECT "metafieldRules", "shop", "updatedAt", "vendorWhitelist" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
