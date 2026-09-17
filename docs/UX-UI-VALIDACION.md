# Mejoras de experiencia de Galcomex

## Dirección

Se conserva Next.js 16.2.9, la tipografía existente y la paleta azul/cian. La navegación se organiza por trabajo: operación, facturación y cobros, administración. El patrón distintivo es editar en el contexto de la información y mostrar acciones cuando hay algo que guardar o recuperar. Se reutilizaron componentes propios; no se usaron referencias visuales externas.

## Cambios y evidencia

| Necesidad | Implementación |
| --- | --- |
| Carga, error y vacío comprensibles | `module-state.tsx` distingue estados con texto, icono, semántica accesible y reintento; skeletons adaptables; catálogos de creación, facturación e importación distinguen error de lista vacía. |
| Menos pasos para editar | `inline-tramite-field.tsx`, `contacto-editor.tsx` y `editor-lineas.tsx` permiten editar directamente. Fechas y contactos ofrecen Guardar al cambiar; líneas guardan al salir o con Enter, con error y reintento por campo. Configuración permite entrar desde la celda y usar Enter/Escape. |
| Conservar el trabajo | Una creación de línea fallida no limpia el formulario. Campos, contactos y comentarios conservan borradores ante errores y refrescos. Las recargas de fichas conservan contenido y pestañas. |
| Acciones sin duplicación | Una acción de crear empresa en vacío; un editor de contactos; cambio de estado retirado del resumen duplicado; acciones superiores del trámite se ocultan cuando la pestaña ya las ofrece. Adjuntos duplicados retirados del alta de DO. |
| Flujo entendible | Grupos de navegación, nombre de módulo en cabecera, nombres explícitos de pestañas, búsqueda de empresas y vacíos filtrados recuperables. Importación presenta selección, revisión y confirmación. |
| Móvil y teclado | Controles de 44 px en móvil, tablas con desplazamiento interno, foco visible, movimiento reducido, salto a contenido, menú con Escape y foco atrapado/restaurado, revisión de factura apilada en móvil. |
| Errores de revisión visibles | `revisor-borrador.tsx` informa fallos en soportes, formas de pago, cruces y validaciones. Usa el contrato agrupado de documentos y descarta resultados anteriores de cruces cuando su recarga falla. |

Tres subagentes leyeron y modificaron las partes grandes, y uno revisó independientemente los editores, permisos y duplicaciones. No se modificaron servicios de negocio, endpoints ni reglas financieras.

## Archivos principales

- `src/components/layout/{app-shell,sidebar,module-state,workspace-fallback,logout-button}.tsx`
- `src/components/ui/{skeleton,modal-shell}.tsx` y `src/app/globals.css`
- `src/components/tramites/{tramites-workspace,tramite-detalle,inline-tramite-field}.tsx`
- `src/components/clientes/{clientes-workspace,cliente-detalle,contacto-editor}.tsx`
- `src/components/facturacion/{editor-lineas,revisor-borrador}.tsx`
- `src/components/ingresos/ingresos-workspace.tsx`
- `src/components/dashboard/dashboard-workspace.tsx`
- `src/components/configuracion/{parametros-config,matrices-config,beneficiarios-config,usuarios-config}.tsx`
- `src/components/documentos/{lista-documentos,subida-documentos}.tsx`
- `src/components/importar/importar-excel-workspace.tsx`
- `src/app/auth/login/login-form.tsx`, `src/app/solicitar-do/solicitud-form.tsx`, `src/app/(dashboard)/error.tsx`

## Verificación reproducible

Resultado final: lint sin errores (13 advertencias preexistentes); TypeScript y build de producción correctos; 13/13 pruebas nuevas de edición correctas; siete comprobaciones de navegador correctas. Suite completa: 50 archivos correctos, 404 pruebas correctas y 169 omitidas; un archivo de pruebas falla por el Excel de referencia ausente descrito abajo. No se afirma que la suite completa esté verde.

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`
- `npm test`
- `node scripts/verify-ux.mjs`

Las pruebas nuevas de React verifican retención de borradores, reintentos, no guardar sin cambios, deshacer, refrescos y bloqueo de envíos duplicados. El script de navegador usa componentes reales con datos sintéticos y API interceptada: comprueba carga/error/vacío, edición fallida y reintento, filtros, ausencia de acciones duplicadas, foco del menú y ancho de 390 × 844. Guarda capturas en `coverage/ux-browser/` para móvil y escritorio.

La validación visual no es una prueba E2E contra producción. La base PostgreSQL local no está disponible; las pruebas que dependen de ella se omiten. La suite de importación necesita `documentos referencia /GRUPO E PAPIS 2026.xlsm`, que ya estaba eliminado al iniciar este trabajo. No se restauró ni se ocultó su fallo. Los registros completos de las ejecuciones finales están en `coverage/ux-{lint,build,tests}.log`.
