-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ScanMethod" AS ENUM ('QR', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScanOutcome" AS ENUM ('PENDING', 'GRANTED', 'DENIED');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "qrRevoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "employeeId" TEXT,
    "gateId" TEXT NOT NULL,
    "edgeId" TEXT,
    "method" "ScanMethod" NOT NULL,
    "outcome" "ScanOutcome" NOT NULL DEFAULT 'PENDING',
    "jti" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "Edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "edgeId" TEXT NOT NULL,

    CONSTRAINT "Gate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_code_key" ON "Employee"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEvent_eventId_key" ON "AttendanceEvent"("eventId");

-- CreateIndex
CREATE INDEX "AttendanceEvent_jti_idx" ON "AttendanceEvent"("jti");

-- CreateIndex
CREATE INDEX "AuditEntry_actorId_at_idx" ON "AuditEntry"("actorId", "at");

-- AddForeignKey
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_edgeId_fkey" FOREIGN KEY ("edgeId") REFERENCES "Edge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

