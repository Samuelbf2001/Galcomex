-- Fase 3 del plan «Empresa + Datos de pago» (PLAN-EMPRESA-DATOS-DE-PAGO.md):
-- toda ficha de pago (beneficiario) pertenece a una empresa, salvo la ficha
-- del socio (Luis Martínez), que queda suelta a propósito y marcada.
--
-- Aditiva y sin tocar dinero: no cambia ids, NIT, nitBase ni la llave de
-- facturas (proveedorClave). No borra ni enlaza fichas.

-- 1. Marca de la ficha del socio.
ALTER TABLE "beneficiario" ADD COLUMN "esFichaSocio" BOOLEAN NOT NULL DEFAULT false;

UPDATE "beneficiario"
   SET "esFichaSocio" = true
 WHERE "id" = 'cmr2rz269003knu0itmdbzki9'
   AND "empresaId" IS NULL;

-- Solo puede haber una ficha del socio.
CREATE UNIQUE INDEX "beneficiario_una_ficha_socio" ON "beneficiario" ("esFichaSocio") WHERE "esFichaSocio";

-- 2. Empresa obligatoria (o ficha del socio, nunca las dos cosas).
-- NOT VALID: las fichas sueltas que ya existen (hoy solo las 4 de prueba que
-- decide Camila) no bloquean el despliegue, pero cualquier ficha nueva o
-- editada debe cumplirlo. Cuando se resuelvan esas 4, otra migración hace
-- `ALTER TABLE "beneficiario" VALIDATE CONSTRAINT "beneficiario_empresa_o_socio";`.
ALTER TABLE "beneficiario"
  ADD CONSTRAINT "beneficiario_empresa_o_socio"
  CHECK (("empresaId" IS NOT NULL) <> "esFichaSocio") NOT VALID;

-- 3. Una empresa con datos de pago no se borra dejando la ficha suelta: antes
-- era SET NULL (que ahora chocaría con el CHECK). El borrado de la empresa
-- quita primero sus fichas sin uso (ruta DELETE /api/clientes/[id]).
ALTER TABLE "beneficiario" DROP CONSTRAINT "beneficiario_empresaId_fkey";
ALTER TABLE "beneficiario" ADD CONSTRAINT "beneficiario_empresaId_fkey"
    FOREIGN KEY ("empresaId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
