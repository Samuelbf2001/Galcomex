-- Ciudad de la empresa (Cliente), para que salga en la cotización (PDF del
-- tarifario). Aditiva: nullable, no toca datos existentes.
ALTER TABLE "cliente" ADD COLUMN "ciudad" TEXT;
