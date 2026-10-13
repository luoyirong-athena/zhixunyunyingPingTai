'use strict';
const XLSX = require('xlsx');

function cellText(cell) {
  if (!cell) return '';
  if (cell.w != null) return String(cell.w);
  if (cell.v != null) return cell.v instanceof Date ? cell.v.toISOString() : String(cell.v);
  if (cell.f) return `=${cell.f}`;
  return '';
}

function columnName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function main() {
  const filePath = process.argv[2];
  const requestedSheet = process.argv[3] || '';
  const offset = Math.max(0, Number(process.argv[4]) || 0);
  const limit = Math.max(1, Math.min(Number(process.argv[5]) || 200, 200));
  const maxColumns = 50;
  const workbook = XLSX.readFile(filePath, {
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellDates: false,
    bookVBA: false,
    WTF: false,
    codepage: String(filePath || '').toLowerCase().endsWith('.csv') ? 65001 : undefined
  });
  const sheets = workbook.SheetNames || [];
  const activeSheet = sheets.includes(requestedSheet) ? requestedSheet : (sheets[0] || '');
  if (!activeSheet) throw new Error('工作簿中没有可预览的工作表');
  const sheet = workbook.Sheets[activeSheet];
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  const totalRows = Math.max(0, range.e.r - range.s.r + 1);
  const totalColumns = Math.max(0, range.e.c - range.s.c + 1);
  const startRow = range.s.r + offset;
  const endRow = Math.min(range.e.r, startRow + limit - 1);
  const endColumn = Math.min(range.e.c, range.s.c + maxColumns - 1);
  const rows = [];
  if (totalRows > 0 && totalColumns > 0 && startRow <= range.e.r) {
    for (let r = startRow; r <= endRow; r += 1) {
      const cells = [];
      for (let c = range.s.c; c <= endColumn; c += 1) {
        cells.push(cellText(sheet[XLSX.utils.encode_cell({ r, c })]));
      }
      rows.push({ rowNumber: r + 1, cells });
    }
  }
  const merges = (sheet['!merges'] || []).map(merge => ({
    startRow: merge.s.r + 1,
    startColumn: merge.s.c - range.s.c,
    endRow: merge.e.r + 1,
    endColumn: merge.e.c - range.s.c
  })).filter(merge => merge.endRow >= startRow + 1 && merge.startRow <= endRow + 1 && merge.startColumn < maxColumns);
  const result = {
    sheets,
    activeSheet,
    columns: Array.from({ length: Math.min(totalColumns, maxColumns) }, (_, index) => columnName(range.s.c + index)),
    rows,
    merges,
    totalRows,
    totalColumns,
    offset,
    limit,
    partial: offset > 0 || endRow < range.e.r || totalColumns > maxColumns,
    maxColumns
  };
  process.stdout.write(JSON.stringify(result));
}

try { main(); } catch (error) {
  process.stderr.write(error?.stack || String(error));
  process.exitCode = 1;
}
