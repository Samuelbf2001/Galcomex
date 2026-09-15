-- Reunión Camila × Samuel × Ernesto, 10-sep-2026 (19:32). Todo aditivo.
--
-- 1. Agencia de aduanas CORTES: Polyrec también manda órdenes de compra a
--    "Cortes", la otra agencia (min 84:30).
-- 2. Tarifa POR_TRAMO: Polyrec ZF, traslados — "si es un contenedor son 300;
--    si son dos o más, 250 cada contenedor" (min 83:31). El tarifario no tenía
--    esa forma de cálculo.
-- 3. Orden de compra en el DO: Polyrec nacionalización devuelve una OC por el
--    valor de la solicitud de fondos; la factura debe dar ese valor sin IVA y
--    llevar el número de OC en la descripción (min 84:30 a 86:30). Alimenta la
--    capacidad `orden_compra_en_revision`, que hasta hoy no tenía consumidor.
-- 4. Tipo de trámite OTRO: Plan Vallejo, sellos, coordinación logística —
--    "eso también se cobra, no es un DO" (min 15:27 a 19:15). Consecutivo
--    propio para no consumir números de importación, sin agencia, sin ETA,
--    sin checklist, factura aparte y línea de cartera OTROS.

ALTER TYPE "AgenciaAduanas" ADD VALUE IF NOT EXISTS 'CORTES';

ALTER TYPE "TipoCalculoTarifa" ADD VALUE IF NOT EXISTS 'POR_TRAMO';

ALTER TABLE "tarifa_item" ADD COLUMN "tramos" JSONB;

ALTER TABLE "tramite_do" ADD COLUMN "ordenCompraNumero" TEXT;
ALTER TABLE "tramite_do" ADD COLUMN "ordenCompraValor" BIGINT;

INSERT INTO "tipo_tramite" (
    "codigo", "nombre", "descripcion", "prefijoConsecutivo", "secuenciaPor",
    "incluyeCiudadEnConsecutivo", "lineaServicio", "facturacionSeparada",
    "capacidadRequerida", "requiereAgenciaAduanas", "agenciaAduanasPorDefecto",
    "requiereEta", "usaChecklist", "etiquetaReferenciaExterna", "orden", "activo", "updatedAt"
) VALUES
  ('OTRO', 'Otros servicios',
   'Servicios sueltos que se cobran sin DO: firma de Plan Vallejo, sellos, coordinación logística. Consecutivo propio (OTR26-0001), sin agencia, sin ETA ni checklist; se factura aparte.',
   'OTR', 'ANIO', false, 'OTROS', true,
   NULL, false, NULL, false, false, 'Servicio prestado', 30, true, CURRENT_TIMESTAMP)
ON CONFLICT ("codigo") DO NOTHING;
