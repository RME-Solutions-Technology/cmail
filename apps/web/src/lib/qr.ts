// QR code as one inline SVG path, so the page needs no image, no remote file
// and no script from elsewhere (the CSP stays strict). Encoding is the
// MIT-licensed qrcode-generator package (pinned, no dependencies); this file
// only turns its module matrix into path data.
import qrcode from 'qrcode-generator';

export interface QrPath {
  /** Modules per side (the quiet zone is not included). */
  size: number;
  /** SVG path data: one run of horizontal modules per segment. */
  path: string;
}

export function qrPath(text: string): QrPath {
  // 'M' error correction (about 15%) is enough for a screen to a phone camera.
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!qr.isDark(row, column)) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && qr.isDark(row, column)) column += 1;
      parts.push(`M${start} ${row}h${column - start}v1h-${column - start}z`);
    }
  }
  return { size, path: parts.join('') };
}
