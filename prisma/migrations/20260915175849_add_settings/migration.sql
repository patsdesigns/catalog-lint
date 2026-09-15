-- CreateTable
CREATE TABLE "Setting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "vendorWhitelist" TEXT NOT NULL DEFAULT '[]',
    "metafieldRules" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
