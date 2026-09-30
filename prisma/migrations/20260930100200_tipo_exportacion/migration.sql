-- Tipo Exportación con serie propia DO.EXP26 desde la 0013 (decisión de Ernesto, 30-sep-2026).
--
-- Las 10 exportaciones históricas siguen como OTR26 (no se renumeran); el piso
-- de 12 hace que la siguiente sea DO.EXP26-0013. Flujo corto: se abre sin
-- pagos a proveedores y se manda a facturar directo, con la tarifa de
-- exportación de la empresa (tarifa general, sin servicio) o con el valor a mano.

INSERT INTO "concepto_venta" ("id","codigo","nombre","aplicaIva","orden","activo","notas","updatedAt") VALUES
  ('concepto-exportacion','EXPORTACION','Servicio logístico de exportación',true,0,true,'Creado por la migración 20260930100200. Producto Siigo 007: lo asigna el paso de datos.',CURRENT_TIMESTAMP)
ON CONFLICT ("codigo") DO NOTHING;

INSERT INTO "tipo_tramite" (
  "codigo","nombre","descripcion","prefijoConsecutivo","secuenciaPor","incluyeCiudadEnConsecutivo",
  "lineaServicio","facturacionSeparada","capacidadRequerida","requiereAgenciaAduanas","agenciaAduanasPorDefecto",
  "requiereEta","usaChecklist","usaCamposDo","etiquetaReferenciaExterna","camposBaseCalculo","usaEventos",
  "fechasClave","flujoCorto","ciudadesContadorComun","orden","activo","updatedAt"
) VALUES (
  'EXPORTACION','Exportación',
  'Exportaciones de todos los clientes. Serie propia sin ciudad (DO.EXP26-0001). Se abre sin pagos a proveedores y se manda a facturar directo, con la tarifa de exportación de la empresa o con el valor escrito a mano.',
  'DO.EXP','ANIO',false,'EXPORTACION',true,NULL,false,NULL,false,false,false,
  'Referencia de la exportación (N° del cliente / SAE)',ARRAY[]::TEXT[],false,
  ARRAY['fechaEnviadoAFacturar']::TEXT[],true,ARRAY[]::"Ciudad"[],15,true,CURRENT_TIMESTAMP
) ON CONFLICT ("codigo") DO NOTHING;

INSERT INTO "servicio_tramite" ("id","tipoTramiteCodigo","conceptoCodigo","nombre","tarifaGeneral","documentosNoAplican","orden","updatedAt") VALUES
  ('servicio-exportacion-general','EXPORTACION','EXPORTACION','Exportación',true,ARRAY[]::"CategoriaDocumento"[],10,CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "consecutivo_piso" ("id","clave","tipoTramiteCodigo","anio","ultimoNumero","motivo") VALUES
  ('piso-exportacion-2026','EXPORTACION:2026','EXPORTACION',2026,12,
   'DO.EXP26-0001 a 0012 existen fuera del tipo Exportación (10 cargadas como OTR26 el 27-sep; 0010 y 0011 sin cargar). La siguiente es la 0013. Decisión de Ernesto 30-sep-2026: no se renumera el histórico.')
ON CONFLICT ("id") DO NOTHING;
