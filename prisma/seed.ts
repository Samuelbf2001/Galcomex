import "dotenv/config";
import { CanalPago, Prisma, SecuenciaTramite, TipoRecaudo, Rol } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { CAPACIDADES } from "../src/lib/capacidades/catalogo";
import { sembrarConceptosVenta } from "../src/lib/catalogos/seed-conceptos";
import { prisma } from "../src/lib/db/prisma";

async function main() {
  // Matriz de recaudo (tipos de recaudo del cliente → Galcomex)
  const matrizRecaudo: { tipoRecaudo: TipoRecaudo; grupo: string; descripcion: string; costoFijo: bigint }[] = [
    { tipoRecaudo: "BANCOLOMBIA",  grupo: "DIGITAL", descripcion: "Bancolombia (digital)",      costoFijo: 1950n  },
    { tipoRecaudo: "OTROS_BANCOS", grupo: "DIGITAL", descripcion: "Otros Bancos (digital)",     costoFijo: 2200n  },
    { tipoRecaudo: "SUCURSAL",     grupo: "FISICO",  descripcion: "Sucursal Bancolombia",        costoFijo: 11290n },
    { tipoRecaudo: "CORRESPONSAL", grupo: "FISICO",  descripcion: "Corresponsal Bancolombia",    costoFijo: 6190n  },
    { tipoRecaudo: "CAJERO",       grupo: "FISICO",  descripcion: "Cajero Bancolombia",          costoFijo: 5200n  },
  ];

  for (const item of matrizRecaudo) {
    await prisma.matrizRecaudo.upsert({
      where: { tipoRecaudo: item.tipoRecaudo },
      // El seed corre en cada arranque del contenedor: no pisar el costo si un
      // ADMIN lo cambió desde Configuración; solo refresca textos.
      update: { descripcion: item.descripcion, grupo: item.grupo },
      create: item,
    });
  }

  // Matriz de pago (canales de pago Galcomex → proveedor)
  const matrizPago: { canalPago: CanalPago; descripcion: string; costoFijo: bigint }[] = [
    { canalPago: "TRANSF_BANCOLOMBIA",  descripcion: "Transferencia Bancolombia",  costoFijo: 3900n },
    { canalPago: "PSE",                 descripcion: "PSE",                        costoFijo: 0n    },
    { canalPago: "TRANSF_OTROS_BANCOS", descripcion: "Transferencia Otros Bancos", costoFijo: 7300n },
  ];

  for (const item of matrizPago) {
    await prisma.matrizPago.upsert({
      where: { canalPago: item.canalPago },
      update: { descripcion: item.descripcion },
      create: item,
    });
  }

  // Parámetros del sistema
  const params = [
    { clave: "COMISION_LM",    valor: "150000",  descripcion: "Comisión fija por factura de Luis Martínez (COP)" },
    { clave: "IVA_COMISION",   valor: "0.19",    descripcion: "IVA sobre la comisión (19%)" },
    { clave: "TASA_4X1000",    valor: "0.004",   descripcion: "Impuesto 4x1000 (0,4%)" },
    { clave: "DIAS_SLA_FACTURA", valor: "3",     descripcion: "Días máximos para facturar desde despacho" },
    {
      clave: "NIT_BANCO_4X1000",
      valor: "890300279",
      descripcion: "NIT del Banco de Occidente S.A. — beneficiario GMF (impuesto 4x1000) en todas las facturas",
    },
    {
      clave: "UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO",
      valor: "500000",
      descripcion: "Umbral de alerta de saldo disponible para trámites propios de Galcomex (COP)",
    },
    {
      clave: "UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO",
      valor: "200000",
      descripcion: "Umbral de alerta de saldo disponible para trámites del socio Lucho/LM (COP)",
    },
    {
      clave: "UMBRAL_ALERTA_CARTERA_CLIENTE",
      valor: "-20000000",
      descripcion: "Umbral de alerta de cartera: saldo neto del cliente por debajo de este valor dispara alerta (COP)",
    },
    {
      // Formato validado en src/lib/whatsapp/aprobadores.ts. SIN_CONFIGURAR = nadie
      // recibe el WhatsApp (el operario sigue pudiendo copiar el enlace a mano).
      clave: "WHATSAPP_APROBADORES_PSE",
      valor: "SIN_CONFIGURAR",
      descripcion:
        "Quién recibe por WhatsApp la solicitud del código del token PSE. Formato: Nombre:celular separados por ; (ej. María Camila:3001234567; Guillermo:3009876543)",
    },
  ];

  for (const p of params) {
    await prisma.parametro.upsert({
      where: { clave: p.clave },
      // Solo se crea con el valor inicial; después manda lo que edite el ADMIN.
      update: { descripcion: p.descripcion },
      create: { clave: p.clave, valor: p.valor, descripcion: p.descripcion },
    });
  }

  // Catálogo de capacidades (interruptores de función por empresa).
  // La fuente de verdad es src/lib/capacidades/catalogo.ts: aquí solo se
  // sincroniza a BD. Idempotente — respeta `activa` si un admin la apagó.
  for (const capacidad of CAPACIDADES) {
    await prisma.capacidad.upsert({
      where: { codigo: capacidad.codigo },
      update: {
        nombre: capacidad.nombre,
        descripcion: capacidad.descripcion,
        grupo: capacidad.grupo,
        ambito: capacidad.ambito,
        porDefecto: capacidad.porDefecto,
        configPorDefecto: capacidad.configPorDefecto ?? Prisma.DbNull,
        orden: capacidad.orden,
      },
      create: {
        codigo: capacidad.codigo,
        nombre: capacidad.nombre,
        descripcion: capacidad.descripcion,
        grupo: capacidad.grupo,
        ambito: capacidad.ambito,
        porDefecto: capacidad.porDefecto,
        configPorDefecto: capacidad.configPorDefecto ?? Prisma.DbNull,
        orden: capacidad.orden,
      },
    });
  }

  // Tipos de trámite (M4). IMPORTACION reproduce el comportamiento histórico;
  // CLASIFICACION lleva consecutivo y facturación aparte y exige que la empresa
  // tenga encendida la capacidad `clasificacion_arancelaria`.
  const tiposTramite = [
    {
      codigo: "IMPORTACION",
      nombre: "Trámite de importación",
      descripcion: "Trámite completo de importación. Consecutivo por ciudad y año.",
      prefijoConsecutivo: "DO",
      secuenciaPor: SecuenciaTramite.CIUDAD_ANIO,
      incluyeCiudadEnConsecutivo: true,
      lineaServicio: "TRAMITE",
      facturacionSeparada: false,
      capacidadRequerida: null,
      requiereAgenciaAduanas: true,
      requiereEta: true,
      usaChecklist: true,
      etiquetaReferenciaExterna: null,
      orden: 10,
    },
    {
      codigo: "CLASIFICACION",
      nombre: "Clasificación arancelaria",
      descripcion:
        "Servicio de clasificación, previo e independiente del trámite. Consecutivo y facturación aparte.",
      prefijoConsecutivo: "CLAS",
      secuenciaPor: SecuenciaTramite.ANIO,
      incluyeCiudadEnConsecutivo: false,
      lineaServicio: "CLASIFICACION",
      facturacionSeparada: true,
      capacidadRequerida: "clasificacion_arancelaria",
      requiereAgenciaAduanas: false,
      requiereEta: false,
      usaChecklist: false,
      etiquetaReferenciaExterna: "N° de informe de la clasificadora",
      orden: 20,
    },
    {
      // Plan Vallejo, sellos, coordinación logística: "eso también se cobra,
      // no es un DO" (reunión 10-sep-2026). Sin agencia, sin ETA, sin checklist.
      codigo: "OTRO",
      nombre: "Otros servicios",
      descripcion:
        "Servicios sueltos que se cobran sin DO: firma de Plan Vallejo, sellos, coordinación logística. Consecutivo propio (OTR26-0001), sin agencia, sin ETA ni checklist; se factura aparte.",
      prefijoConsecutivo: "OTR",
      secuenciaPor: SecuenciaTramite.ANIO,
      incluyeCiudadEnConsecutivo: false,
      lineaServicio: "OTROS",
      facturacionSeparada: true,
      capacidadRequerida: null,
      requiereAgenciaAduanas: false,
      requiereEta: false,
      usaChecklist: false,
      etiquetaReferenciaExterna: "Servicio prestado",
      orden: 30,
    },
  ];

  for (const tipo of tiposTramite) {
    await prisma.tipoTramite.upsert({
      where: { codigo: tipo.codigo },
      update: tipo,
      create: tipo,
    });
  }

  // Beneficiario Banco de Occidente (tercero del GMF en todas las facturas)
  await prisma.beneficiario.upsert({
    where: { id: "beneficiario-banco-occidente" },
    update: { nombre: "Banco de Occidente S.A.", nit: "890300279" },
    create: {
      id: "beneficiario-banco-occidente",
      nombre: "Banco de Occidente S.A.",
      nit: "890300279",
    },
  });

  // Plantilla de checklist estándar de apertura
  await prisma.plantillaChecklist.upsert({
    where: { id: "checklist-estandar" },
    update: {},
    create: {
      id: "checklist-estandar",
      nombre: "Checklist Estándar de Apertura DO",
      items: {
        create: [
          { descripcion: "Factura comercial",             requerido: true,  orden: 1 },
          { descripcion: "BL (Bill of Lading)",            requerido: true,  orden: 2 },
          { descripcion: "Packing list",                   requerido: true,  orden: 3 },
          { descripcion: "Lista de precios / declaración de valor", requerido: false, orden: 4 },
          { descripcion: "Certificado de origen (si aplica)", requerido: false, orden: 5 },
        ],
      },
    },
  });

  // Usuarios iniciales (5 fijos para single-tenant). Contraseña común a cambiar al primer login.
  const passwordHash = await hashPassword("Galcomex2026!");

  const usuarios: { email: string; name: string; rol: Rol }[] = [
    { email: "camila@galcomex.com",       name: "Camila",         rol: Rol.ADMIN },
    { email: "papa@galcomex.com",         name: "Papá",           rol: Rol.REVISOR },
    { email: "karina@galcomex.com",       name: "Karina",         rol: Rol.OPERATIVO },
    { email: "lucho@galcomex.com",        name: "Sr. Lucho",      rol: Rol.OPERATIVO },
    { email: "luismartinez@galcomex.com", name: "Luis Martínez",  rol: Rol.SOCIO },
  ];

  for (const u of usuarios) {
    // Idempotente: el upsert solo refresca name/rol. La cuenta credencial
    // (contraseña) se siembra SOLO si el usuario aún no tiene una, para no
    // pisar contraseñas cambiadas por el usuario o restablecidas por el admin
    // cuando el seed corre de nuevo en cada arranque del contenedor.
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        emailVerified: true,
        rol: u.rol,
      },
      create: {
        email: u.email,
        name: u.name,
        emailVerified: true,
        rol: u.rol,
      },
    });

    const tieneCredencial = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true },
    });

    if (!tieneCredencial) {
      await prisma.account.create({
        data: {
          userId: user.id,
          accountId: u.email,
          providerId: "credential",
          password: passwordHash,
        },
      });
    }
  }

  // Catálogos → Conceptos de venta. Idempotente y sin pisar ediciones del
  // ADMIN. Los que tengan producto Siigo solo quedan enlazados si el catálogo
  // de productos ya está sincronizado (ver docs/CATALOGOS.md).
  const conceptos = await sembrarConceptosVenta();

  console.log(
    `✓ Seed completado: matriz de pagos, parámetros, checklist, ${usuarios.length} usuarios ` +
      `y ${conceptos.conceptos.length} conceptos de venta (${conceptos.creados} nuevos, ` +
      `${conceptos.itemsEnlazados} ítems de tarifario enlazados)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
