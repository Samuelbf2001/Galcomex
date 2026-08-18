-- CreateTable
CREATE TABLE "enlace_documento" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revocadoEn" TIMESTAMP(3),
    "aperturas" INTEGER NOT NULL DEFAULT 0,
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enlace_documento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enlace_documento_token_key" ON "enlace_documento"("token");

-- CreateIndex
CREATE INDEX "enlace_documento_documentoId_idx" ON "enlace_documento"("documentoId");

-- AddForeignKey
ALTER TABLE "enlace_documento" ADD CONSTRAINT "enlace_documento_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enlace_documento" ADD CONSTRAINT "enlace_documento_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
