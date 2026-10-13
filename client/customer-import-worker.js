'use strict';

importScripts('./vendor/xlsx.full.min.js?v=0.18.5');

function collectSheetHyperlinks(sheet) {
  const links = {};
  if (!sheet?.['!ref']) return links;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const target = sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.l?.Target;
      if (target) links[`${row}:${column}`] = String(target);
    }
  }
  return links;
}

self.addEventListener('message', event => {
  const { buffer, fileName = '' } = event.data || {};
  try {
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Excel 文件内容无效');
    self.postMessage({ type: 'progress', progress: 20, phase: '正在解析 Excel 工作簿' });
    const workbook = XLSX.read(buffer, { type: 'array', cellText: true, raw: false });
    const sheets = workbook.SheetNames.map((name, index) => {
      const sheet = workbook.Sheets[name];
      self.postMessage({
        type: 'progress',
        progress: 25 + Math.round((index + 1) / Math.max(1, workbook.SheetNames.length) * 65),
        phase: `正在读取 Sheet：${name}`
      });
      return {
        sheet: name,
        fileName,
        matrix: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true }),
        cellLinks: collectSheetHyperlinks(sheet)
      };
    });
    self.postMessage({ type: 'complete', sheets });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Excel 解析失败' });
  }
});
