/**
 * Generates the synthetic password-protected CAMS CAS PDF fixture used by
 * US-4.2 tests, with ZERO dependencies.
 *
 * Implements the PDF 1.4 standard security handler (/V 2 /R 3, RC4-128) per
 * PDF Reference 1.7 §7.6.3 — algorithms 2 (encryption key), 3 (O entry),
 * 4/5 (U entry) — so the file is genuinely encrypted and a real parser must
 * supply the password to read it.
 *
 * The statement content is entirely synthetic: the PAN, folio numbers and
 * investor name are structurally valid but never-issued values. No real PII
 * enters this repository (implementation plan §8).
 *
 *   node tests/fixtures/cams/generate-cas-fixture.mjs
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'cas-sample.pdf');

/** Synthetic CAS credentials — the password a CAMS CAS uses is PAN + DDMMYYYY. */
export const PASSWORD = 'ABCDE1234F01011990';

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const padPassword = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

/** Algorithm 3: the /O entry. Owner password defaults to the user password. */
function computeO(userPw, keyLen) {
  let digest = md5(padPassword(userPw));
  for (let i = 0; i < 50; i++) digest = md5(digest);
  const rc4Key = digest.subarray(0, keyLen);
  let out = rc4(rc4Key, padPassword(userPw));
  for (let i = 1; i <= 19; i++) {
    out = rc4(Buffer.from(rc4Key.map((b) => b ^ i)), out);
  }
  return out;
}

/** Algorithm 2: the file encryption key. */
function computeKey(userPw, o, p, id, keyLen) {
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p, 0);
  let digest = md5(padPassword(userPw), o, pBuf, id);
  for (let i = 0; i < 50; i++) digest = md5(digest.subarray(0, keyLen));
  return digest.subarray(0, keyLen);
}

/** Algorithm 5: the /U entry for R=3. */
function computeU(key, id) {
  let out = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) {
    out = rc4(Buffer.from(key.map((b) => b ^ i)), out);
  }
  return Buffer.concat([out, Buffer.alloc(16)]);
}

/** Per-object RC4 key: MD5(fileKey ‖ objNum[3] ‖ genNum[2]), truncated. */
function objectKey(key, objNum, genNum) {
  const extra = Buffer.from([
    objNum & 0xff,
    (objNum >> 8) & 0xff,
    (objNum >> 16) & 0xff,
    genNum & 0xff,
    (genNum >> 8) & 0xff,
  ]);
  return md5(key, extra).subarray(0, Math.min(key.length + 5, 16));
}

const escapePdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/* ------------------------------------------------------ statement content */

const HEADER_LINES = [
  'CONSOLIDATED ACCOUNT STATEMENT (SYNTHETIC TEST FIXTURE - NOT A REAL STATEMENT)',
  'CAMS / KFintech  |  Period: 01-Apr-2025 to 31-Mar-2026',
  'Investor: RAJESH SHARMA    PAN: ABCDE1234F    Email: rajesh@example.com',
  '',
];

/** folio, ISIN, scheme, date, txn, units, NAV */
const TRANSACTIONS = [
  ['91234567/89', 'INF090I01239', 'Axis Bluechip Fund - Growth', '10-Apr-2025', 'Purchase', '1234.567', '87.4321'],
  ['91234567/89', 'INF090I01239', 'Axis Bluechip Fund - Growth', '10-Jul-2025', 'Purchase', '512.340', '92.1150'],
  ['91234567/89', 'INF090I01239', 'Axis Bluechip Fund - Growth', '15-Nov-2025', 'Redemption', '200.000', '95.7800'],
  ['70123456/12', 'INF109K01Z48', 'ICICI Pru Value Discovery - Growth', '05-May-2025', 'Purchase', '850.125', '412.9900'],
  ['70123456/12', 'INF109K01Z48', 'ICICI Pru Value Discovery - Growth', '30-Sep-2025', 'Dividend Reinvest', '20.000', '250.0000'],
  ['58900123/45', 'INF179K01YV8', 'HDFC Liquid Fund - Growth', '01-Jun-2025', 'Purchase', '4500.000', '4712.3300'],
];

function buildContentStream() {
  const lines = [
    'BT',
    '/F1 9 Tf',
    '1 0 0 1 36 806 Tm',
    '11 TL',
  ];
  const emit = (text) => lines.push(`(${escapePdf(text)}) Tj`, 'T*');
  for (const line of HEADER_LINES) emit(line);
  emit('Folio No       ISIN           Scheme                                Date         Transaction        Units        NAV');
  for (const [folio, isin, scheme, date, txn, units, nav] of TRANSACTIONS) {
    emit(
      `${folio.padEnd(14)} ${isin.padEnd(14)} ${scheme.padEnd(37)} ${date.padEnd(12)} ${txn.padEnd(18)} ${units.padStart(10)} ${nav.padStart(11)}`,
    );
  }
  emit('');
  emit('DPID: 1208160000123456     Order ID: 250810400123456     Phone: +91 98765 43210');
  lines.push('ET');
  return Buffer.from(lines.join('\n'), 'latin1');
}

/* ------------------------------------------------------------ PDF assembly */

function build() {
  const keyLen = 16;
  const permissions = -3904; // print + copy denied; standard restrictive mask
  const id = createHash('md5').update('vantagepoint-cas-fixture-v1').digest();

  const o = computeO(PASSWORD, keyLen);
  const key = computeKey(PASSWORD, o, permissions, id, keyLen);
  const u = computeU(key, id);

  const content = buildContentStream();
  const encryptedContent = rc4(objectKey(key, 4, 0), content);

  const hex = (buf) => `<${buf.toString('hex').toUpperCase()}>`;

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    Buffer.concat([
      Buffer.from(`4 0 obj\n<< /Length ${encryptedContent.length} >>\nstream\n`, 'latin1'),
      encryptedContent,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]),
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    `6 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${permissions} ` +
      `/O ${hex(o)} /U ${hex(u)} >>\nendobj\n`,
  ].map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1')));

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let position = chunks[0].length;
  for (const obj of objects) {
    offsets.push(position);
    chunks.push(obj);
    position += obj.length;
  }

  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n \n`),
  ].join('');
  chunks.push(Buffer.from(xref, 'latin1'));

  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R ` +
        `/ID [${hex(id)} ${hex(id)}] >>\nstartxref\n${position}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(chunks);
}

writeFileSync(OUT, build());
console.log(`wrote ${OUT} (password: ${PASSWORD})`);
