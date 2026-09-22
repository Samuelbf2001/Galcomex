/**
 * Verifica, contra la base de datos, que cada condición especial de manejo por
 * cliente que se acordó en las reuniones (10-jun, 1-jul, 31-ago y 10-sep de
 * 2026) esté ACTIVA en la plataforma, y muestra la evidencia real (trámites,
 * borradores, tarifarios) que lo demuestra.
 *
 * En palabras simples: es la lista de "lo que Camila dijo que cada cliente
 * necesita" con un chulo verde o una equis roja según lo que hay hoy en la
 * plataforma, y cómo verlo uno mismo en la pantalla.
 *
 *   npx tsx scripts/verificar-condiciones-clientes.ts            # tabla
 *   npx tsx scripts/verificar-condiciones-clientes.ts --json     # JSON para informes
 *
 * Solo lectura. Corre en local o dentro del contenedor de producción.
 */
import "dotenv/config";

import { prisma } from "../src/lib/db/prisma";
import { capacidadesDeEmpresa } from "../src/lib/capacidades/service";
import { configDe, tiene } from "../src/lib/capacidades/resolver";

type Estado = "OK" | "FALTA" | "PARCIAL" | "N/A";
type Resultado = {
  cliente: string;
  condicion: string;
  fuente: string;
  esperado: string;
  enProd: string;
  estado: Estado;
  evidencia: string;
  comoVerificar: string;
};

const json = process.argv.includes("--json");
const R: Resultado[] = [];
const push = (r: Resultado) => R.push(r);

async function empresa(nit: string) {
  const c = await prisma.cliente.findFirst({ where: { nit: { startsWith: nit } }, select: { id: true, nombre: true, esCliente: true, esProveedor: true, grupoEmpresaId: true } });
  return c;
}

async function facturadosDe(clienteId: string) {
  const b = await prisma.borradorFactura.findMany({
    where: { estado: "FACTURADO", tramite: { clienteId } },
    select: { numFacturaSiigo: true, totalFactura: true, formatoFactura: true, tramite: { select: { consecutivo: true } } },
    orderBy: { numFacturaSiigo: "asc" },
  });
  return b;
}

function cap(caps: Awaited<ReturnType<typeof capacidadesDeEmpresa>>, codigo: string) {
  return tiene(caps, codigo);
}

async function litoplas() {
  const e = await empresa("802009663");
  if (!e) return;
  const caps = await capacidadesDeEmpresa(e.id);
  const fact = await facturadosDe(e.id);
  const ficha = `Empresas → ${e.nombre} → pestaña Funciones`;
  const regla = configDe<{ agencia: string; formatoDoAgencia: string }>(caps, "regla_agencia_fija");
  push({ cliente: "Litoplas", condicion: "Agencia fija Moviaduanas y DO de agencia I########", fuente: "Reunión 10-jun (levantamiento); 10-sep 01:10", esperado: "regla_agencia_fija = MOVIADUANAS", enProd: `${cap(caps, "regla_agencia_fija") ? "encendida" : "apagada"} · ${regla?.agencia ?? "—"} · ${regla?.formatoDoAgencia ?? "—"}`, estado: cap(caps, "regla_agencia_fija") && regla?.agencia === "MOVIADUANAS" ? "OK" : "FALTA", evidencia: `${await prisma.tramiteDO.count({ where: { clienteId: e.id, agenciaAduanas: "MOVIADUANAS" } })} DOs con Moviaduanas; otra agencia → 422`, comoVerificar: `${ficha}; crear un DO de Litoplas con Coldex → la app lo rechaza` });
  push({ cliente: "Litoplas", condicion: "Trabaja con fondo previo (anticipos repartidos por correo)", fuente: "10-sep 23:16 (fondos); Excel SOL DE FONDOS", esperado: "anticipos_cliente encendida", enProd: cap(caps, "anticipos_cliente") ? "encendida" : "apagada", estado: cap(caps, "anticipos_cliente") ? "OK" : "FALTA", evidencia: `${await prisma.anticipo.count({ where: { clienteId: e.id } })} anticipos registrados, repartidos en ${await prisma.aplicacionAnticipo.count({ where: { anticipo: { clienteId: e.id } } })} DOs`, comoVerificar: `${ficha}; Anticipos → filtrar Litoplas` });
  const tar = await prisma.tarifario.findMany({ where: { empresaId: e.id, estado: "VIGENTE" }, select: { alcance: true, nombre: true } });
  push({ cliente: "Litoplas", condicion: "Tarifario propio (importaciones, clasificación, exportaciones)", fuente: "10-sep 14:06; propuesta PDF 2026", esperado: "tarifario_propio + 3 tarifarios VIGENTE", enProd: `${cap(caps, "tarifario_propio") ? "encendida" : "apagada"} · ${tar.map((t) => t.alcance).join(", ")}`, estado: cap(caps, "tarifario_propio") && tar.length >= 3 ? "OK" : "PARCIAL", evidencia: "v1 no cuadra con las facturas reales (L1–L7): papelería y docs de despacho nunca se cobran, documentación 10k/documento", comoVerificar: `${ficha} → sección Tarifario; DO.BAQ26-0255 automático 858.133 vs real 823.288` });
  const clas = await prisma.tramiteDO.count({ where: { clienteId: e.id, tipoTramiteCodigo: "CLASIFICACION" } });
  push({ cliente: "Litoplas", condicion: "Clasificación arancelaria como trámite aparte (CLAS26-…)", fuente: "10-sep 08:37–13:49", esperado: "clasificacion_arancelaria + tipo CLASIFICACION", enProd: `${cap(caps, "clasificacion_arancelaria") ? "encendida" : "apagada"} · ${clas} trámites CLAS`, estado: cap(caps, "clasificacion_arancelaria") && clas > 0 ? "OK" : "FALTA", evidencia: fact.filter((f) => f.tramite.consecutivo.startsWith("CLAS")).map((f) => `${f.tramite.consecutivo} → ${f.numFacturaSiigo}`).join("; ") || "sin facturados", comoVerificar: "Trámites → Nuevo → tipo Clasificación (solo aparece para Litoplas)" });
  const otro = await prisma.tramiteDO.findMany({ where: { clienteId: e.id, tipoTramiteCodigo: "OTRO" }, select: { consecutivo: true, estado: true } });
  push({ cliente: "Litoplas", condicion: "Plan Vallejo y servicios sueltos como tipo OTRO (OTR26-…)", fuente: "10-sep 15:27–19:15", esperado: "tipo OTRO con consecutivo propio", enProd: otro.map((o) => `${o.consecutivo} ${o.estado}`).join(", ") || "ninguno", estado: otro.length ? "OK" : "FALTA", evidencia: fact.filter((f) => f.tramite.consecutivo.startsWith("OTR")).map((f) => `${f.tramite.consecutivo} → ${f.numFacturaSiigo}`).join("; "), comoVerificar: "Trámites → Nuevo → tipo Otros servicios; Cartera → línea Otros" });
  push({ cliente: "Litoplas", condicion: "BL/guía + factura comercial obligatorios al abrir el DO", fuente: "Reunión 1-jul (para todos); 24-jun #6", esperado: "docs_bl_factura_obligatorios", enProd: cap(caps, "docs_bl_factura_obligatorios") ? "encendida" : "apagada", estado: cap(caps, "docs_bl_factura_obligatorios") ? "PARCIAL" : "FALTA", evidencia: "La función está encendida pero la API aún no la exige al crear (hallazgo §9 del análisis Litoplas)", comoVerificar: `${ficha}; crear DO sin BL → hoy pasa` });
  const ev = await prisma.tramiteEvento.count({ where: { tramite: { clienteId: e.id } } });
  push({ cliente: "Litoplas", condicion: "Eventos facturables (revisión 180k, registro por unidad, entrega directa)", fuente: "10-sep; 18-sep registro por unidad", esperado: "eventos_facturables", enProd: `${cap(caps, "eventos_facturables") ? "encendida" : "apagada"} · ${ev} eventos marcados`, estado: cap(caps, "eventos_facturables") ? "OK" : "FALTA", evidencia: "DO.BAQ26-0226 registro 433.000 (BAQ-18700), DO.BAQ26-0238 revisión 180.000 (BAQ-18742), DO.BAQ26-0010 entrega directa 169.000 (BAQ-18259)", comoVerificar: "DO → Resumen → Base de cálculo y eventos" });
  push({ cliente: "Litoplas", condicion: "Factura por conceptos con IVA por ítem, ReteIVA 15 %, 'NO PRACTICAR RETEFUENTE NI RETEICA'", fuente: "31-ago (tarifario); 174 facturas Siigo", esperado: "factura_conceptos_iva", enProd: `${cap(caps, "factura_conceptos_iva") ? "encendida" : "apagada"} · ${fact.filter((f) => f.formatoFactura === "CONCEPTOS_IVA").length} facturadas con ese formato`, estado: cap(caps, "factura_conceptos_iva") ? "OK" : "FALTA", evidencia: fact.map((f) => f.numFacturaSiigo).join(", "), comoVerificar: "Facturación → borrador de Litoplas → líneas con IVA por ítem y ReteIVA" });
}

async function polyrec() {
  const zf = await empresa("901215123");
  const sas = await empresa("900660546");
  if (!zf || !sas) return;
  const capsZf = await capacidadesDeEmpresa(zf.id);
  const capsSas = await capacidadesDeEmpresa(sas.id);
  const grupo = zf.grupoEmpresaId && zf.grupoEmpresaId === sas.grupoEmpresaId ? await prisma.grupoEmpresa.findUnique({ where: { id: zf.grupoEmpresaId }, select: { nombre: true } }) : null;
  push({ cliente: "Polyrec (SAS + ZF)", condicion: "Misma casa: grupo económico Polyrec", fuente: "10-sep 89:02 ('es la misma empresa, pero tienen dos')", esperado: "GrupoEmpresa con las dos", enProd: grupo?.nombre ?? "sin grupo común", estado: grupo ? "OK" : "FALTA", evidencia: "Cartera y funciones se pueden resolver por grupo", comoVerificar: "Empresas → ficha → Grupo" });
  const item = await prisma.tarifaItem.findFirst({ where: { tarifario: { empresaId: zf.id, estado: "VIGENTE" }, tipoCalculo: "POR_TRAMO" }, select: { concepto: true, tramos: true } });
  const fzf = await facturadosDe(zf.id);
  push({ cliente: "Polyrec ZF", condicion: "Traslado ZF por tramos: 1 contenedor 300.000, 2 o más 250.000 c/u", fuente: "10-sep 01:23:31", esperado: "tarifario_propio + ítem POR_TRAMO", enProd: `${cap(capsZf, "tarifario_propio") ? "encendida" : "apagada"} · ${item ? `${item.concepto} ${JSON.stringify(item.tramos)}` : "sin ítem POR_TRAMO"}`, estado: cap(capsZf, "tarifario_propio") && item ? "OK" : "FALTA", evidencia: `DO.BAQ26-0164 (2×40) automático = 844.551 = real BAQ-18603; cumple en 36/38 facturas 2026. Hueco: carga suelta da 0 (real 300.000). Facturados: ${fzf.map((f) => f.numFacturaSiigo).join(", ")}`, comoVerificar: "DO de Polyrec ZF → base de cálculo 2 contenedores → Generar borrador → 500.000" });
  push({ cliente: "Polyrec ZF", condicion: "Número de contenedores obligatorio al crear el DO (viene del BL)", fuente: "10-sep 88:37–89:27", esperado: "contenedores_obligatorio", enProd: cap(capsZf, "contenedores_obligatorio") ? "encendida" : "apagada", estado: cap(capsZf, "contenedores_obligatorio") ? "OK" : "FALTA", evidencia: "Sin ella el tarifario por tramos devuelve 'pendiente'", comoVerificar: "Empresas → Polyrec ZF → Funciones" });
  push({ cliente: "Polyrec ZF", condicion: "Paga a crédito: sin anticipos (73/73 facturas 2026 sin fondo)", fuente: "Siigo 2026 + simulación 21-sep", esperado: "anticipos_cliente apagada", enProd: cap(capsZf, "anticipos_cliente") ? "encendida (por defecto)" : "apagada", estado: cap(capsZf, "anticipos_cliente") ? "FALTA" : "OK", evidencia: "La regla 'sin anticipo no hay pagos' bloqueó el pago del vacío SPRB en DO.BAQ26-0164", comoVerificar: "Empresas → Polyrec ZF → Funciones → Anticipos" });
  const fsas = await facturadosDe(sas.id);
  push({ cliente: "Polyrec SAS", condicion: "Factura se revisa contra la orden de compra", fuente: "1-jul (Polired/Litoplas contra OC); 10-sep pto 3", esperado: "orden_compra_en_revision", enProd: cap(capsSas, "orden_compra_en_revision") ? "encendida" : "apagada", estado: cap(capsSas, "orden_compra_en_revision") ? "OK" : "FALTA", evidencia: "La OC real (OC10944, OC11374) está en los DOs de Polyrec ZF nacionalización; en Polyrec SAS las OC son del cliente a EREMA (EUR)", comoVerificar: "DO → Orden de compra N°/valor → revisor muestra franja verde/ámbar" });
  push({ cliente: "Polyrec SAS", condicion: "Tarifario propio (Camila lo debía mandar)", fuente: "10-sep 14:06", esperado: "tarifario VIGENTE", enProd: `${cap(capsSas, "tarifario_propio") ? "función encendida" : "apagada"} · ${await prisma.tarifario.count({ where: { empresaId: sas.id, estado: "VIGENTE" } })} tarifarios`, estado: (await prisma.tarifario.count({ where: { empresaId: sas.id, estado: "VIGENTE" } })) ? "OK" : "PARCIAL", evidencia: `Combo repetido en Siigo: 312.000 + 180.000/186.000 + 250.000 transporte + docs 10k/doc. Facturados: ${fsas.map((f) => f.numFacturaSiigo).join(", ")}`, comoVerificar: "Empresas → Polyrec SAS → Tarifario (vacío)" });
  push({ cliente: "Polyrec SAS", condicion: "Sí usa fondos (anticipo parcial por DO)", fuente: "Cartera propia (análisis 27-ago); carpetas SOPORTE FONDO", esperado: "anticipos_cliente encendida", enProd: cap(capsSas, "anticipos_cliente") ? "encendida" : "apagada", estado: cap(capsSas, "anticipos_cliente") ? "OK" : "FALTA", evidencia: `${await prisma.anticipo.count({ where: { clienteId: sas.id } })} anticipos (1.057.000 y 1.098.000) aplicados en la simulación`, comoVerificar: "Anticipos → Polyrec SAS" });
}

async function cw() {
  const e = await empresa("900775062");
  if (!e) return;
  const caps = await capacidadesDeEmpresa(e.id);
  const items = await prisma.tarifaItem.findMany({ where: { tarifario: { empresaId: e.id, estado: "VIGENTE" } }, select: { concepto: true, tipoCalculo: true, disparador: true, valor: true } });
  const pct = items.find((i) => i.tipoCalculo === "PORCENTAJE_MIN");
  const f = await facturadosDe(e.id);
  push({ cliente: "CW ASIA", condicion: "Servicio logístico = 0,37 % del CIF con mínimos (suelta 370k, 20′ 498k, 40′ 554k)", fuente: "31-ago 74:30–75:20; propuesta PDF", esperado: "base_cif + tarifario_propio + ítem PORCENTAJE_MIN", enProd: `${cap(caps, "base_cif") ? "CIF sí" : "CIF no"} · ${cap(caps, "tarifario_propio") ? "tarifario sí" : "tarifario no"} · ${pct ? pct.concepto : "sin ítem %"}`, estado: cap(caps, "base_cif") && cap(caps, "tarifario_propio") && pct ? "OK" : "FALTA", evidencia: `DO.CTG26-0021 parcial: tarifario = 615.595 = real BAQ-18437/18627 (mínimo suelta 370.000; el 0,37 % nunca lo superó). Facturados: ${f.map((x) => x.numFacturaSiigo).join(", ")}`, comoVerificar: "DO de CW → base de cálculo CIF + tipo de carga → Generar borrador" });
  push({ cliente: "CW ASIA", condicion: "Eventos: despacho parcial 50k, ingreso ZF por contenedor, registro/modificación", fuente: "31-ago 81:07–82:22", esperado: "eventos_facturables + ítems EVENTO", enProd: `${cap(caps, "eventos_facturables") ? "encendida" : "apagada"} · ${items.filter((i) => i.disparador === "EVENTO").map((i) => i.concepto).join(", ")}`, estado: cap(caps, "eventos_facturables") && items.some((i) => i.disparador === "EVENTO") ? "OK" : "FALTA", evidencia: "DO.CTG26-0021 DESPACHO_PARCIAL×2; DO.CTG26-0198 INGRESO_ZF 166.000 = real BAQ-18794", comoVerificar: "DO → Resumen → eventos → checklist gana documentos" });
  push({ cliente: "CW ASIA", condicion: "Sistematización 30.000 (Litoplas 20.000)", fuente: "31-ago 81:32", esperado: "ítem SISTEMATIZACION 30.000", enProd: items.find((i) => /SISTEMATIZACION/.test(i.concepto))?.valor?.toString() ?? "—", estado: items.find((i) => /SISTEMATIZACION/.test(i.concepto))?.valor === 30000n ? "OK" : "FALTA", evidencia: "Todas las facturas 2026 de CW traen 30.000", comoVerificar: "Empresas → CW ASIA → Tarifario" });
  push({ cliente: "CW ASIA", condicion: "Defectos del tarifario cargado", fuente: "Simulación 21-sep", esperado: "PAGO_REGISTRO como EVENTO; GASTOS_TRAMITE confirmar", enProd: items.filter((i) => /PAGO_REGISTRO|GASTOS_TRAMITE/.test(i.concepto)).map((i) => `${i.concepto} ${i.disparador}`).join(", "), estado: items.some((i) => i.concepto === "PAGO_REGISTRO" && i.disparador === "SIEMPRE") ? "PARCIAL" : "OK", evidencia: "PAGO_REGISTRO (espejo de costo) con disparador SIEMPRE tumba el borrador automático si el DO no tiene registro; GASTOS_TRAMITE 100.000/contenedor no aparece en ninguna factura 2026", comoVerificar: "Generar borrador en un DO de CW sin registro → error TarifaIncompleta" });
}

async function sesderma() {
  const e = await empresa("802019447");
  if (!e) return;
  const caps = await capacidadesDeEmpresa(e.id);
  const f = await facturadosDe(e.id);
  push({ cliente: "Sesderma", condicion: "Cliente de más plata; factura con muchos terceros (puerto, VUCE, INVIMA, transporte) y ReteIVA", fuente: "10-sep 02:24; 31-ago 62:21", esperado: "factura_conceptos_iva", enProd: cap(caps, "factura_conceptos_iva") ? "encendida" : "apagada", estado: cap(caps, "factura_conceptos_iva") ? "OK" : "FALTA", evidencia: `BAQ-18283 8.096.854 (5 terceros, 4x1000 22.392) reproducida al peso. Facturados: ${f.map((x) => x.numFacturaSiigo).join(", ")}`, comoVerificar: "Facturación → DO.CTG26-0009" });
  push({ cliente: "Sesderma", condicion: "Tarifario propio (asesoría = 0,2 % del CIF − 145.000, mín 305.000 — fórmula descubierta)", fuente: "10-sep 14:06; simulación 21-sep", esperado: "tarifario VIGENTE con PORCENTAJE_MIN", enProd: `${cap(caps, "tarifario_propio") ? "función encendida" : "apagada"} · ${await prisma.tarifario.count({ where: { empresaId: e.id, estado: "VIGENTE" } })} tarifarios`, estado: (await prisma.tarifario.count({ where: { empresaId: e.id, estado: "VIGENTE" } })) ? "OK" : "PARCIAL", evidencia: "Fórmula exacta en 6 DOs de Cartagena (1.233.107 = 0,2 %·689.053.350 − 145.000). Falta que Camila la confirme para cargarla", comoVerificar: "Empresas → Sesderma → Tarifario (vacío)" });
  const asc = await prisma.cliente.findFirst({ where: { nombre: { contains: "ASCINTER", mode: "insensitive" } }, select: { esProveedor: true, esCliente: true, nit: true } });
  push({ cliente: "Sesderma", condicion: "Ascinter le factura la asesoría a Galcomex (proveedor dual)", fuente: "31-ago 62:21–65:59", esperado: "Ascinter esProveedor", enProd: asc ? `esProveedor ${asc.esProveedor} · esCliente ${asc.esCliente} · NIT ${asc.nit}` : "no existe", estado: asc?.esProveedor ? "PARCIAL" : "FALTA", evidencia: "FEVA 1229/1308/1314/1503 de Ascinter (165.000 + IVA por DO) no se repercuten; NIT sigue PENDIENTE", comoVerificar: "Empresas → Ascinter → roles" });
  push({ cliente: "Sesderma", condicion: "Paga a crédito (anticipo 0, saldo a cargo)", fuente: "Siigo 2026: 25/25 sin anticipo", esperado: "anticipos_cliente apagada", enProd: cap(caps, "anticipos_cliente") ? "encendida (por defecto)" : "apagada", estado: cap(caps, "anticipos_cliente") ? "FALTA" : "OK", evidencia: "Pagos a SPRC/VUCE bloqueados por la regla en la simulación", comoVerificar: "Empresas → Sesderma → Funciones → Anticipos" });
}

async function coldex() {
  const e = await empresa("800193576");
  if (!e) return;
  const caps = await capacidadesDeEmpresa(e.id);
  const f = await facturadosDe(e.id);
  push({ cliente: "Coldex", condicion: "Es cliente Y proveedor (agencia de aduanas de todos menos Litoplas)", fuente: "31-ago 67:30; 10-jun", esperado: "esCliente + esProveedor", enProd: `esCliente ${e.esCliente} · esProveedor ${e.esProveedor} · ${await prisma.tramiteDO.count({ where: { agenciaAduanas: "COLDEX" } })} DOs con agencia Coldex`, estado: e.esCliente && e.esProveedor ? "OK" : "FALTA", evidencia: `39 DOs históricos como cliente intermediario; facturados: ${f.map((x) => x.numFacturaSiigo).join(", ")}`, comoVerificar: "Empresas → Coldex → roles; Trámites → filtro agencia" });
  const mov = await prisma.movimientoCuenta.aggregate({ _count: true, _sum: { valor: true } });
  push({ cliente: "Coldex", condicion: "Cargos manuales en cuenta corriente (mensualidad ~4 M, quincenas) que se cruzan", fuente: "31-ago 68:45–72:50", esperado: "cargos_manuales_contraparte + cruce de saldos", enProd: `${cap(caps, "cargos_manuales_contraparte") ? "encendida" : "apagada"} · ${mov._count} movimientos (${mov._sum.valor?.toString() ?? 0})`, estado: cap(caps, "cargos_manuales_contraparte") ? "OK" : "FALTA", evidencia: "Cargo de ejemplo 4.000.000 (fase 0, 15-sep); botón Cruzar saldos", comoVerificar: "Empresas → Coldex → Cuenta corriente → Cruzar saldos" });
  push({ cliente: "Coldex", condicion: "Sin anticipos: 'las facturas siempre están a cargo'", fuente: "31-ago 70:50", esperado: "anticipos_cliente apagada", enProd: cap(caps, "anticipos_cliente") ? "encendida" : "apagada", estado: cap(caps, "anticipos_cliente") ? "FALTA" : "OK", evidencia: "5 facturas simuladas, todas saldo a cargo por el total", comoVerificar: "Empresas → Coldex → Funciones" });
  push({ cliente: "Coldex", condicion: "Solo se cobra un servicio (145.000) + revisión/fiscalización 200k/400k + sellos 10k", fuente: "31-ago 71:15; Siigo 52 facturas", esperado: "líneas manuales (sin tarifario)", enProd: `${await prisma.tarifario.count({ where: { empresaId: e.id, estado: "VIGENTE" } })} tarifarios`, estado: "PARCIAL", evidencia: "BAQ-18438 / 18662 / 18668 / 18698 / 18736 reproducidas al peso; DO multi-factura (0131) funciona", comoVerificar: "Facturación → DO.BAQ26-0131 → 3 borradores FACTURADO" });
}

async function otros() {
  const lt = await prisma.cliente.findFirst({ where: { nombre: { contains: "LTRANS", mode: "insensitive" } }, select: { id: true, esCliente: true, esProveedor: true } });
  if (lt) {
    const caps = await capacidadesDeEmpresa(lt.id);
    const cfg = configDe<{ valor: string; unidad: string }>(caps, "comision_por_evento");
    push({ cliente: "Ltrans", condicion: "Comisión por contenedor a favor de Galcomex (cliente que paga comisión)", fuente: "31-ago 84:02–90:17", esperado: "comision_por_evento con valor + contenedores_obligatorio", enProd: `${cap(caps, "comision_por_evento") ? "encendida" : "apagada"} valor ${cfg?.valor ?? "—"}/${cfg?.unidad ?? "—"} · contenedores ${cap(caps, "contenedores_obligatorio") ? "sí" : "no"}`, estado: cap(caps, "comision_por_evento") && cfg?.valor && cfg.valor !== "0" ? "OK" : "PARCIAL", evidencia: "Valor de la comisión sigue en 0: Camila no lo ha dado; el consumidor de la capacidad está pendiente", comoVerificar: "Empresas → Ltrans → Funciones" });
  }
  for (const [nombre, nit] of [["Express Logística", "802011826"], ["Almacarga", "800154017"]] as const) {
    const p = await empresa(nit);
    push({ cliente: nombre, condicion: "Proveedor de Litoplas (almacenaje / transporte), factura por DO", fuente: "31-ago 83:37", esperado: "esProveedor, ficha de pago", enProd: p ? `esProveedor ${p.esProveedor} · esCliente ${p.esCliente}` : "no existe", estado: p?.esProveedor ? "OK" : "FALTA", evidencia: `${await prisma.facturaProveedor.count({ where: { proveedorNit: { startsWith: nit } } })} facturas de proveedor registradas`, comoVerificar: "Empresas → ficha → rol proveedor; Pagos → ficha de pago" });
  }
  const ox = await empresa("900597449");
  push({ cliente: "OX", condicion: "Empresa liquidada: no se configura, queda solo por cartera vieja", fuente: "10-sep 00:42–01:37", esperado: "sin tarifario ni funciones", enProd: ox ? `${await prisma.tarifario.count({ where: { empresaId: ox.id } })} tarifarios · ${await prisma.empresaCapacidad.count({ where: { empresaId: ox.id } })} funciones` : "no existe", estado: "OK", evidencia: "—", comoVerificar: "Empresas → OX" });
  const p4 = await prisma.parametro.findFirst({ where: { clave: "SIIGO_PRODUCTO_4X1000_ID" }, select: { valor: true } });
  push({ cliente: "Todos", condicion: "4x1000 = 0,4 % de terceros, tercero Banco de Occidente, producto Siigo 13", fuente: "24-jun #10; validado 157/157 facturas", esperado: "parámetro SIIGO_PRODUCTO_4X1000_ID", enProd: p4 ? `producto ${p4.valor}` : "sin parámetro", estado: p4 ? "OK" : "FALTA", evidencia: "21 simulaciones: 4x1000 exacto en todas; sin terceros no hay línea", comoVerificar: "Configuración → Parámetros" });
  const enums = await prisma.$queryRaw<{ typname: string; labels: string }[]>`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname in ('AgenciaAduanas','Ciudad') group by 1`;
  const ag = enums.find((x) => x.typname === "AgenciaAduanas")?.labels ?? "";
  const ci = enums.find((x) => x.typname === "Ciudad")?.labels ?? "";
  push({ cliente: "Todos", condicion: "Agencia Cortes (segunda agencia de Polyrec)", fuente: "10-sep 84:30", esperado: "enum AgenciaAduanas con CORTES", enProd: ag, estado: ag.includes("CORTES") ? "OK" : "FALTA", evidencia: "Ningún DO histórico la usa todavía", comoVerificar: "Trámites → Nuevo → Agencia" });
  push({ cliente: "Sesderma / Polyrec SAS", condicion: "DOs de Bogotá (DO.BGT26-…)", fuente: "Carpetas 2026; cartera propia BGT25-XXXX", esperado: "enum Ciudad con BGT", enProd: ci, estado: ci.includes("BGT") ? "OK" : "FALTA", evidencia: "20 DOs (17 Sesderma + 3 Polyrec SAS) esperan la migración 20260921120000_ciudad_bgt", comoVerificar: "Tras el deploy: importar.ts --fase registrar" });
  const prueba = await prisma.cliente.findMany({ where: { OR: [{ nombre: { contains: "PRUEBA" } }, { nombre: { startsWith: "ZZZ" } }, { nombre: "test" }] }, select: { nombre: true } });
  push({ cliente: "Todos", condicion: "Sin empresas de prueba en producción", fuente: "Higiene", esperado: "0", enProd: prueba.map((p) => p.nombre).join("; ") || "ninguna", estado: prueba.length ? "PARCIAL" : "OK", evidencia: "Quedaron de los ejemplos de configuración (fase 0)", comoVerificar: "Empresas → buscar PRUEBA" });
}

async function main() {
  await litoplas();
  await polyrec();
  await cw();
  await sesderma();
  await coldex();
  await otros();
  if (json) {
    console.log(JSON.stringify(R, null, 1));
    return;
  }
  const icono: Record<Estado, string> = { OK: "✅", FALTA: "❌", PARCIAL: "⚠️", "N/A": "—" };
  for (const r of R) {
    console.log(`${icono[r.estado]} ${r.cliente} — ${r.condicion}`);
    console.log(`     fuente: ${r.fuente} · esperado: ${r.esperado}`);
    console.log(`     en prod: ${r.enProd}`);
    console.log(`     evidencia: ${r.evidencia}`);
    console.log(`     verificar: ${r.comoVerificar}`);
  }
  const n = (e: Estado) => R.filter((r) => r.estado === e).length;
  console.log(`\n${R.length} condiciones · OK ${n("OK")} · parcial ${n("PARCIAL")} · faltan ${n("FALTA")}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
