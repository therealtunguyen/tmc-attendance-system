-- CreateIndex
CREATE INDEX "AttendanceEvent_gateId_occurredAt_idx" ON "AttendanceEvent"("gateId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_occurredAt_idx" ON "AttendanceEvent"("occurredAt");

