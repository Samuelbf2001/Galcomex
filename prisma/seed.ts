import "dotenv/config";
import { CanalPago, TipoRecaudo, Rol } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
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
      update: { descripcion: item.descripcion, costoFijo: item.costoFijo, grupo: item.grupo },
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
      update: { descripcion: item.descripcion, costoFijo: item.costoFijo },
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
  ];

  for (const p of params) {
    await prisma.parametro.upsert({
      where: { clave: p.clave },
      update: { valor: p.valor, descripcion: p.descripcion },
      create: { clave: p.clave, valor: p.valor, descripcion: p.descripcion },
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

  // Usuario administrador inicial
  const passwordHash = await hashPassword("Galcomex2026!");

  await prisma.user.upsert({
    where: { email: "camila@galcomex.com" },
    update: {
      name: "Camila",
      emailVerified: true,
      rol: Rol.ADMIN,
      accounts: {
        deleteMany: {
          providerId: "credential",
        },
        create: {
          accountId: "camila@galcomex.com",
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
    create: {
      email: "camila@galcomex.com",
      name: "Camila",
      emailVerified: true,
      rol: Rol.ADMIN,
      accounts: {
        create: {
          accountId: "camila@galcomex.com",
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
  });

  console.log("✓ Seed completado: matriz de pagos, parámetros, checklist y usuario admin");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
