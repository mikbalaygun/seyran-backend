-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sipno" INTEGER NOT NULL,
    "sipsr" INTEGER NOT NULL,
    "firma" TEXT,
    "musadi" TEXT,
    "mail" TEXT,
    "tarih" TEXT,
    "urunadi" TEXT,
    "out" INTEGER,
    "stkno" TEXT,
    "sevktar" TEXT,
    "mik" REAL,
    "modul" TEXT,
    "kumas" TEXT,
    "acik" TEXT,
    "ayak" TEXT,
    "kirlent" TEXT,
    "tip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Order_sipno_sipsr_key" ON "Order"("sipno", "sipsr");
