-- CreateTable
CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "supervisorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigValue" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ConfigValue_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "OrgUnit_parentId_idx" ON "OrgUnit"("parentId");
