/**
 * Catálogo de capacidades — Galcomex
 *
 * Fuente de verdad ÚNICA de las funciones que se pueden activar o desactivar
 * por empresa. De aquí salen:
 *   1. el tipo `CodigoCapacidad` (autocompletado + `tsc` protege los typos),
 *   2. las filas de la tabla `capacidad` (seed y migración),
 *   3. el orden y agrupación de los interruptores en la ficha de empresa.
 *
 * REGLA: agregar una capacidad es agregar una entrada aquí + su consumidor.
 * NUNCA ramificar por `TipoCliente`, por NIT ni por nombre de empresa.
 *
 * Ver el plan completo en `.claude/PLAN-CONFIGURABILIDAD.md`.
 */

export type GrupoCapacidad =
  | "Comercial"
  | "Operacion"
  | "Facturacion"
  | "Cartera"
  | "Documentos";

export type AmbitoCapacidad = "EMPRESA" | "GLOBAL";

export interface DefinicionCapacidad {
  codigo: string;
  nombre: string;
  descripcion: string;
  grupo: GrupoCapacidad;
  ambito: AmbitoCapacidad;
  /** Valor cuando la empresa (ni su grupo económico) declara nada. */
  porDefecto: boolean;
  /** Config por defecto; cada consumidor la valida con Zod al leerla. */
  configPorDefecto: Record<string, unknown> | null;
  orden: number;
}

export const CAPACIDADES = [
  {
    codigo: "anticipos_cliente",
    nombre: "Anticipos del cliente",
    descripcion:
      "La empresa fondea sus trámites con anticipos antes de que Galcomex pague a proveedores.",
    grupo: "Cartera",
    ambito: "EMPRESA",
    porDefecto: true,
    configPorDefecto: null,
    orden: 10,
  },
  {
    codigo: "tarifario_propio",
    nombre: "Tarifario propio versionado",
    descripcion:
      "La empresa tiene su propia propuesta comercial con vigencia; las líneas operacionales de la factura se calculan desde ella.",
    grupo: "Comercial",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 20,
  },
  {
    // Decisión D1 de Ernesto (22-sep-2026): encendida por defecto para que toda
    // empresa nueva de Galcomex quede cubierta; la migración 20260923092000 la
    // apaga en las empresas del socio (se facturan por comisión, sin tarifa).
    // Consumidor: guards de `lib/tramites/service.ts` + `lib/tramites/requisitos.ts`.
    codigo: "do_exige_tarifa_vigente",
    nombre: "DO solo con tarifa vigente",
    descripcion:
      "No deja crear un DO si la empresa no tiene una tarifa vigente para esa línea de servicio. Las solicitudes que llegan de afuera sí entran, pero no se pueden abrir hasta que la tarifa esté publicada.",
    grupo: "Comercial",
    ambito: "EMPRESA",
    porDefecto: true,
    configPorDefecto: { tiposTramite: ["IMPORTACION", "CLASIFICACION", "OTRO"] },
    orden: 25,
  },
  {
    codigo: "base_cif",
    nombre: "CIF como base de cálculo",
    descripcion:
      "Se captura el CIF del trámite y habilita tarifas de tipo porcentaje sobre CIF con mínimo por tipo de carga.",
    grupo: "Comercial",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 30,
  },
  {
    codigo: "clasificacion_arancelaria",
    nombre: "Clasificación arancelaria facturada aparte",
    descripcion:
      "Habilita el tipo de trámite de clasificación, con consecutivo propio y facturación separada de los trámites de importación.",
    grupo: "Comercial",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 40,
  },
  {
    codigo: "eventos_facturables",
    nombre: "Eventos facturables en el trámite",
    descripcion:
      "Muestra en el resumen del trámite los eventos que disparan cobro (contenedor abierto, entrega directa, despacho parcial, registro elaborado).",
    grupo: "Operacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 50,
  },
  {
    codigo: "contenedores_obligatorio",
    nombre: "Número de contenedores obligatorio",
    descripcion:
      "Exige capturar el número de contenedores (viene del BL) al crear el trámite. Base de las comisiones por contenedor.",
    grupo: "Operacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 60,
  },
  {
    codigo: "umbral_saldo_tramite",
    nombre: "Umbral de alerta de saldo propio",
    descripcion:
      "Sobrescribe el umbral de alerta de saldo del trámite para esta empresa. Sin activar se usa el parámetro global por tipo de cliente.",
    grupo: "Operacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: { valor: "500000" },
    orden: 70,
  },
  {
    codigo: "cuenta_corriente",
    nombre: "Cuenta corriente cruzada",
    descripcion:
      "Muestra en la ficha un solo saldo con lo que la empresa nos debe como cliente y lo que le debemos como proveedor, y permite cruzarlos sin mover plata (caso Coldex, Ascinter, Eltrans). Para una empresa que solo es cliente repite la cartera: déjala apagada.",
    grupo: "Cartera",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 75,
  },
  {
    codigo: "comision_por_evento",
    nombre: "Comisión a cobrar por contenedor",
    descripcion:
      "La contraparte le paga a Galcomex una comisión por unidad operada (caso Eltrans). Genera saldo a favor en su cuenta corriente.",
    grupo: "Cartera",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: { unidad: "CONTENEDOR", valor: "0" },
    orden: 80,
  },
  {
    // El código NO cambia (compatibilidad de datos: EmpresaCapacidad, AuditLog);
    // solo el nombre/descripción que ve el ADMIN, para que el módulo "Registrar
    // factura" no suene exclusivo de Coldex (pedido de Ernesto, 24-sep-2026).
    codigo: "cargos_manuales_contraparte",
    nombre: "Registrar facturas por fuera de trámites",
    descripcion:
      "Permite registrar en la ficha las facturas que la empresa le cobra a Galcomex y que no pertenecen a ningún trámite (por ejemplo la mensualidad de Coldex). Se suman a lo que le debemos y se pueden cruzar en la cuenta corriente.",
    grupo: "Cartera",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 90,
  },
  {
    codigo: "orden_compra_en_revision",
    nombre: "Orden de compra en la revisión",
    descripcion:
      "La revisión del borrador exige contrastar contra la orden de compra del cliente antes de aprobar.",
    grupo: "Facturacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 100,
  },
  {
    codigo: "factura_conceptos_iva",
    nombre: "Factura con conceptos e IVA por ítem",
    descripcion:
      "La factura de venta lleva cada concepto del tarifario como ítem con su IVA, los pagos a terceros desde las facturas de proveedor, el 4x1000 sobre esos terceros y la ReteIVA del cliente. Es el formato de las facturas de Galcomex; sin activarla se usa el formato de comisión de Lucho.",
    grupo: "Facturacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: { reteIvaPorcentaje: 15, observacionNoRetenciones: true },
    orden: 105,
  },
  {
    codigo: "factura_multi_do",
    nombre: "Una factura para varios DO",
    descripcion:
      "Permite agrupar varios trámites en una sola factura de venta (caso BAQ-18701, que cubre tres DO).",
    grupo: "Facturacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: null,
    orden: 110,
  },
  {
    codigo: "regla_agencia_fija",
    nombre: "Agencia de aduanas obligatoria",
    descripcion:
      "La empresa solo puede operar con una agencia concreta y su DO de agencia debe cumplir un formato. Reemplaza la regla que estaba escrita contra el nombre de Litoplas.",
    grupo: "Operacion",
    ambito: "EMPRESA",
    porDefecto: false,
    configPorDefecto: { agencia: "MOVIADUANAS", formatoDoAgencia: "^I\\d{8}$" },
    orden: 65,
  },
  {
    // Decisión D2 de Ernesto (22-sep-2026): encendida por defecto para todas
    // las empresas; cada una puede apagarla o cambiar a qué tipos aplica.
    // Consumidor: `transitionTramite` (APERTURA → EN_TRAMITE) + formulario de DO.
    codigo: "docs_bl_factura_obligatorios",
    nombre: "BL y factura comercial obligatorios",
    descripcion:
      "Al crear el DO se piden el BL (o guía) y la factura comercial, y el DO no pasa de Apertura a En trámite si no están adjuntos. Aplica solo a los tipos de trámite marcados.",
    grupo: "Documentos",
    ambito: "EMPRESA",
    porDefecto: true,
    configPorDefecto: { tiposTramite: ["IMPORTACION"] },
    orden: 120,
  },
] as const satisfies readonly DefinicionCapacidad[];

export type CodigoCapacidad = (typeof CAPACIDADES)[number]["codigo"];

export const CODIGOS_CAPACIDAD: readonly CodigoCapacidad[] = CAPACIDADES.map(
  (capacidad) => capacidad.codigo,
);

export function esCodigoCapacidad(valor: string): valor is CodigoCapacidad {
  return (CODIGOS_CAPACIDAD as readonly string[]).includes(valor);
}

export function definicionDe(codigo: CodigoCapacidad): DefinicionCapacidad {
  const definicion = CAPACIDADES.find((c) => c.codigo === codigo);

  if (!definicion) {
    // Inalcanzable: `codigo` está tipado contra el propio catálogo.
    throw new Error(`Capacidad desconocida: ${codigo}`);
  }

  return definicion;
}
