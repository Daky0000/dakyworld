-- Messages sent through forms on hosted websites. RLS on like every new table:
-- the app connects as the table owner, and nothing else should read these.
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pagePath" TEXT NOT NULL,
    "formName" TEXT,
    "fields" JSONB NOT NULL,
    "email" TEXT,
    "spam" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FormSubmission_siteId_spam_createdAt_idx" ON "FormSubmission"("siteId", "spam", "createdAt");

ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FormSubmission" ENABLE ROW LEVEL SECURITY;
