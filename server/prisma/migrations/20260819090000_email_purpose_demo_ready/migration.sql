-- A Postgres enum value cannot be added and used inside one migration
-- (55P04, "unsafe use of new value"). It gets its own, earlier, migration.
ALTER TYPE "EmailPurpose" ADD VALUE 'DEMO_READY';
