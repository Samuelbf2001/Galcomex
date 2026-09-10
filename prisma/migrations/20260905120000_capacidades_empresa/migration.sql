-- Fase 0 del PLAN-CONFIGURABILIDAD: capacidades por empresa (M1) + cimientos de
-- la contraparte única (M5: roles simultáneos y grupo económico).
--
-- Aditiva: no borra ni renombra nada. `cliente.manejaAnticipo` se conserva y se
-- mantiene en espejo con la capacidad `anticipos_cliente` durante la transición.

-- ─── Grupo económico ─────────────────────────────────────────────────────────
CREATE TABLE "grupo_empresa" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grupo_empresa_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grupo_empresa_nombre_key" ON "grupo_empresa"("nombre");

-- ─── Roles simultáneos de la contraparte ─────────────────────────────────────
-- Una misma empresa puede ser cliente y proveedor (Ascinter, Coldex, Eltrans).
ALTER TABLE "cliente" ADD COLUMN "esCliente" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cliente" ADD COLUMN "esProveedor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cliente" ADD COLUMN "grupoEmpresaId" TEXT;

CREATE INDEX "cliente_grupoEmpresaId_idx" ON "cliente"("grupoEmpresaId");

ALTER TABLE "cliente" ADD CONSTRAINT "cliente_grupoEmpresaId_fkey"
    FOREIGN KEY ("grupoEmpresaId") REFERENCES "grupo_empresa"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Capacidades ─────────────────────────────────────────────────────────────
CREATE TYPE "AmbitoCapacidad" AS ENUM ('EMPRESA', 'GLOBAL');

CREATE TABLE "capacidad" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "grupo" TEXT NOT NULL,
    "ambito" "AmbitoCapacidad" NOT NULL DEFAULT 'EMPRESA',
    "porDefecto" BOOLEAN NOT NULL DEFAULT false,
    "configPorDefecto" JSONB,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capacidad_pkey" PRIMARY KEY ("codigo")
);

CREATE TABLE "empresa_capacidad" (
    "empresaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL,
    "config" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "empresa_capacidad_pkey" PRIMARY KEY ("empresaId","codigo")
);

CREATE INDEX "empresa_capacidad_codigo_idx" ON "empresa_capacidad"("codigo");

CREATE TABLE "grupo_empresa_capacidad" (
    "grupoId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL,
    "config" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grupo_empresa_capacidad_pkey" PRIMARY KEY ("grupoId","codigo")
);

CREATE INDEX "grupo_empresa_capacidad_codigo_idx" ON "grupo_empresa_capacidad"("codigo");

ALTER TABLE "empresa_capacidad" ADD CONSTRAINT "empresa_capacidad_empresaId_fkey"
    FOREIGN KEY ("empresaId") REFERENCES "cliente"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "empresa_capacidad" ADD CONSTRAINT "empresa_capacidad_codigo_fkey"
    FOREIGN KEY ("codigo") REFERENCES "capacidad"("codigo")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grupo_empresa_capacidad" ADD CONSTRAINT "grupo_empresa_capacidad_grupoId_fkey"
    FOREIGN KEY ("grupoId") REFERENCES "grupo_empresa"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grupo_empresa_capacidad" ADD CONSTRAINT "grupo_empresa_capacidad_codigo_fkey"
    FOREIGN KEY ("codigo") REFERENCES "capacidad"("codigo")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Catálogo inicial ────────────────────────────────────────────────────────
-- Espejo de src/lib/capacidades/catalogo.ts (fuente de verdad del código).
-- Idempotente para que producción no dependa de correr el seed.
INSERT INTO "capacidad" ("codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto", "configPorDefecto", "orden", "activa", "updatedAt") VALUES
  ('anticipos_cliente', 'Anticipos del cliente', 'La empresa fondea sus trámites con anticipos antes de que Galcomex pague a proveedores.', 'Cartera', 'EMPRESA', true, NULL, 10, true, CURRENT_TIMESTAMP),
  ('tarifario_propio', 'Tarifario propio versionado', 'La empresa tiene su propia propuesta comercial con vigencia; las líneas operacionales de la factura se calculan desde ella.', 'Comercial', 'EMPRESA', false, NULL, 20, true, CURRENT_TIMESTAMP),
  ('base_cif', 'CIF como base de cálculo', 'Se captura el CIF del trámite y habilita tarifas de tipo porcentaje sobre CIF con mínimo por tipo de carga.', 'Comercial', 'EMPRESA', false, NULL, 30, true, CURRENT_TIMESTAMP),
  ('clasificacion_arancelaria', 'Clasificación arancelaria facturada aparte', 'Habilita el tipo de trámite de clasificación, con consecutivo propio y facturación separada de los trámites de importación.', 'Comercial', 'EMPRESA', false, NULL, 40, true, CURRENT_TIMESTAMP),
  ('eventos_facturables', 'Eventos facturables en el trámite', 'Muestra en el resumen del trámite los eventos que disparan cobro (contenedor abierto, entrega directa, despacho parcial, registro elaborado).', 'Operacion', 'EMPRESA', false, NULL, 50, true, CURRENT_TIMESTAMP),
  ('contenedores_obligatorio', 'Número de contenedores obligatorio', 'Exige capturar el número de contenedores (viene del BL) al crear el trámite. Base de las comisiones por contenedor.', 'Operacion', 'EMPRESA', false, NULL, 60, true, CURRENT_TIMESTAMP),
  ('umbral_saldo_tramite', 'Umbral de alerta de saldo propio', 'Sobrescribe el umbral de alerta de saldo del trámite para esta empresa. Sin activar se usa el parámetro global por tipo de cliente.', 'Operacion', 'EMPRESA', false, '{"valor": "500000"}', 70, true, CURRENT_TIMESTAMP),
  ('comision_por_evento', 'Comisión a cobrar por contenedor', 'La contraparte le paga a Galcomex una comisión por unidad operada (caso Eltrans). Genera saldo a favor en su cuenta corriente.', 'Cartera', 'EMPRESA', false, '{"unidad": "CONTENEDOR", "valor": "0"}', 80, true, CURRENT_TIMESTAMP),
  ('cargos_manuales_contraparte', 'Cargos manuales de contraparte', 'Permite cargar a mano los importes variables que la contraparte factura por fuera de los trámites (caso Coldex: mensualidad, quincenas, primas).', 'Cartera', 'EMPRESA', false, NULL, 90, true, CURRENT_TIMESTAMP),
  ('orden_compra_en_revision', 'Orden de compra en la revisión', 'La revisión del borrador exige contrastar contra la orden de compra del cliente antes de aprobar.', 'Facturacion', 'EMPRESA', false, NULL, 100, true, CURRENT_TIMESTAMP),
  ('factura_multi_do', 'Una factura para varios DO', 'Permite agrupar varios trámites en una sola factura de venta (caso BAQ-18701, que cubre tres DO).', 'Facturacion', 'EMPRESA', false, NULL, 110, true, CURRENT_TIMESTAMP),
  ('docs_bl_factura_obligatorios', 'BL y factura comercial obligatorios', 'Sin BL/Guía y factura comercial adjuntos no se puede crear el trámite.', 'Documentos', 'EMPRESA', false, NULL, 120, true, CURRENT_TIMESTAMP)
ON CONFLICT ("codigo") DO NOTHING;

-- ─── Backfill de manejaAnticipo → capacidad anticipos_cliente ────────────────
-- Solo se materializa el override donde la empresa DIVERGE del defecto (true).
-- Las que ya venían en true heredan, que es el estado que queremos por diseño.
INSERT INTO "empresa_capacidad" ("empresaId", "codigo", "habilitado", "config", "updatedAt")
SELECT "id", 'anticipos_cliente', false, NULL, CURRENT_TIMESTAMP
FROM "cliente"
WHERE "manejaAnticipo" = false
ON CONFLICT ("empresaId", "codigo") DO NOTHING;

-- Los clientes existentes son clientes; el rol proveedor se marca a mano
-- (Ascinter, Coldex, Eltrans) cuando se cargue la cartera de proveedores.
UPDATE "cliente" SET "esCliente" = true WHERE "esCliente" IS NOT TRUE;
