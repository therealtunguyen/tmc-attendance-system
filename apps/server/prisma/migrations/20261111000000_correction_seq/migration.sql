-- AlterTable
ALTER TABLE "Correction" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Correction_seq_key" ON "Correction"("seq");
