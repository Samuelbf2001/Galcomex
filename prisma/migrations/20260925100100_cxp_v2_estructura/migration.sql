-- CxP v2 · M2 — Estructura (docs/CXP-PROVEEDORES.md)
--
-- DDL aditivo + funciones SQL puras. Sin triggers todavía y sin restricciones
-- que dependan de datos: el `monto` del puente nace NULL y M3 lo llena antes de
-- volverlo NOT NULL; la FK pago_tramite.grupoPagoId → pago_grupo y el índice
-- único (proveedorClave, numFacturaNormalizado) también van en M3, después del
-- backfill. Nada aquí puede fallar con datos de producción.

-- ─── Beneficiario (ficha de pago) ────────────────────────────────────────────
ALTER TABLE "beneficiario" ADD COLUMN     "carteraConciliadaEn" TIMESTAMP(3),
ADD COLUMN     "conciliacionPendiente" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nitBase" TEXT,
ADD COLUMN     "nombreCorto" TEXT,
ADD COLUMN     "numFacturaConEspacio" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "beneficiario_nitBase_idx" ON "beneficiario"("nitBase");

-- ─── Factura de proveedor ────────────────────────────────────────────────────
ALTER TABLE "factura_proveedor" ADD COLUMN     "fechaTrm" TIMESTAMP(3),
ADD COLUMN     "moneda" "Moneda" NOT NULL DEFAULT 'COP',
ADD COLUMN     "montoCompensado" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "numFacturaNormalizado" TEXT,
ADD COLUMN     "proveedorClave" TEXT,
ADD COLUMN     "trmCentavos" BIGINT,
ADD COLUMN     "valorOrigenCentavos" BIGINT;

CREATE INDEX "factura_proveedor_beneficiarioId_estado_idx" ON "factura_proveedor"("beneficiarioId", "estado");

-- montoCompensado nace en 0 y M3 lo llena con GREATEST(0, …): no puede fallar.
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_montoCompensado_ck" CHECK ("montoCompensado" >= 0);

-- ─── Pago del trámite ────────────────────────────────────────────────────────
ALTER TABLE "pago_tramite" ADD COLUMN     "claveIdempotencia" TEXT,
ADD COLUMN     "hashSolicitud" TEXT;

CREATE UNIQUE INDEX "pago_tramite_claveIdempotencia_key" ON "pago_tramite"("claveIdempotencia");

-- ─── Puente pago ↔ factura ───────────────────────────────────────────────────
-- `monto` nullable aquí; M3 lo llena y lo vuelve NOT NULL + CHECK (>= 0).
ALTER TABLE "pago_tramite_factura" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "monto" BIGINT;

CREATE INDEX "pago_tramite_factura_facturaId_idx" ON "pago_tramite_factura"("facturaId");

-- ─── Ajustes de factura (v2: solo LEGADO, lo escribe M3) ─────────────────────
CREATE TABLE "ajuste_factura_proveedor" (
    "id" TEXT NOT NULL,
    "facturaId" TEXT NOT NULL,
    "tipo" "TipoAjusteFacturaProveedor" NOT NULL,
    "monto" BIGINT NOT NULL,
    "motivo" TEXT NOT NULL,
    "usuarioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ajuste_factura_proveedor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ajuste_factura_proveedor_monto_ck" CHECK ("monto" > 0)
);

CREATE INDEX "ajuste_factura_proveedor_facturaId_idx" ON "ajuste_factura_proveedor"("facturaId");

ALTER TABLE "ajuste_factura_proveedor" ADD CONSTRAINT "ajuste_factura_proveedor_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "factura_proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ajuste_factura_proveedor" ADD CONSTRAINT "ajuste_factura_proveedor_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Cabecera del pago en bloque ─────────────────────────────────────────────
CREATE TABLE "pago_grupo" (
    "id" TEXT NOT NULL,
    "beneficiarioId" TEXT,
    "concepto" TEXT NOT NULL,
    "canalPago" "CanalPago" NOT NULL,
    "fechaRealPago" TIMESTAMP(3),
    "documentoId" TEXT,
    "comprobanteComercioId" TEXT,
    "valorTransferido" BIGINT,
    "totalAplicado" BIGINT NOT NULL,
    "costoBancario" BIGINT NOT NULL DEFAULT 0,
    "costoAsumidoPor" "CostoBancarioAsumidoPor" NOT NULL DEFAULT 'PRIMER_DO',
    "estado" "EstadoPagoGrupo" NOT NULL DEFAULT 'ACTIVO',
    "esHistorico" BOOLEAN NOT NULL DEFAULT false,
    "claveIdempotencia" TEXT,
    "hashSolicitud" TEXT,
    "motivoAnulacion" TEXT,
    "anuladoPorId" TEXT,
    "anuladoEn" TIMESTAMP(3),
    "snapshotAnulacion" JSONB,
    "creadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pago_grupo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pago_grupo_claveIdempotencia_key" ON "pago_grupo"("claveIdempotencia");

CREATE INDEX "pago_grupo_beneficiarioId_estado_idx" ON "pago_grupo"("beneficiarioId", "estado");

ALTER TABLE "pago_grupo" ADD CONSTRAINT "pago_grupo_beneficiarioId_fkey" FOREIGN KEY ("beneficiarioId") REFERENCES "beneficiario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pago_grupo" ADD CONSTRAINT "pago_grupo_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pago_grupo" ADD CONSTRAINT "pago_grupo_comprobanteComercioId_fkey" FOREIGN KEY ("comprobanteComercioId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pago_grupo" ADD CONSTRAINT "pago_grupo_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pago_grupo" ADD CONSTRAINT "pago_grupo_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Funciones SQL (fuente de verdad de las llaves; espejos TS en src/lib/cxp/saldos.ts) ──

-- N° de factura normalizado: mayúsculas y solo A-Z0-9. "FE- 12481" → "FE12481".
-- Espejo TS: normalizarNumeroFactura.
CREATE OR REPLACE FUNCTION cxp_normalizar_num(num text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$$ SELECT NULLIF(regexp_replace(upper(coalesce(num, '')), '[^A-Z0-9]', '', 'g'), '') $$;

-- NIT base SIN adivinar el DV (v1.1). El DV solo se separa cuando viene separado
-- con guion ("800.154.017-8", "800154017 - 8" → "800154017"). Una cadena de solo
-- dígitos se toma completa ("800154017" → "800154017", "8001540178" → "8001540178").
-- Con letras (exterior, pruebas) → NULL: no es NIT colombiano y la clave cae a BEN:<id>.
-- Espejo TS: nitBaseDe.
CREATE OR REPLACE FUNCTION cxp_nit_base(nit text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text; base text;
BEGIN
  IF nit IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(upper(btrim(nit)), '^NIT[\s.:]*', '');
  IF s = '' OR s ~ '[^0-9.\s-]' THEN RETURN NULL; END IF;
  IF s ~ '^[0-9.\s]+-\s*[0-9]$' THEN
    base := regexp_replace(split_part(s, '-', 1), '[^0-9]', '', 'g');
  ELSE
    base := regexp_replace(s, '[^0-9]', '', 'g');
  END IF;
  RETURN NULLIF(ltrim(base, '0'), '');
END $$;

-- Dígito de verificación DIAN de un NIT base (pesos 3,7,13,… desde la derecha).
-- Espejo TS: dvNit. 800154017 → 8, 802011826 → 3, 890912462 → 2.
CREATE OR REPLACE FUNCTION cxp_dv_nit(base text) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n int; i int; suma int := 0; resto int;
        pesos int[] := ARRAY[3,7,13,17,19,23,29,37,41,43,47,53,59,67,71];
BEGIN
  IF base IS NULL OR base !~ '^[0-9]{1,15}$' THEN RETURN NULL; END IF;
  n := length(base);
  FOR i IN 1..n LOOP
    suma := suma + substr(base, n - i + 1, 1)::int * pesos[i];
  END LOOP;
  resto := suma % 11;
  RETURN CASE WHEN resto IN (0, 1) THEN resto ELSE 11 - resto END;
END $$;

-- Clave de proveedor de una ficha: "NIT:<nitBase>" o "BEN:<id>" si no tiene NIT colombiano.
CREATE OR REPLACE FUNCTION cxp_clave_proveedor(bid text) RETURNS text
LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN b."nitBase" IS NOT NULL THEN 'NIT:' || b."nitBase" ELSE 'BEN:' || b."id" END
   FROM "beneficiario" b WHERE b."id" = bid $$;
