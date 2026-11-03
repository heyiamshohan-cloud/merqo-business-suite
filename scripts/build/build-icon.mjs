/**
 * Generates `build/icon.ico` (256×256 PNG payload) and `build/icon.png` from
 * `build/icon-source.png`, so the repository stores one master image and the
 * platform artefacts are reproducible.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const source = 'build/icon-source.png';
const png = await sharp(source).resize(512, 512).png().toBuffer();
writeFileSync('build/icon.png', png);

const small = await sharp(source).resize(256, 256).png().toBuffer();
const ico = await pngToIco(small);
writeFileSync('build/icon.ico', ico);

console.log(`build/icon.png (${png.length} B), build/icon.ico (${ico.length} B)`);
