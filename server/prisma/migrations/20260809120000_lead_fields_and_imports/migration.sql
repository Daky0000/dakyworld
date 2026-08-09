-- Configurable lead columns (LeadField) and spreadsheet imports (LeadImport).
--
-- Existing leads keep working untouched: with no LeadField rows the API serves
-- the built-in default column set, so this migration adds capability without
-- changing what anyone currently sees.

-- CreateEnum
CREATE TYPE "LeadFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'CURRENCY', 'DATE', 'BOOLEAN', 'EMAIL', 'PHONE', 'URL', 'SELECT');

-- CreateEnum
CREATE TYPE "LeadImportSource" AS ENUM ('UPLOAD', 'GOOGLE_SHEET', 'GOOGLE_DRIVE_FILE');

-- CreateEnum
CREATE TYPE "LeadImportStatus" AS ENUM ('ANALYZING', 'READY', 'IMPORTED', 'FAILED');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "customFields" JSONB;

-- AlterTable
ALTER TABLE "LeadGroup" ADD COLUMN     "leadImportId" TEXT,
ADD COLUMN     "sourceLabel" TEXT;

-- CreateTable
CREATE TABLE "LeadField" (
    "id" TEXT NOT NULL,
    "groupId" TEXT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "LeadFieldType" NOT NULL DEFAULT 'TEXT',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadImport" (
    "id" TEXT NOT NULL,
    "source" "LeadImportSource" NOT NULL DEFAULT 'UPLOAD',
    "status" "LeadImportStatus" NOT NULL DEFAULT 'ANALYZING',
    "fileName" TEXT,
    "driveFileId" TEXT,
    "sheetNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" JSONB,
    "analyzedBy" TEXT,
    "notes" TEXT,
    "error" TEXT,
    "tablesFound" INTEGER NOT NULL DEFAULT 0,
    "groupsCreated" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "leadsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadField_groupId_position_idx" ON "LeadField"("groupId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "LeadField_groupId_key_key" ON "LeadField"("groupId", "key");

-- CreateIndex
CREATE INDEX "LeadImport_createdAt_idx" ON "LeadImport"("createdAt");

-- CreateIndex
CREATE INDEX "LeadGroup_leadImportId_idx" ON "LeadGroup"("leadImportId");

-- AddForeignKey
ALTER TABLE "LeadGroup" ADD CONSTRAINT "LeadGroup_leadImportId_fkey" FOREIGN KEY ("leadImportId") REFERENCES "LeadImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadField" ADD CONSTRAINT "LeadField_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
