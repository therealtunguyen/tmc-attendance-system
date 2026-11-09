-- CreateEnum
CREATE TYPE "CorrectionField" AS ENUM ('FIRST_IN', 'LAST_OUT');

-- CreateTable
CREATE TABLE "Correction" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "field" "CorrectionField" NOT NULL,
    "originalValue" TIMESTAMP(3),
    "correctedValue" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Correction_employeeId_day_idx" ON "Correction"("employeeId", "day");
