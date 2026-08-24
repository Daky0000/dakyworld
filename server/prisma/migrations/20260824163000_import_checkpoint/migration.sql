-- Add IMPORTING to the LeadImportStatus enum.
ALTER TYPE "LeadImportStatus" ADD VALUE 'IMPORTING';

-- AlterTable
ALTER TABLE "LeadImport" ADD COLUMN     "commitState" JSONB;
ALTER TABLE "LeadImport" ADD COLUMN     "importedAt" TIMESTAMP(3);
