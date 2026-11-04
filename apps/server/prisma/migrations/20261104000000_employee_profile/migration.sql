-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "email" TEXT NOT NULL,
ADD COLUMN     "factoryId" TEXT NOT NULL,
ADD COLUMN     "teamId" TEXT;

-- CreateIndex
CREATE INDEX "Employee_factoryId_idx" ON "Employee"("factoryId");

-- CreateIndex
CREATE INDEX "Employee_teamId_idx" ON "Employee"("teamId");

