-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('RUNNING', 'BLOCKED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateTable
CREATE TABLE "ExportRun" (
    "month" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL,
    "trigger" "ExportTrigger" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ExportRun_pkey" PRIMARY KEY ("month")
);

