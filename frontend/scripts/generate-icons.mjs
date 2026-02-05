import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '../public');

const svgContent = readFileSync(resolve(publicDir, 'apple-touch-icon.svg'), 'utf-8');

async function generateIcons() {
  // Generate 180x180 PNG for apple-touch-icon
  await sharp(Buffer.from(svgContent))
    .resize(180, 180)
    .png()
    .toFile(resolve(publicDir, 'apple-touch-icon.png'));
  console.log('Generated apple-touch-icon.png (180x180)');

  // Generate 192x192 PNG for PWA
  await sharp(Buffer.from(svgContent))
    .resize(192, 192)
    .png()
    .toFile(resolve(publicDir, 'pwa-192x192.png'));
  console.log('Generated pwa-192x192.png');

  // Generate 512x512 PNG for PWA
  await sharp(Buffer.from(svgContent))
    .resize(512, 512)
    .png()
    .toFile(resolve(publicDir, 'pwa-512x512.png'));
  console.log('Generated pwa-512x512.png');
}

generateIcons().catch(console.error);
