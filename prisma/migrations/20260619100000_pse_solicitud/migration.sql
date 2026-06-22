-- CreateTable
CREATE TABLE "pse_solicitud" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "codigoPseEnc" TEXT,
    "solicitadoPor" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondidaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pse_solicitud_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pse_solicitud_token_key" ON "pse_solicitud"("token");

-- AddForeignKey
ALTER TABLE "pse_solicitud" ADD CONSTRAINT "pse_solicitud_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;
