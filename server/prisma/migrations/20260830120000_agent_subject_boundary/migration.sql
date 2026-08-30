-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "not_responsible_subject" TEXT[] DEFAULT ARRAY[]::TEXT[];

