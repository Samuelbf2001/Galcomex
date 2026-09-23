-- La cuenta corriente cruzada pasa a ser una función por empresa. Solo tiene
-- sentido para quien es cliente y proveedor a la vez (Coldex, Ascinter,
-- Eltrans: reunión del 31-ago, min 68:45–72:50 y 84:02–90:17). En una empresa
-- que solo es cliente, como Litoplas, repetía la cartera y confundía.
-- Aditiva: no toca movimientos ni saldos, solo decide dónde se ve la sección.

INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'cuenta_corriente',
    'Cuenta corriente cruzada',
    'Muestra en la ficha un solo saldo con lo que la empresa nos debe como cliente y lo que le debemos como proveedor, y permite cruzarlos sin mover plata (caso Coldex, Ascinter, Eltrans). Para una empresa que solo es cliente repite la cartera: déjala apagada.',
    'Cartera', 'EMPRESA', false, NULL, 75, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO NOTHING;

-- Se enciende donde ya se usa o tiene sentido: empresas marcadas como
-- proveedor, enlazadas a un beneficiario, con movimientos en la cuenta o con
-- cargos manuales / comisión por contenedor activos.
INSERT INTO "empresa_capacidad" ("empresaId", "codigo", "habilitado", "updatedAt")
SELECT c."id", 'cuenta_corriente', true, CURRENT_TIMESTAMP
FROM "cliente" c
WHERE c."esProveedor" = true
   OR EXISTS (SELECT 1 FROM "beneficiario" b WHERE b."empresaId" = c."id")
   OR EXISTS (SELECT 1 FROM "movimiento_cuenta" m WHERE m."empresaId" = c."id")
   OR EXISTS (
        SELECT 1 FROM "empresa_capacidad" ec
        WHERE ec."empresaId" = c."id"
          AND ec."codigo" IN ('cargos_manuales_contraparte', 'comision_por_evento')
          AND ec."habilitado" = true
      )
ON CONFLICT ("empresaId", "codigo") DO NOTHING;
