-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('ADMIN', 'REVISOR', 'OPERATIVO', 'SOCIO');

-- CreateEnum
CREATE TYPE "TipoCliente" AS ENUM ('PROPIO', 'SOCIO_LM');

-- CreateEnum
CREATE TYPE "Ciudad" AS ENUM ('BAQ', 'CTG', 'BUN', 'SMR');

-- CreateEnum
CREATE TYPE "AgenciaAduanas" AS ENUM ('MOVIADUANAS', 'COLDEX');

-- CreateEnum
CREATE TYPE "EstadoTramite" AS ENUM ('SOLICITUD', 'APERTURA', 'EN_TRAMITE', 'EN_PUERTO', 'DESPACHADO', 'ENVIADO_A_FACTURAR', 'FACTURADO', 'PAGADO', 'CERRADO');

-- CreateEnum
CREATE TYPE "CategoriaDocumento" AS ENUM ('FACTURA_COMERCIAL', 'BL', 'PACKING_LIST', 'DECLARACION_DIAN', 'SOPORTE_FACTURACION', 'FOTO_RECONOCIMIENTO', 'COMPROBANTE_BANCARIO', 'FACTURA_PROVEEDOR', 'OTRO');

-- CreateEnum
CREATE TYPE "CanalPago" AS ENUM ('BANCOLOMBIA_SUCURSAL', 'BANCOLOMBIA_CAJERO', 'BANCOLOMBIA_CORRESPONSAL', 'BANCOLOMBIA_TRANSFERENCIA', 'OTROS_BANCOS_SUCURSAL', 'OTROS_BANCOS_TRANSFERENCIA', 'PSE', 'OTRO');

-- CreateEnum
CREATE TYPE "EstadoBorrador" AS ENUM ('BORRADOR', 'EN_REVISION', 'APROBADO', 'FACTURADO');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rol" "Rol" NOT NULL DEFAULT 'OPERATIVO',

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cliente" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "tipo" "TipoCliente" NOT NULL DEFAULT 'PROPIO',
    "contactoNombre" TEXT,
    "contactoEmail" TEXT,
    "contactoTel" TEXT,
    "manejaAnticipo" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tarifa_cliente" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor" BIGINT NOT NULL,

    CONSTRAINT "tarifa_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tramite_do" (
    "id" TEXT NOT NULL,
    "consecutivo" TEXT NOT NULL,
    "ciudad" "Ciudad" NOT NULL,
    "anio" INTEGER NOT NULL,
    "numero" INTEGER NOT NULL,
    "clienteId" TEXT NOT NULL,
    "proveedorCliente" TEXT,
    "agenciaAduanas" "AgenciaAduanas" NOT NULL,
    "doAgencia" TEXT,
    "doCliente" TEXT,
    "eta" TIMESTAMP(3),
    "estado" "EstadoTramite" NOT NULL DEFAULT 'SOLICITUD',
    "comentarios" TEXT,
    "fechaAceptacionDeclaracion" TIMESTAMP(3),
    "fechaLevante" TIMESTAMP(3),
    "fechaEnviadoAFacturar" TIMESTAMP(3),
    "fechaDocumentosOk" TIMESTAMP(3),
    "fechaSalidaCarga" TIMESTAMP(3),
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tramite_do_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estado_log" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "estadoAntes" "EstadoTramite" NOT NULL,
    "estadoDes" "EstadoTramite" NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estado_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plantilla_checklist" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "plantilla_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plantilla_checklist_item" (
    "id" TEXT NOT NULL,
    "plantillaId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "requerido" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plantilla_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_item" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "requerido" BOOLEAN NOT NULL DEFAULT true,
    "recibido" BOOLEAN NOT NULL DEFAULT false,
    "validadoPorId" TEXT,
    "fechaValidacion" TIMESTAMP(3),

    CONSTRAINT "checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documento" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "categoria" "CategoriaDocumento" NOT NULL,
    "nombreArchivo" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "tamanoBytes" INTEGER NOT NULL,
    "eliminado" BOOLEAN NOT NULL DEFAULT false,
    "subidoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matriz_recaudo_pago" (
    "id" TEXT NOT NULL,
    "canal" "CanalPago" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "costoFijo" BIGINT NOT NULL,

    CONSTRAINT "matriz_recaudo_pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anticipo" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "monto" BIGINT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "canalPago" "CanalPago" NOT NULL,
    "soporteKey" TEXT,
    "verificadoBanco" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anticipo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aplicacion_anticipo" (
    "id" TEXT NOT NULL,
    "anticipoId" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "montoAplicado" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aplicacion_anticipo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago_tramite" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "beneficiario" TEXT,
    "numSoporte" TEXT,
    "documentoId" TEXT,
    "valor" BIGINT NOT NULL,
    "canalPago" "CanalPago" NOT NULL,
    "costoBancario" BIGINT NOT NULL DEFAULT 0,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pago_tramite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrador_factura" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "comision" BIGINT NOT NULL,
    "ivaComision" BIGINT NOT NULL,
    "impuesto4x1000" BIGINT NOT NULL,
    "costosBancarios" BIGINT NOT NULL,
    "totalAnticipo" BIGINT NOT NULL,
    "totalPagos" BIGINT NOT NULL,
    "totalFactura" BIGINT NOT NULL,
    "saldoAFavorCliente" BIGINT NOT NULL DEFAULT 0,
    "saldoACargoCliente" BIGINT NOT NULL DEFAULT 0,
    "saldoAFavorLM" BIGINT NOT NULL DEFAULT 0,
    "saldoACargoLM" BIGINT NOT NULL DEFAULT 0,
    "snapshotCalculo" JSONB,
    "estado" "EstadoBorrador" NOT NULL DEFAULT 'BORRADOR',
    "aprobadoPorId" TEXT,
    "fechaAprobacion" TIMESTAMP(3),
    "facturadoPorId" TEXT,
    "numFacturaSiigo" TEXT,
    "fechaFactura" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "borrador_factura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linea_revision" (
    "id" TEXT NOT NULL,
    "borradorId" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "numSoporte" TEXT,
    "valor" BIGINT NOT NULL,
    "observacion" TEXT,
    "aprobada" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "linea_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factura" (
    "id" TEXT NOT NULL,
    "borradorId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "numSiigo" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "totalFactura" BIGINT NOT NULL,
    "saldoAFavorCliente" BIGINT NOT NULL,
    "saldoACargoCliente" BIGINT NOT NULL,
    "saldoAFavorLM" BIGINT NOT NULL,
    "saldoACargoLM" BIGINT NOT NULL,
    "pdfKey" TEXT,
    "fechaPagoCliente" TIMESTAMP(3),
    "fechaPagoLM" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parametro" (
    "id" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "descripcion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parametro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidadId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "tramiteId" TEXT,
    "antes" JSONB,
    "despues" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "cliente_nit_key" ON "cliente"("nit");

-- CreateIndex
CREATE UNIQUE INDEX "tarifa_cliente_clienteId_anio_tipo_key" ON "tarifa_cliente"("clienteId", "anio", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "tramite_do_consecutivo_key" ON "tramite_do"("consecutivo");

-- CreateIndex
CREATE UNIQUE INDEX "tramite_do_ciudad_anio_numero_key" ON "tramite_do"("ciudad", "anio", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "matriz_recaudo_pago_canal_key" ON "matriz_recaudo_pago"("canal");

-- CreateIndex
CREATE UNIQUE INDEX "factura_borradorId_key" ON "factura"("borradorId");

-- CreateIndex
CREATE UNIQUE INDEX "factura_numSiigo_key" ON "factura"("numSiigo");

-- CreateIndex
CREATE UNIQUE INDEX "parametro_clave_key" ON "parametro"("clave");

-- CreateIndex
CREATE INDEX "audit_log_entidad_entidadId_idx" ON "audit_log"("entidad", "entidadId");

-- CreateIndex
CREATE INDEX "audit_log_usuarioId_idx" ON "audit_log"("usuarioId");

-- CreateIndex
CREATE INDEX "audit_log_tramiteId_idx" ON "audit_log"("tramiteId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarifa_cliente" ADD CONSTRAINT "tarifa_cliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tramite_do" ADD CONSTRAINT "tramite_do_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tramite_do" ADD CONSTRAINT "tramite_do_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estado_log" ADD CONSTRAINT "estado_log_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla_checklist_item" ADD CONSTRAINT "plantilla_checklist_item_plantillaId_fkey" FOREIGN KEY ("plantillaId") REFERENCES "plantilla_checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_item" ADD CONSTRAINT "checklist_item_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_item" ADD CONSTRAINT "checklist_item_validadoPorId_fkey" FOREIGN KEY ("validadoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento" ADD CONSTRAINT "documento_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento" ADD CONSTRAINT "documento_subidoPorId_fkey" FOREIGN KEY ("subidoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anticipo" ADD CONSTRAINT "anticipo_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aplicacion_anticipo" ADD CONSTRAINT "aplicacion_anticipo_anticipoId_fkey" FOREIGN KEY ("anticipoId") REFERENCES "anticipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aplicacion_anticipo" ADD CONSTRAINT "aplicacion_anticipo_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrador_factura" ADD CONSTRAINT "borrador_factura_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrador_factura" ADD CONSTRAINT "borrador_factura_aprobadoPorId_fkey" FOREIGN KEY ("aprobadoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrador_factura" ADD CONSTRAINT "borrador_factura_facturadoPorId_fkey" FOREIGN KEY ("facturadoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linea_revision" ADD CONSTRAINT "linea_revision_borradorId_fkey" FOREIGN KEY ("borradorId") REFERENCES "borrador_factura"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura" ADD CONSTRAINT "factura_borradorId_fkey" FOREIGN KEY ("borradorId") REFERENCES "borrador_factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura" ADD CONSTRAINT "factura_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE SET NULL ON UPDATE CASCADE;

