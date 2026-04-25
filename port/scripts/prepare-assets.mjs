#!/usr/bin/env node
// Prepare client- and server-side assets for the browser port.
//
// Copies images, l10n XML, and icons from the original Java client tree
// into port/web/public/, transcodes Sun .au sound files to .wav (browsers
// cannot decode .au natively), and copies tracks/tracksets to port/server/tracks/.
//
// Idempotent: destination subtrees are wiped and re-created on every run.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Worktree root is two levels above this script (port/scripts/<this>).
const PORT_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PORT_ROOT, '..');

const SRC_PICTURES = join(REPO_ROOT, 'client', 'src', 'main', 'resources', 'picture', 'agolf');
const SRC_SOUNDS = join(REPO_ROOT, 'client', 'src', 'main', 'resources', 'sound', 'shared');
const SRC_L10N = join(REPO_ROOT, 'client', 'src', 'main', 'resources', 'l10n');
const SRC_ICON = join(REPO_ROOT, 'client', 'src', 'main', 'resources', 'icons', 'playforia.png');
const SRC_TRACKS = join(REPO_ROOT, 'server', 'src', 'main', 'resources', 'tracks', 'tracks');
const SRC_TRACKSETS = join(REPO_ROOT, 'server', 'src', 'main', 'resources', 'tracks', 'sets');

const DEST_PUBLIC = join(PORT_ROOT, 'web', 'public');
const DEST_PICTURES = join(DEST_PUBLIC, 'picture', 'agolf');
const DEST_SOUNDS = join(DEST_PUBLIC, 'sound', 'shared');
const DEST_L10N = join(DEST_PUBLIC, 'l10n');
const DEST_ICONS = join(DEST_PUBLIC, 'icons');
const DEST_TRACKS = join(PORT_ROOT, 'server', 'tracks', 'tracks');
const DEST_TRACKSETS = join(PORT_ROOT, 'server', 'tracks', 'sets');

// ---- µ-law decode (Sun standard) ---------------------------------------

function muLawDecode(byte) {
  byte = ~byte & 0xff;
  const sign = byte & 0x80 ? -1 : 1;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  const magnitude = ((mantissa << 3) + 0x84) << exponent;
  return sign * (magnitude - 0x84);
}

// ---- WAV writer --------------------------------------------------------

function buildWav(pcm16, sampleRate, channels) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  let p = 0;
  buf.write('RIFF', p); p += 4;
  buf.writeUInt32LE(36 + dataSize, p); p += 4;
  buf.write('WAVE', p); p += 4;
  buf.write('fmt ', p); p += 4;
  buf.writeUInt32LE(16, p); p += 4;             // fmt chunk size
  buf.writeUInt16LE(1, p); p += 2;              // audio format = PCM
  buf.writeUInt16LE(channels, p); p += 2;
  buf.writeUInt32LE(sampleRate, p); p += 4;
  buf.writeUInt32LE(byteRate, p); p += 4;
  buf.writeUInt16LE(blockAlign, p); p += 2;
  buf.writeUInt16LE(16, p); p += 2;             // bits per sample
  buf.write('data', p); p += 4;
  buf.writeUInt32LE(dataSize, p); p += 4;
  for (let i = 0; i < pcm16.length; i++) {
    buf.writeInt16LE(clampInt16(pcm16[i]), p);
    p += 2;
  }
  return buf;
}

function clampInt16(n) {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n;
}

// ---- .au decoder -------------------------------------------------------

function decodeAu(srcPath) {
  const raw = readFileSync(srcPath);
  if (raw.length < 24 || raw.toString('ascii', 0, 4) !== '.snd') {
    throw new Error(`Not a Sun .au file: ${srcPath}`);
  }
  const dataOffset = raw.readUInt32BE(4);
  const dataLength = raw.readUInt32BE(8); // may be 0xFFFFFFFF (unknown)
  const encoding = raw.readUInt32BE(12);
  const sampleRate = raw.readUInt32BE(16);
  const channels = raw.readUInt32BE(20);

  const end = dataLength === 0xffffffff ? raw.length : Math.min(raw.length, dataOffset + dataLength);
  const data = raw.subarray(dataOffset, end);

  let pcm;
  if (encoding === 1) {
    // 8-bit µ-law
    pcm = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) pcm[i] = muLawDecode(data[i]);
  } else if (encoding === 2) {
    // 8-bit linear (signed)
    pcm = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = data.readInt8(i);
      pcm[i] = s << 8;
    }
  } else if (encoding === 3) {
    // 16-bit linear PCM, big-endian
    const samples = Math.floor(data.length / 2);
    pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = data.readInt16BE(i * 2);
  } else {
    throw new Error(`Unsupported .au encoding ${encoding} in ${srcPath}`);
  }

  return { pcm, sampleRate, channels, encoding };
}

// ---- helpers -----------------------------------------------------------

function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function listFiles(dir) {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
}

function copyFiles(srcDir, destDir) {
  const names = listFiles(srcDir);
  for (const name of names) copyFileSync(join(srcDir, name), join(destDir, name));
  return names.length;
}

// ---- main --------------------------------------------------------------

function main() {
  // 1. Reset destination subtrees so the run is idempotent.
  resetDir(DEST_PICTURES);
  resetDir(DEST_SOUNDS);
  resetDir(DEST_L10N);
  resetDir(DEST_ICONS);
  resetDir(DEST_TRACKS);
  resetDir(DEST_TRACKSETS);

  // 2. Pictures.
  const pictureCount = copyFiles(SRC_PICTURES, DEST_PICTURES);

  // 3. l10n XML (per locale).
  let l10nCount = 0;
  for (const locale of readdirSync(SRC_L10N)) {
    const srcLocaleDir = join(SRC_L10N, locale);
    if (!statSync(srcLocaleDir).isDirectory()) continue;
    const destLocaleDir = join(DEST_L10N, locale);
    mkdirSync(destLocaleDir, { recursive: true });
    l10nCount += copyFiles(srcLocaleDir, destLocaleDir);
  }

  // 4. Icon.
  copyFileSync(SRC_ICON, join(DEST_ICONS, basename(SRC_ICON)));

  // 5. Sounds: .au -> .wav.
  const auFiles = listFiles(SRC_SOUNDS).filter((n) => n.toLowerCase().endsWith('.au'));
  const soundDetails = [];
  for (const name of auFiles) {
    const srcPath = join(SRC_SOUNDS, name);
    const { pcm, sampleRate, channels, encoding } = decodeAu(srcPath);
    const wav = buildWav(pcm, sampleRate, channels);
    const wavName = name.replace(/\.au$/i, '.wav');
    writeFileSync(join(DEST_SOUNDS, wavName), wav);
    soundDetails.push({ name: wavName, encoding, sampleRate, channels, samples: pcm.length });
  }

  // 6. Tracks + tracksets.
  const trackCount = copyFiles(SRC_TRACKS, DEST_TRACKS);
  const tracksetCount = copyFiles(SRC_TRACKSETS, DEST_TRACKSETS);

  // 7. Summary.
  console.log('Asset preparation summary');
  console.log('  pictures :', pictureCount, '->', DEST_PICTURES);
  console.log('  l10n     :', l10nCount, '->', DEST_L10N);
  console.log('  icon     : 1 ->', DEST_ICONS);
  console.log('  sounds   :', soundDetails.length, '->', DEST_SOUNDS);
  for (const s of soundDetails) {
    console.log(`             ${s.name}  enc=${s.encoding} ${s.sampleRate}Hz ${s.channels}ch ${s.samples} samples`);
  }
  console.log('  tracks   :', trackCount, '->', DEST_TRACKS);
  console.log('  tracksets:', tracksetCount, '->', DEST_TRACKSETS);
}

main();
