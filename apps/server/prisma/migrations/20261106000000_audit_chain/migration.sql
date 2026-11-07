-- AlterTable. AuditEntry has no rows yet: IamService.append threw NotImplementedError until now.
ALTER TABLE "AuditEntry" ADD COLUMN     "seq" SERIAL NOT NULL,
ADD COLUMN     "before" JSONB,
ADD COLUMN     "after" JSONB,
ADD COLUMN     "prevHash" TEXT NOT NULL,
ADD COLUMN     "hash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AuditEntry_seq_key" ON "AuditEntry"("seq");

-- CreateIndex
CREATE INDEX "AuditEntry_target_at_idx" ON "AuditEntry"("target", "at");

-- CreateIndex
CREATE INDEX "AuditEntry_at_idx" ON "AuditEntry"("at");

-- Append-only (FR-4.9): rejects UPDATE, DELETE and TRUNCATE from the app. The table owner can still disable the trigger; a separate owner role with INSERT/SELECT-only grants for the app is future work.
CREATE FUNCTION audit_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEntry is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_no_update_delete
BEFORE UPDATE OR DELETE ON "AuditEntry"
FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();

CREATE TRIGGER audit_entry_no_truncate
BEFORE TRUNCATE ON "AuditEntry"
FOR EACH STATEMENT EXECUTE FUNCTION audit_entry_append_only();
