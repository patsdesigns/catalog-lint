-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Setting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vendorWhitelist" TEXT NOT NULL DEFAULT '[]',
    "metafieldRules" TEXT NOT NULL DEFAULT '[]',
    "disabledRules" TEXT NOT NULL DEFAULT '[]',
    "preset" TEXT NOT NULL DEFAULT 'recommended',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Setting" ("disabledRules", "metafieldRules", "shop", "updatedAt", "vendorWhitelist") SELECT "disabledRules", "metafieldRules", "shop", "updatedAt", "vendorWhitelist" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Shops that already have settings keep the checks they had: everything on stays everything,
-- an explicit list becomes a custom preset. New shops start on the recommended preset.
UPDATE "Setting" SET "preset" = CASE WHEN "disabledRules" = '[]' THEN 'everything' ELSE 'custom' END;
