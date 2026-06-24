-- Campo tipoFija en linea_revision para identificar las líneas auto-generadas
-- que corresponden a conceptos fijos del borrador (4x1000 y costos bancarios).
-- Valores posibles: "IMPUESTO_4X1000" | "COSTOS_BANCARIOS" | NULL
-- Las líneas con tipoFija se recrean/actualizan automáticamente al generar el
-- borrador y no deben editarse manualmente (valor bloqueado en UI).

ALTER TABLE "linea_revision" ADD COLUMN "tipoFija" TEXT;
