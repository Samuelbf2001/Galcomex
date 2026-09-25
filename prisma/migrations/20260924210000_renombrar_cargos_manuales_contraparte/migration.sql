-- Ernesto pidió (24-sep-2026) que el módulo "Registrar factura de <empresa>"
-- deje de sonar exclusivo de Coldex: el botón ahora dice "Registrar factura" y
-- queda disponible para cualquier empresa desde la pestaña Funciones (apagado
-- por defecto). El código de la capacidad (`cargos_manuales_contraparte`) NO
-- cambia, por compatibilidad con los datos ya guardados (EmpresaCapacidad,
-- AuditLog); solo cambian los textos que ve el ADMIN. Espejo de
-- src/lib/capacidades/catalogo.ts: el seed vuelve a sincronizar esto en cada
-- arranque; esta migración solo adelanta el cambio para el próximo despliegue.
--
-- Solo datos: no cambia el esquema ni el valor de `porDefecto` (sigue false).

UPDATE "capacidad"
SET
    "nombre" = 'Registrar facturas por fuera de trámites',
    "descripcion" = 'Permite registrar en la ficha las facturas que la empresa le cobra a Galcomex y que no pertenecen a ningún trámite (por ejemplo la mensualidad de Coldex). Se suman a lo que le debemos y se pueden cruzar en la cuenta corriente.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "codigo" = 'cargos_manuales_contraparte';
