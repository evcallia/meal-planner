import sharp from 'sharp';
import fs from 'fs';

async function convert() {
  // Read SVGs
  const favicon = fs.readFileSync('public/favicon.svg');
  const appleIcon = fs.readFileSync('public/apple-touch-icon.svg');

  // Convert to PNGs
  await sharp(favicon)
    .resize(192, 192)
    .png()
    .toFile('public/pwa-192x192.png');

  await sharp(favicon)
    .resize(512, 512)
    .png()
    .toFile('public/pwa-512x512.png');

  await sharp(appleIcon)
    .resize(180, 180)
    .png()
    .toFile('public/apple-touch-icon.png');

  console.log('Icons generated successfully!');
}

convert().catch(console.error);
