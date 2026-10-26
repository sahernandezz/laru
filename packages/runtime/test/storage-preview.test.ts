/** What «Almacenamiento» previews: the type an object has, and a spreadsheet read without a library. */
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { contentTypeOf, sheet, STREAMABLE, XLSX } from '../src/explore/storage.ts';

/** A zip with each file deflated, written by hand: the reader must not depend on how the file was made. */
function zip(files: Record<string, string>, stored = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = stored ? raw : deflateRawSync(raw), n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(stored ? 0 : 8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(stored ? 0 : 8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, n, data); central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, end]);
}
const book = (rows: string) => ({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Ventas &amp; más" sheetId="1"/><sheet name="Otra" sheetId="2"/></sheets></workbook>',
  'xl/sharedStrings.xml': '<sst><si><t>Producto</t></si><si><r><t>Pan </t></r><r><t>&amp; vino</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>',
});

test('a spreadsheet is read as rows: shared strings, entities, formatted runs, gaps between cells, inline text', () => {
  const rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>dentro</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c></row><row r="3"/>';
  for (const stored of [false, true]) {
    const s = sheet(zip(book(rows), stored));
    assert.equal(s.name, 'Ventas & más');
    assert.equal(s.sheets, 2);
    assert.deepEqual(s.rows, [['Producto', '', 'dentro'], ['Pan & vino', '42.5']]);
    assert.equal(s.truncated, false);
  }
});

test('a spreadsheet is cut at its rows and columns, and says so; a file that is not one is refused', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const cut = sheet(zip(book(many)), 10, 40);
  assert.equal(cut.rows.length, 10);
  assert.equal(cut.truncated, true);
  const wide = sheet(zip(book(`<row r="1">${['A', 'B', 'C', 'D'].map((c) => `<c r="${c}1"><v>1</v></c>`).join('')}</row>`)), 10, 2);
  assert.deepEqual(wide.rows, [['1', '1']]);
  assert.equal(wide.truncated, true);
  assert.throws(() => sheet(Buffer.from('this is not a zip at all, only text')), /not a spreadsheet/);
  assert.throws(() => sheet(zip({ 'readme.txt': 'x' })), /no sheet/);
});

test('the type of an object is what is stored, or what its extension says when it was put with none', () => {
  const meta = (t?: string) => ({ metadata: t ? { 'Content-Type': t } : {} });
  assert.equal(contentTypeOf(meta('application/pdf'), 'a/b.bin'), 'application/pdf');
  assert.equal(contentTypeOf(meta('Image/PNG; charset=x'), 'x'), 'image/png');
  assert.equal(contentTypeOf(meta('application/octet-stream'), 'clip.webm'), 'video/webm', 'a blob with a known extension');
  assert.equal(contentTypeOf(meta(), 'sheet.XLSX'), XLSX);
  assert.equal(contentTypeOf(meta(), 'noext'), '');
  // what the browser may draw itself: media and PDF, never a page
  for (const ok of ['image/png', 'image/svg+xml', 'video/mp4', 'audio/mpeg', 'application/pdf']) assert.ok(STREAMABLE.test(ok), ok);
  for (const no of ['text/html', 'application/javascript', 'application/xhtml+xml', 'image/x-icon-bad', XLSX]) assert.ok(!STREAMABLE.test(no), no);
});
