-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "custom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'EMAIL_ATTACHMENT',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "url" TEXT NOT NULL,
    "authHeader" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "spends" BOOLEAN NOT NULL DEFAULT false,
    "outward" BOOLEAN NOT NULL DEFAULT false,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");

-- CreateIndex
CREATE INDEX "StoredFile_purpose_createdAt_idx" ON "StoredFile"("purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_key_key" ON "McpServer"("key");

-- CreateIndex
CREATE INDEX "McpServer_enabled_idx" ON "McpServer"("enabled");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

