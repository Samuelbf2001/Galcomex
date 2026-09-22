-- Canal WhatsApp (Kapso) para pedir el código del token PSE a los aprobadores.
-- Aditiva: solo agrega columnas opcionales y dos tablas nuevas.


-- AlterTable
ALTER TABLE "pse_solicitud" ADD COLUMN     "anuladaAt" TIMESTAMP(3),
ADD COLUMN     "beneficiario" TEXT,
ADD COLUMN     "canal" TEXT,
ADD COLUMN     "concepto" TEXT,
ADD COLUMN     "noPuedeAt" TIMESTAMP(3),
ADD COLUMN     "noPuedePor" TEXT,
ADD COLUMN     "respondidaPor" TEXT,
ADD COLUMN     "valor" BIGINT;

-- CreateTable
CREATE TABLE "whatsapp_mensaje" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "pseSolicitudId" TEXT,
    "destinatario" TEXT NOT NULL,
    "nombreDestino" TEXT,
    "wamid" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "error" TEXT,
    "respuesta" TEXT,
    "respondidoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_mensaje_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_entrante" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "remitente" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "resultado" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_entrante_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_mensaje_wamid_key" ON "whatsapp_mensaje"("wamid");

-- CreateIndex
CREATE INDEX "whatsapp_mensaje_destinatario_createdAt_idx" ON "whatsapp_mensaje"("destinatario", "createdAt");

-- CreateIndex
CREATE INDEX "whatsapp_mensaje_pseSolicitudId_idx" ON "whatsapp_mensaje"("pseSolicitudId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_entrante_wamid_key" ON "whatsapp_entrante"("wamid");

-- CreateIndex
CREATE INDEX "whatsapp_entrante_createdAt_idx" ON "whatsapp_entrante"("createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_mensaje" ADD CONSTRAINT "whatsapp_mensaje_pseSolicitudId_fkey" FOREIGN KEY ("pseSolicitudId") REFERENCES "pse_solicitud"("id") ON DELETE CASCADE ON UPDATE CASCADE;

