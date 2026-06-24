-- Catálogos espejo de Siigo: tipos de comprobante (GET /v1/document-types)
-- y vendedores/usuarios (GET /v1/users). Se sincronizan manualmente desde la
-- UI de Configuración. Antes se consultaban en vivo en cada apertura de la
-- página, pero esto fallaba cuando Siigo no estaba disponible.

CREATE TABLE "siigo_tipo_comprobante" (
  "id"             INTEGER NOT NULL,
  "code"           TEXT    NOT NULL,
  "nombre"         TEXT    NOT NULL,
  "tipo"           TEXT,
  "activo"         BOOLEAN NOT NULL DEFAULT true,
  "sincronizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "siigo_tipo_comprobante_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "siigo_vendedor" (
  "id"             INTEGER NOT NULL,
  "username"       TEXT,
  "nombre"         TEXT,
  "email"          TEXT,
  "activo"         BOOLEAN NOT NULL DEFAULT true,
  "sincronizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "siigo_vendedor_pkey" PRIMARY KEY ("id")
);
