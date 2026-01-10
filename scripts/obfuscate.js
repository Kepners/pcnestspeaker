/**
 * Obfuscation Script for PC Nest Speaker
 *
 * Protects IP by obfuscating core JavaScript files before build.
 * Creates backups so you can restore originals after build.
 *
 * Usage:
 *   npm run obfuscate       - Obfuscate files
 *   npm run build:protected - Obfuscate + build
 *
 * After building, run: node scripts/obfuscate.js --restore
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// Files to obfuscate (your core IP)
const filesToObfuscate = [
  'src/main/electron-main.js',
  'src/main/audio-streamer.js',
  'src/main/chromecast.js',
  'src/main/audio-sync-manager.js',
  'src/main/auto-sync-manager.js',
  'src/main/audio-routing.js',
  'src/main/audio-device-manager.js',
  'src/main/daemon-manager.js',
  'src/main/settings-manager.js'
];

// Obfuscation config (from obfuscator.json)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'obfuscator.json'), 'utf8'));

const backupDir = path.join(__dirname, '..', '.obfuscate-backup');

// Check for --restore flag
if (process.argv.includes('--restore')) {
  console.log('Restoring original files from backup...\n');

  if (!fs.existsSync(backupDir)) {
    console.log('No backup found. Nothing to restore.');
    process.exit(0);
  }

  let restored = 0;
  filesToObfuscate.forEach(file => {
    const fullPath = path.join(__dirname, '..', file);
    const backupPath = path.join(backupDir, file);

    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, fullPath);
      console.log(`  ✓ Restored: ${file}`);
      restored++;
    }
  });

  // Clean up backup directory
  fs.rmSync(backupDir, { recursive: true, force: true });

  console.log(`\nRestored ${restored} files. Backup deleted.`);
  process.exit(0);
}

// Main obfuscation
console.log('PC Nest Speaker - Code Obfuscation\n');
console.log('Creating backups...');

// Create backup directory
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

let obfuscated = 0;
let skipped = 0;

filesToObfuscate.forEach(file => {
  const fullPath = path.join(__dirname, '..', file);
  const backupPath = path.join(backupDir, file);

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠ Skipped (not found): ${file}`);
    skipped++;
    return;
  }

  // Create backup subdirectory if needed
  const backupSubDir = path.dirname(backupPath);
  if (!fs.existsSync(backupSubDir)) {
    fs.mkdirSync(backupSubDir, { recursive: true });
  }

  // Backup original
  fs.copyFileSync(fullPath, backupPath);

  // Read original code
  const originalCode = fs.readFileSync(fullPath, 'utf8');

  // Obfuscate
  try {
    const obfuscatedCode = JavaScriptObfuscator.obfuscate(originalCode, config).getObfuscatedCode();

    // Write obfuscated code
    fs.writeFileSync(fullPath, obfuscatedCode, 'utf8');

    const originalSize = (originalCode.length / 1024).toFixed(1);
    const obfuscatedSize = (obfuscatedCode.length / 1024).toFixed(1);
    console.log(`  ✓ ${file} (${originalSize}KB → ${obfuscatedSize}KB)`);
    obfuscated++;
  } catch (err) {
    console.log(`  ✗ Error obfuscating ${file}: ${err.message}`);
    // Restore from backup on error
    fs.copyFileSync(backupPath, fullPath);
  }
});

console.log(`\nObfuscated ${obfuscated} files, skipped ${skipped}.`);
console.log('\nBackups saved to: .obfuscate-backup/');
console.log('To restore originals: node scripts/obfuscate.js --restore');
console.log('\nReady to build!');
