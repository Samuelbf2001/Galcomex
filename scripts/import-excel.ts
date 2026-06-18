import * as path from "node:path";

import {
  DEFAULT_DO_SHEET,
  readGalcomexWorkbook,
  summarizeParsedWorkbook,
} from "../src/lib/excel/galcomex-workbook";

const DEFAULT_WORKBOOK_PATH = "C:\\Users\\samue\\Galcomex\\GRUPO E PAPIS 2026 (1).xlsm";

interface CliOptions {
  filePath: string;
  sheetName: string;
  json: boolean;
  summary: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    filePath: DEFAULT_WORKBOOK_PATH,
    sheetName: DEFAULT_DO_SHEET,
    json: false,
    summary: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--summary") {
      options.summary = true;
      continue;
    }

    if (arg === "--file") {
      options.filePath = requireValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--sheet") {
      options.sheetName = requireValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.json && !options.summary) {
    options.json = true;
    options.summary = true;
  }

  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(helpText());
    return;
  }

  const parsed = readGalcomexWorkbook(path.resolve(options.filePath), options.sheetName);

  if (options.summary) {
    console.log(summarizeParsedWorkbook(parsed));
  }

  if (options.json) {
    if (options.summary) {
      console.log("");
    }

    console.log(JSON.stringify(parsed, null, 2));
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function helpText(): string {
  return [
    "Usage: npx tsx scripts/import-excel.ts [options]",
    "",
    "Options:",
    `  --file <path>    Workbook path. Defaults to ${DEFAULT_WORKBOOK_PATH}`,
    `  --sheet <name>   DO sheet to inspect. Defaults to ${DEFAULT_DO_SHEET}`,
    "  --summary       Print only the text summary unless --json is also present",
    "  --json          Print only JSON unless --summary is also present",
    "  -h, --help      Show this help",
    "",
    "This is a dry-run reader. It does not write to the database.",
  ].join("\n");
}

const scriptName = process.argv[1] ? path.basename(process.argv[1]) : "";
const isDirectRun = scriptName === "import-excel.ts" || scriptName === "import-excel.js";

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
