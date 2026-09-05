-- M5 del PLAN-CONFIGURABILIDAD: cuenta corriente por contraparte.
--
-- Una misma empresa puede debernos como cliente y que le debamos como
-- proveedor (Ascinter, Coldex, Eltrans). El saldo de las dos puntas se calcula
-- cruzando lo derivado (facturas de venta, abonos, facturas de proveedor,
-- pagos) con los movimientos que se registran a mano en esta tabla: los
-- importes que no nacen de un trámite.
--
--   · Cargos manuales — la mensualidad variable de Coldex, quincenas, primas.
--   · Comisiones      — lo que Eltrans le paga a Galcomex por contenedor.
--   · Ajustes         — correcciones puntuales, siempre auditadas.

CREATE TYPE "RolCuenta" AS ENUM ('CLIENTE', 'PROVEEDOR');
CREATE TYPE "TipoMovimientoCuenta" AS ENUM ('CARGO', 'ABONO');
CREATE TYPE "OrigenMovimientoCuenta" AS ENUM ('CARGO_MANUAL', 'COMISION', 'AJUSTE');

CREATE TABLE "movimiento_cuenta" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "rol" "RolCuenta" NOT NULL,
    "tipo" "TipoMovimientoCuenta" NOT NULL,
    "origen" "OrigenMovimientoCuenta" NOT NULL,
    "lineaServicio" TEXT NOT NULL DEFAULT 'TRAMITE',
    "concepto" TEXT NOT NULL,
    "valor" BIGINT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "tramiteId" TEXT,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimiento_cuenta_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "movimiento_cuenta_empresaId_rol_idx" ON "movimiento_cuenta"("empresaId", "rol");
CREATE INDEX "movimiento_cuenta_tramiteId_idx" ON "movimiento_cuenta"("tramiteId");

ALTER TABLE "movimiento_cuenta" ADD CONSTRAINT "movimiento_cuenta_empresaId_fkey"
    FOREIGN KEY ("empresaId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimiento_cuenta" ADD CONSTRAINT "movimiento_cuenta_tramiteId_fkey"
    FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "movimiento_cuenta" ADD CONSTRAINT "movimiento_cuenta_registradoPorId_fkey"
    FOREIGN KEY ("registradoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Puente Beneficiario → ficha de empresa ──────────────────────────────────
-- Mientras `Beneficiario` y `Cliente` sigan siendo tablas separadas, este FK es
-- lo que permite cruzar en una sola cuenta lo que se le paga a una empresa como
-- proveedor con lo que nos debe como cliente.
ALTER TABLE "beneficiario" ADD COLUMN "empresaId" TEXT;

CREATE INDEX "beneficiario_empresaId_idx" ON "beneficiario"("empresaId");

ALTER TABLE "beneficiario" ADD CONSTRAINT "beneficiario_empresaId_fkey"
    FOREIGN KEY ("empresaId") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill por NIT: es el único identificador compartido hoy. Solo enlaza
-- cuando hay exactamente una empresa con ese NIT (el NIT es único en `cliente`,
-- así que la ambigüedad solo puede venir de beneficiarios duplicados).
UPDATE "beneficiario" b
SET "empresaId" = c."id"
FROM "cliente" c
WHERE b."empresaId" IS NULL
  AND b."nit" IS NOT NULL
  AND TRIM(b."nit") <> ''
  AND TRIM(b."nit") = TRIM(c."nit");

-- Las empresas que resultaron tener ficha de pago son, por definición,
-- proveedores: se marca el rol para que la ficha lo muestre.
UPDATE "cliente" c
SET "esProveedor" = true
WHERE EXISTS (SELECT 1 FROM "beneficiario" b WHERE b."empresaId" = c."id");
