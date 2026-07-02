'use strict';

/**
 * Generates a handful of placeholder JPEGs so the galleries work out of the
 * box for a demo/first deploy. Requires `sharp` (installed as a dependency).
 *
 *   npm run seed-samples
 *
 * Replace these with real client photos before going live.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SAMPLES = {
  'crowther-key': [
    { name: 'image1.jpg', color: '#3b6ea5', label: 'Crowther Key 01' },
    { name: 'image2.jpg', color: '#a53b6e', label: 'Crowther Key 02' },
    { name: 'image3.jpg', color: '#6ea53b', label: 'Crowther Key 03' }
  ],
  'acme-co': [
    { name: 'image1.jpg', color: '#5a3ba5', label: 'Acme Co 01' },
    { name: 'image2.jpg', color: '#a5823b', label: 'Acme Co 02' }
  ]
};

function svg(width, height, color, label) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${color}"/>
      <text x="50%" y="50%" fill="#ffffff" font-family="sans-serif"
            font-size="64" text-anchor="middle" dominant-baseline="middle">
        ${label}
      </text>
    </svg>`);
}

async function main() {
  for (const [client, images] of Object.entries(SAMPLES)) {
    const dir = path.join(__dirname, '..', 'galleries', client);
    fs.mkdirSync(dir, { recursive: true });
    for (const img of images) {
      const out = path.join(dir, img.name);
      await sharp(svg(1600, 1200, img.color, img.label)).jpeg({ quality: 82 }).toFile(out);
      console.log('wrote', path.relative(process.cwd(), out));
    }
  }
  console.log('Done. Sample galleries created under galleries/.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
