/**
 * Vuelca la estructura de los Excel que envía Lucho (facturas de proveedor + pagos)
 * para diseñar el modelo FacturaProveedor / SolicitudFacturacion.
 * Uso: npx tsx scripts/dump-excel-lucho.ts <ruta.xls>
 */
import * as XLSX from "xlsx";

const file = process.argv[2];
if (!file) {
  console.error("Uso: npx tsx scripts/dump-excel-lucho.ts <ruta.xls>");
  process.exit(1);
}

const wb = XLSX.readFile(file, { cellStyles: true, cellDates: true });
console.log(`Archivo: ${file}`);
console.log(`Hojas (${wb.SheetNames.length}): ${wb.SheetNames.join(" | ")}\n`);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws["!ref"];
  console.log(`════ Hoja: "${name}" — rango ${ref ?? "(vacía)"} ════`);
  if (!ref) continue;

  const range = XLSX.utils.decode_range(ref);
  const maxRow = Math.min(range.e.r, 80);

  for (let r = range.s.r; r <= maxRow; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= Math.min(range.e.c, 14); c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      if (!cell) continue;
      let val = cell.w ?? String(cell.v ?? "");
      val = val.replace(/\s+/g, " ").trim();
      if (!val) continue;
      // fondo de celda si está disponible (para detectar el "subrayado azul")
      const style = (cell as { s?: { fgColor?: { rgb?: string } } }).s;
      const fill = style?.fgColor?.rgb ? `[bg:${style.fgColor.rgb}]` : "";
      cells.push(`${addr}=${val}${fill}`);
    }
    if (cells.length > 0) console.log(`  ${cells.join(" · ")}`);
  }
  if (range.e.r > 80) console.log(`  … (${range.e.r - 80} filas más)`);
  console.log("");
}
