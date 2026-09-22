/**
 * Alias de carpeta del histórico documental 2026 (segunda entrega, 21-sep):
 * la carpeta de `clientes/<alias>/` en el bucket usa el nombre corto de la
 * carpeta de Drive de cada cliente (p. ej. "COLDEX"), que no siempre coincide
 * con `Cliente.nombre` en la BD (p. ej. "AGENCIA DE ADUANAS COLDEX S.A.S
 * NIVEL DOS"). Esta tabla es la MISMA usada por el importador para encontrar
 * el cliente (`buscar` se compara por `ILIKE` en `scripts/historico-clientes/
 * importar.ts`); aquí se usa al revés, para saber qué carpeta de "sueltos"
 * (documentos fuera de un DO, sin registrar en la BD) le corresponde a un
 * cliente ya identificado.
 *
 * Solo cubre estos 11 clientes del histórico 2026. Un cliente nuevo cuyos
 * sueltos se suban más adelante bajo `clientes/<NOMBRE SANEADO>/` no necesita
 * entrada aquí si la carpeta coincide con `Cliente.nombre` saneado — pero hoy
 * la vista "Por cliente" solo resuelve automáticamente estos 11.
 */
const ALIAS_HISTORICO: { carpeta: string; buscar: string }[] = [
  { carpeta: "LITOPLAS", buscar: "LITOPLAS" },
  { carpeta: "COLDEX", buscar: "COLDEX" },
  { carpeta: "CW-ASIA", buscar: "CW ASIA" },
  { carpeta: "POLYREC-SAS", buscar: "POLYREC S.A.S" },
  { carpeta: "POLYREC-ZF", buscar: "POLYREC ZONA FRANCA" },
  { carpeta: "SESDERMA", buscar: "SESDERMA" },
  { carpeta: "PIERCO", buscar: "PIERCO" },
  { carpeta: "ORTHOFRACT", buscar: "ORTHOFRACT" },
  { carpeta: "INVERSIONES-TRIPLEX", buscar: "TRIPLEX" },
  { carpeta: "INVERSIONES-KASANA", buscar: "INVERSIONES KASANA" },
  { carpeta: "DISTRIBUIDORA-EL-TAPICERO", buscar: "TAPICERO" },
];

/** Mayúsculas, sin tildes, solo letras y números — para comparar sin que puntos, espacios o "S.A.S" vs "SAS" den falsos negativos. */
function normalizarParaComparar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** `nombreCliente` (de la BD) → carpeta de sueltos del histórico, si es uno de los 11 conocidos. */
export function carpetaHistoricaDeCliente(nombreCliente: string): string | null {
  const norm = normalizarParaComparar(nombreCliente);
  const match = ALIAS_HISTORICO.find((a) => norm.includes(normalizarParaComparar(a.buscar)));
  return match ? match.carpeta : null;
}
