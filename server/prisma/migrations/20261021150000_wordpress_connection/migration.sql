-- A WordPress site edited through its REST API with an Application Password.
CREATE TABLE "WordPressConnection" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "apiRoot" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "applicationPassword" TEXT NOT NULL,
    "details" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WordPressConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WordPressConnection_siteId_key" ON "WordPressConnection"("siteId");

-- AddForeignKey
ALTER TABLE "WordPressConnection" ADD CONSTRAINT "WordPressConnection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
