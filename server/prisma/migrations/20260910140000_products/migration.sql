CREATE TABLE "Product" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tagline" TEXT NOT NULL DEFAULT '',
  "monthlyPrice" DECIMAL(12,2) NOT NULL,
  "setupPrice" DECIMAL(12,2),
  "currency" TEXT NOT NULL DEFAULT 'GHS',
  "publicPath" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_key_key" ON "Product"("key");
CREATE INDEX "Product_active_sortOrder_idx" ON "Product"("active", "sortOrder");

ALTER TABLE "Product" ADD CONSTRAINT "Product_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
