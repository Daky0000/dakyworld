-- CreateTable
CREATE TABLE "DemoVisit" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ip" TEXT,
    "country" TEXT,
    "countryName" TEXT,
    "city" TEXT,
    "userAgent" TEXT,
    "deviceType" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "viewportWidth" INTEGER,
    "viewportHeight" INTEGER,
    "screenWidth" INTEGER,
    "screenHeight" INTEGER,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "scrollDepth" INTEGER NOT NULL DEFAULT 0,
    "clicks" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoVisit_demoId_idx" ON "DemoVisit"("demoId");

-- CreateIndex
CREATE INDEX "DemoVisit_sessionId_idx" ON "DemoVisit"("sessionId");

-- CreateIndex
CREATE INDEX "DemoVisit_createdAt_idx" ON "DemoVisit"("createdAt");

-- AddForeignKey
ALTER TABLE "DemoVisit" ADD CONSTRAINT "DemoVisit_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "Demo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
