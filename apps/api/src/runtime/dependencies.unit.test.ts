import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';

it('preserves XLSX read/write compatibility after security overrides', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Security fixture');
  sheet.addRow(['Model', 'Quantity']);
  sheet.addRow(['CASIO-TEST', 2]);
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  expect(restored.getWorksheet(1)?.getCell('A2').value).toBe('CASIO-TEST');
  expect(restored.getWorksheet(1)?.getCell('B2').value).toBe(2);
});
