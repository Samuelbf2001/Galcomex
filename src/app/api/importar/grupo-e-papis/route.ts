import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import * as XLSX from "xlsx";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { importarWorkbookGrupoEPapis } from "@/lib/import/grupo-e-papis";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const EXTENSIONES_VALIDAS = [".xlsm", ".xls"];

const camposSchema = z.object({
  clienteId: z.string().min(1, "clienteId es obligatorio"),
  dryRun: z
    .enum(["true", "false"], {
      message: 'dryRun debe ser "true" o "false"',
    })
    .transform((value) => value === "true"),
});

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const form = await request.formData();

  // 1. Validar campos no-archivo con Zod.
  let campos: z.infer<typeof camposSchema>;
  try {
    campos = camposSchema.parse({
      clienteId: form.get("clienteId"),
      dryRun: form.get("dryRun"),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const { clienteId, dryRun } = campos;

  // 2. Validar el archivo.
  const file = form.get("file");

  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "Falta el archivo en el campo 'file'" },
      { status: 400 },
    );
  }

  const fileName = file instanceof File ? file.name : "";
  const lowerName = fileName.toLowerCase();
  const extensionValida = EXTENSIONES_VALIDAS.some((ext) =>
    lowerName.endsWith(ext),
  );

  if (!extensionValida) {
    return NextResponse.json(
      { error: "El archivo debe tener extensión .xlsm o .xls" },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "El archivo supera el tamaño máximo de 25 MB" },
      { status: 400 },
    );
  }

  // 3. Validar que el cliente exista.
  const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });

  if (!cliente) {
    return NextResponse.json(
      { error: "Cliente no encontrado" },
      { status: 404 },
    );
  }

  // 4. Parsear el workbook en memoria.
  const buffer = Buffer.from(await file.arrayBuffer());

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
      cellFormula: true,
    });
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `No se pudo leer el archivo Excel: ${detalle}` },
      { status: 400 },
    );
  }

  // 5. Delegar en el engine (ya serializa el dinero a string).
  const reporte = await importarWorkbookGrupoEPapis({
    workbook,
    clienteId,
    usuarioId: session.user.id,
    dryRun,
  });

  return jsonResponse({ reporte });
}
