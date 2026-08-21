-- What a single rehearsal may spend before it stops itself.
-- Null takes the shipped default; 0 means no ceiling.
ALTER TABLE "Rehearsal" ADD COLUMN "budgetUsd" DECIMAL(10,2);
