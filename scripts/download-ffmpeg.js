/**
 * Download FFmpeg binaries for bundling with the app
 *
 * Usage: node scripts/download-ffmpeg.js
 *
 * This downloads the static FFmpeg build and extracts it to ffmpeg/
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// FFmpeg static build URLs (essentials build - smaller, has what we need)
const FFMPEG_URLS = {
  win32: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
};

const FFMPEG_DIR = path.join(__dirname, '..', 'ffmpeg');

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const file = fs.createWriteStream(dest);

    const request = (url) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const percent = Math.round((downloaded / total) * 100);
            process.stdout.write(`\rDownloading: ${percent}%`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\nDownload complete');
          resolve();
        });
      }).on('error', reject);
    };

    request(url);
  });
}

async function main() {
  const platform = process.platform;

  if (!FFMPEG_URLS[platform]) {
    console.log('Platform not supported for automatic download:', platform);
    console.log('Please download FFmpeg manually and place in ffmpeg/');
    process.exit(1);
  }

  // Create ffmpeg directory
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  const zipPath = path.join(FFMPEG_DIR, 'ffmpeg.zip');

  try {
    // Download
    await downloadFile(FFMPEG_URLS[platform], zipPath);

    // Extract
    console.log('Extracting...');

    if (platform === 'win32') {
      // Use PowerShell to extract on Windows
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${FFMPEG_DIR}' -Force"`, {
        stdio: 'inherit',
      });

      // Find and move ffmpeg.exe to root of ffmpeg/
      const entries = fs.readdirSync(FFMPEG_DIR);
      for (const entry of entries) {
        const binPath = path.join(FFMPEG_DIR, entry, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(binPath)) {
          fs.copyFileSync(binPath, path.join(FFMPEG_DIR, 'ffmpeg.exe'));
          console.log('FFmpeg extracted to:', path.join(FFMPEG_DIR, 'ffmpeg.exe'));
          break;
        }
      }
    } else if (platform === 'darwin') {
      execSync(`unzip -o "${zipPath}" -d "${FFMPEG_DIR}"`, { stdio: 'inherit' });
    }

    // Clean up
    fs.unlinkSync(zipPath);

    console.log('FFmpeg ready!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
