-- Row-level security: deny by default for every role except the one the
-- application connects as.
--
-- What this does and does not do, plainly, because RLS is easy to cargo-cult:
--
-- Postgres skips RLS for a table's OWNER unless the table is also set to FORCE.
-- The application runs migrations, so it owns every table here, so the app
-- itself is unaffected — nothing in Prisma has to change and no query can
-- silently start returning fewer rows.
--
-- What changes is everybody else. Enabling RLS with no policy means any other
-- role reads zero rows. That covers the cases that actually happen to a small
-- system: a read-only role handed to a BI tool or a contractor, a connection
-- string that leaks out of a dashboard, a psql session opened as a non-owner
-- role to "just check something". Before this, any of those saw every lead,
-- every invoice, every email and every session token hash in the business.
--
-- FORCE is deliberately NOT set. Forcing RLS on the owner as well would mean
-- writing a policy that grants the app everything, which is a no-op that can
-- only ever break — and per-user row scoping is not expressible here anyway:
-- Prisma holds one pooled connection as one role, so there is no per-request
-- identity for a policy to read. That scoping lives in the application, in
-- middleware/auth.ts (requireRole, scopeClientViewer). If it ever needs to move
-- into the database, the missing piece is a `SET LOCAL app.user_id` issued
-- inside every transaction by a Prisma client extension, and policies written
-- against `current_setting('app.user_id', true)`.
--
-- Granting a new role access from here on is explicit: write a policy for it.


ALTER TABLE "Agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentTaskStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarePlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarePlanCycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Communication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Demo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSequenceStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceLineItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadField" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadResearch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LlmCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "McpServer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Milestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerformanceNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Proposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScraperRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScraperSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoredFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimeEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ToolCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
