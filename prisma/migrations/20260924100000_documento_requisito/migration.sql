-- Revisión de Ernesto (24-sep-2026, reunión del 31-ago min 40–50): los
-- documentos que exige un evento (fotos de la revisión del contenedor,
-- registro VUCE y su pago) se suben desde el propio requisito del checklist.
-- El archivo queda amarrado al requisito para saber cuántos lo cubren.
ALTER TABLE "documento" ADD COLUMN "checklistItemId" TEXT;

CREATE INDEX "documento_checklistItemId_idx" ON "documento"("checklistItemId");

ALTER TABLE "documento" ADD CONSTRAINT "documento_checklistItemId_fkey"
  FOREIGN KEY ("checklistItemId") REFERENCES "checklist_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
