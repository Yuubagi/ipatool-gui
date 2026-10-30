const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  if (fs.lstatSync(source).isDirectory()) {
    const files = fs.readdirSync(source);
    files.forEach((file) => {
      const curSource = path.join(source, file);
      const curTarget = path.join(target, file);
      if (fs.lstatSync(curSource).isDirectory()) {
        copyFolderRecursiveSync(curSource, curTarget);
      } else {
        fs.copyFileSync(curSource, curTarget);
      }
    });
  }
}

const oldPublicPath = 'C:\\Users\\Public\\ipatool-gui';
const installDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const customUserData = path.join(installDir, 'data');

if (!fs.existsSync(customUserData) && fs.existsSync(oldPublicPath)) {
  try {
    copyFolderRecursiveSync(oldPublicPath, customUserData);
    fs.rmSync(oldPublicPath, { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to migrate userData:', e.message);
  }
}

app.setPath('userData', customUserData);

const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

// ── Fix Windows GPU cache & rendering issues ───────────────────────────────────
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

// ── Constants ──────────────────────────────────────────────────────────────────
const IPATOOL_VERSION = '2.7.0'; // Fallback only; latest is read from official releases.
const IPATOOL_REPO = 'majd/ipatool';
const GUI_REPO = 'Yuubagi/ipatool-gui';
const KEYCHAIN_PASSPHRASE = 'ipatool';
const DEFAULT_TIMEOUT = 30000;   // General CLI commands
const AUTH_TIMEOUT = 300000;      // Apple sign-in and 2FA may take several minutes
const DOWNLOAD_TIMEOUT = 300000; // 5 minutes

// ── Paths ──────────────────────────────────────────────────────────────────────
let binaryPath;
let settingsPath;

function initPaths() {
  binaryPath = getBundledPath();
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
}

// ── Single Instance Lock ───────────────────────────────────────────────────────
let gotTheLock = false;
try {
  gotTheLock = app.requestSingleInstanceLock();
} catch (e) {
  // Lock file might be stale — continue anyway
  gotTheLock = true;
}

if (!gotTheLock) {
  app.quit();
}

// ── Window ─────────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    detectAndSyncStorefrontRegion();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  initPaths();

  // Clean up legacy bin directory in userData if it exists to keep everything in resources/bin
  const legacyBinDir = path.join(app.getPath('userData'), 'bin');
  if (fs.existsSync(legacyBinDir)) {
    try {
      fs.rmSync(legacyBinDir, { recursive: true, force: true });
    } catch (_) {}
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ── Settings ───────────────────────────────────────────────────────────────────
const STOREFRONT_MAP = {
  "143481": "AE", "143540": "AG", "143538": "AI", "143542": "BM",
  "143564": "AO", "143505": "AR", "143445": "AT", "143460": "AU",
  "143568": "AZ", "143541": "BB", "143490": "BD", "143446": "BE",
  "143526": "BG", "143559": "BH", "143560": "BN", "143556": "BO",
  "143503": "BR", "143539": "BS", "143525": "BW", "143565": "BY",
  "143555": "BZ", "143455": "CA", "143459": "CH", "143527": "CI",
  "143483": "CL", "143465": "CN", "143501": "CO", "143495": "CR",
  "143557": "CY", "143489": "CZ", "143443": "DE", "143458": "DK",
  "143545": "DM", "143508": "DO", "143563": "DZ", "143509": "EC",
  "143518": "EE", "143516": "EG", "143454": "ES", "143447": "FI",
  "143442": "FR", "143444": "GB", "143546": "GD", "143615": "GE",
  "143573": "GH", "143448": "GR", "143504": "GT", "143553": "GY",
  "143463": "HK", "143510": "HN", "143494": "HR", "143482": "HU",
  "143476": "ID", "143449": "IE", "143491": "IL", "143467": "IN",
  "143558": "IS", "143450": "IT", "143617": "IQ", "143511": "JM",
  "143528": "JO", "143462": "JP", "143529": "KE", "143548": "KN",
  "143466": "KR", "143493": "KW", "143544": "KY", "143517": "KZ",
  "143497": "LB", "143549": "LC", "143522": "LI", "143486": "LK",
  "143520": "LT", "143451": "LU", "143519": "LV", "143523": "MD",
  "143531": "MG", "143530": "MK", "143532": "ML", "143592": "MN",
  "143515": "MO", "143547": "MS", "143521": "MT", "143533": "MU",
  "143488": "MV", "143468": "MX", "143473": "MY", "143534": "NE",
  "143561": "NG", "143512": "NI", "143452": "NL", "143457": "NO",
  "143484": "NP", "143461": "NZ", "143562": "OM", "143485": "PA",
  "143507": "PE", "143474": "PH", "143477": "PK", "143478": "PL",
  "143453": "PT", "143513": "PY", "143498": "QA", "143487": "RO",
  "143500": "RS", "143469": "RU", "143479": "SA", "143456": "SE",
  "143464": "SG", "143499": "SI", "143496": "SK", "143535": "SN",
  "143554": "SR", "143506": "SV", "143552": "TC", "143475": "TH",
  "143536": "TN", "143480": "TR", "143551": "TT", "143470": "TW",
  "143572": "TZ", "143492": "UA", "143537": "UG", "143441": "US",
  "143514": "UY", "143566": "UZ", "143550": "VC", "143502": "VE",
  "143543": "VG", "143471": "VN", "143571": "YE", "143472": "ZA"
};

async function detectAndSyncStorefrontRegion() {
  try {
    const result = await runIpatool(['auth', 'info']);
    if (result && result.success && result.output) {
      const match = result.output.match(/storeFront=([^\s\r\n]+)/) || result.output.match(/"storeFront"\s*:\s*"([^"]+)"/);
      if (match && match[1]) {
        const fullSf = match[1].trim();
        const sfId = fullSf.split('-')[0];
        const countryCode = STOREFRONT_MAP[sfId];
        if (countryCode) {
          const settings = loadSettings();
          if (!settings.country) {
            settings.country = countryCode;
            saveSettings(settings);
            console.log(`[Storefront Sync] Automatically mapped storefront ${sfId} and saved country ${countryCode} to settings.`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('settings-updated', settings);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[Storefront Sync] Failed to sync storefront region:', e.message);
  }
}

function getDefaultSettings() {
  return {
    outputDir: app.getPath('downloads'),
    country: '',
    concurrentDownloads: 1,
    language: 'auto',
  };
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      return { ...getDefaultSettings(), ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Failed to load settings:', err.message);
  }
  return getDefaultSettings();
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err.message);
    return false;
  }
}

function saveInstalledCliVersion(version) {
  try {
    const settings = loadSettings();
    settings.installedCliVersion = version;
    saveSettings(settings);
  } catch (e) {
    console.error('Failed to save installed CLI version to settings:', e.message);
  }
}

// ── Binary Management ──────────────────────────────────────────────────────────
function binaryExists() {
  return fs.existsSync(binaryPath);
}

/**
 * Follow HTTP redirects (GitHub releases redirect to CDN).
 * Returns a readable response stream via callback.
 */
function httpsGetFollowRedirects(url, callback) {
  https.get(url, { headers: { 'User-Agent': 'ipatool-gui' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      httpsGetFollowRedirects(res.headers.location, callback);
    } else {
      callback(null, res);
    }
  }).on('error', (err) => {
    callback(err, null);
  });
}

function killIpatoolProcessForcefully() {
  return new Promise((resolve) => {
    // 1. Kill tracked read-only processes
    try {
      if (activeReadOnlyProcesses && activeReadOnlyProcesses.length > 0) {
        activeReadOnlyProcesses.forEach(p => {
          try { p.kill('SIGKILL'); } catch (_) {}
        });
        activeReadOnlyProcesses = [];
      }
    } catch (_) {}

    // 2. Kill auth process
    try {
      if (activeAuthProcess) {
        try { activeAuthProcess.kill('SIGKILL'); } catch (_) {}
        activeAuthProcess = null;
      }
    } catch (_) {}

    // 3. Kill download processes
    try {
      if (activeDownloadProcesses && activeDownloadProcesses.size > 0) {
        for (const [tid, p] of activeDownloadProcesses.entries()) {
          try { p.kill('SIGKILL'); } catch (_) {}
        }
        activeDownloadProcesses.clear();
      }
    } catch (_) {}

    // Forcefully kill any running ipatool processes on the system
    const proc = spawn('powershell', ['-Command', 'Stop-Process -Name ipatool -Force -ErrorAction SilentlyContinue'], { windowsHide: true });
    proc.on('close', () => {
      // Wait a tiny bit for OS file handles to release
      setTimeout(resolve, 500);
    });
    proc.on('error', () => {
      resolve();
    });
  });
}

function getBundledPath() {
  return app.isPackaged 
    ? path.join(process.resourcesPath, 'bin', 'ipatool.exe') 
    : path.join(__dirname, 'bin', 'ipatool.exe');
}

function getLocalIpatoolVersion() {
  return new Promise((resolve) => {
    const targetPath = getBundledPath();
    if (!fs.existsSync(targetPath)) {
      resolve('Not Installed');
      return;
    }
    execFile(targetPath, ['--version'], { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        resolve('Unknown');
        return;
      }
      const output = ((stdout || '') + '\n' + (stderr || '')).trim();
      const match = output.match(/\bversion\s+([^\s\r\n]+)/i) ||
        output.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/i);
      resolve(match && match[1] ? 'v' + match[1].trim().replace(/^v/i, '') : 'Unknown');
    });
  });
}


// Official majd/ipatool release downloader (Yuubagi patch)
function getGitHubJson(apiPath) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'User-Agent': 'Yuubagi-ipatool-gui',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (_) {
          reject(new Error('GitHub API returned invalid JSON (HTTP ' + res.statusCode + ')'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(json.message || ('GitHub API HTTP ' + res.statusCode)));
          return;
        }
        resolve(json);
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error('GitHub API request timed out')));
    request.on('error', reject);
  });
}

function downloadReleaseAssetToFile(url, filePath, sendLog) {
  return new Promise((resolve, reject) => {
    httpsGetFollowRedirects(url, (err, res) => {
      if (err) return reject(err);
      if (!res || res.statusCode !== 200) {
        const status = res ? res.statusCode : 'no response';
        if (res) res.resume();
        return reject(new Error('Release asset download failed: HTTP ' + status));
      }

      const totalBytes = Number(res.headers['content-length'] || 0);
      let downloadedBytes = 0;
      let lastProgress = -1;
      const fileStream = fs.createWriteStream(filePath);
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percentage = Math.floor((downloadedBytes / totalBytes) * 100);
          if (percentage !== lastProgress && percentage % 10 === 0) {
            lastProgress = percentage;
            sendLog('Download progress: ' + percentage + '% (' +
              (downloadedBytes / 1048576).toFixed(1) + ' MB / ' +
              (totalBytes / 1048576).toFixed(1) + ' MB)');
          }
        }
      });
      res.on('error', (streamError) => fileStream.destroy(streamError));
      fileStream.on('error', reject);
      fileStream.on('finish', () => fileStream.close((closeError) => closeError ? reject(closeError) : resolve()));
      res.pipe(fileStream);
    });
  });
}

function runTarExtract(archivePath, destination) {
  return new Promise((resolve, reject) => {
    // Windows 10/11 ships tar.exe; the official ipatool release is a tar.gz archive.
    execFile('tar', ['-xzf', archivePath, '-C', destination], { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('Could not extract the official ipatool archive: ' + (stderr || error.message).trim()));
      } else {
        resolve();
      }
    });
  });
}

function readIpatoolVersion(exePath) {
  return new Promise((resolve, reject) => {
    execFile(exePath, ['--version'], { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('Downloaded ipatool.exe could not run: ' + (stderr || error.message).trim()));
        return;
      }
      const output = ((stdout || '') + '\n' + (stderr || '')).trim();
      const match = output.match(/(?:version\s*)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
      if (!match) {
        reject(new Error('Could not determine downloaded ipatool version. Output: ' + (output || '(empty)')));
        return;
      }
      resolve(match[1]);
    });
  });
}

async function downloadBinary(event, version) {
  const sendLog = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-log', msg);
    }
  };

  let archivePath = null;
  let checksumPath = null;
  let extractDir = null;
  let stagedExePath = null;
  let backupExePath = null;
  try {
    const cleanVersion = version ? String(version).replace(/^v/i, '').trim() : '';
    const releasePath = cleanVersion
      ? '/repos/' + IPATOOL_REPO + '/releases/tags/v' + encodeURIComponent(cleanVersion)
      : '/repos/' + IPATOOL_REPO + '/releases/latest';

    sendLog('Checking official release: ' + IPATOOL_REPO);
    const release = await getGitHubJson(releasePath);
    const releaseTag = String(release.tag_name || '').trim();
    const targetVersion = releaseTag.replace(/^v/i, '');
    if (!targetVersion || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion)) {
      throw new Error('The official GitHub release has an invalid tag: ' + (releaseTag || '(missing)'));
    }

    let windowsArch;
    if (process.arch === 'x64') windowsArch = 'amd64';
    else if (process.arch === 'arm64') windowsArch = 'arm64';
    else throw new Error('Unsupported Windows architecture: ' + process.arch + '. Supported architectures are amd64 and arm64.');

    const assetName = 'ipatool-' + targetVersion + '-windows-' + windowsArch + '.tar.gz';
    const asset = Array.isArray(release.assets) ? release.assets.find((item) => item.name === assetName) : null;
    if (!asset || !asset.browser_download_url) {
      const available = Array.isArray(release.assets)
        ? release.assets.map((item) => item.name).filter((name) => /windows.*(tar\.gz|zip)/i.test(name)).join(', ')
        : 'no release assets were listed';
      throw new Error('Official Windows asset not found: ' + assetName + '. Available Windows assets: ' + (available || 'none'));
    }

    const resourcesDir = app.isPackaged ? process.resourcesPath : __dirname;
    const resourcesBinDir = path.join(resourcesDir, 'bin');
    const targetExePath = path.join(resourcesBinDir, 'ipatool.exe');
    const workingDir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(resourcesBinDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });

    archivePath = path.join(workingDir, assetName + '.download');
    extractDir = path.join(workingDir, 'extract-' + targetVersion + '-' + Date.now());
    stagedExePath = path.join(resourcesBinDir, 'ipatool-' + targetVersion + '-staged.exe');
    fs.mkdirSync(extractDir, { recursive: true });

    sendLog('Official release: ' + releaseTag);
    sendLog('Asset: ' + assetName);
    sendLog('URL: ' + asset.browser_download_url);
    await downloadReleaseAssetToFile(asset.browser_download_url, archivePath, sendLog);

    let expectedDigest = '';
    if (asset.digest && /^sha256:/i.test(asset.digest)) {
      expectedDigest = asset.digest.split(':').slice(1).join(':').toLowerCase();
    } else {
      const checksumAsset = Array.isArray(release.assets)
        ? release.assets.find((item) => item.name === assetName + '.sha256sum')
        : null;
      if (checksumAsset && checksumAsset.browser_download_url) {
        checksumPath = path.join(workingDir, assetName + '.sha256sum');
        await downloadReleaseAssetToFile(checksumAsset.browser_download_url, checksumPath, sendLog);
        const checksumText = fs.readFileSync(checksumPath, 'utf8');
        const checksumMatch = checksumText.match(/\b([a-f0-9]{64})\b/i);
        if (!checksumMatch) throw new Error('The official checksum file for ' + assetName + ' is malformed.');
        expectedDigest = checksumMatch[1].toLowerCase();
      }
    }

    if (expectedDigest) {
      const crypto = require('crypto');
      const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
      if (actualDigest !== expectedDigest) {
        throw new Error('SHA-256 mismatch for ' + assetName + '. The old binary was not changed.');
      }
      sendLog('Archive SHA-256 verified.');
    } else {
      throw new Error('The official release did not provide a SHA-256 digest; refusing to replace the existing binary.');
    }

    sendLog('Extracting official Windows archive...');
    await runTarExtract(archivePath, extractDir);
    const extractedExe = findBinaryRecursive(extractDir, 'ipatool.exe');
    if (!extractedExe) throw new Error('ipatool.exe was not found inside the official release archive.');

    const extractedVersion = await readIpatoolVersion(extractedExe);
    if (extractedVersion !== targetVersion) {
      throw new Error('Version verification failed: release is ' + targetVersion +
        ', executable reports ' + extractedVersion + '. The old binary was not changed.');
    }
    sendLog('Executable verified: ipatool v' + extractedVersion);

    fs.copyFileSync(extractedExe, stagedExePath);
    await killIpatoolProcessForcefully();

    if (fs.existsSync(targetExePath)) {
      backupExePath = targetExePath + '.backup-' + Date.now();
      fs.renameSync(targetExePath, backupExePath);
    }
    try {
      fs.renameSync(stagedExePath, targetExePath);
      stagedExePath = null;
    } catch (replaceError) {
      if (backupExePath && fs.existsSync(backupExePath) && !fs.existsSync(targetExePath)) {
        try {
          fs.renameSync(backupExePath, targetExePath);
          backupExePath = null;
        } catch (_) {}
      }
      throw replaceError;
    }

    if (backupExePath && fs.existsSync(backupExePath)) {
      try { fs.unlinkSync(backupExePath); backupExePath = null; }
      catch (_) { sendLog('Warning: old binary backup was left at ' + backupExePath); }
    }

    saveInstalledCliVersion(targetVersion);
    sendLog('Official ipatool v' + targetVersion + ' installed successfully.');
    return { success: true, version: targetVersion };
  } catch (error) {
    sendLog('Official ipatool update failed: ' + error.message);
    return { success: false, error: error.message };
  } finally {
    for (const tempPath of [archivePath, checksumPath, extractDir, stagedExePath]) {
      if (!tempPath) continue;
      try {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true }); }
      catch (_) {}
    }
  }
}

function findBinaryRecursive(dir, filename) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        // Match either the exact requested filename or any filename starting with ipatool and ending with .exe
        if (lowerName === filename.toLowerCase() || (lowerName.startsWith('ipatool') && lowerName.endsWith('.exe'))) {
          return fullPath;
        }
      }
      if (entry.isDirectory()) {
        const result = findBinaryRecursive(fullPath, filename);
        if (result) return result;
      }
    }
  } catch (_) {
    /* ignore access errors */
  }
  return null;
}

// ── CLI Wrapper ────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const os = require('os');
let ipatoolQueue = Promise.resolve();

function redactCliOutput(value) {
  return String(value || '')
    .replace(/("(?:set-cookie|cookie|x-token|authorization|passwordtoken|directoryservicesid|icloud-dsid|x-dsid)"\s*:\s*)("[^"]*"|[^,}\s]+)/gi, '$1"[REDACTED]"')
    .replace(/\b(Set-Cookie|Cookie|X-Token|Authorization|PasswordToken|DirectoryServicesID|iCloud-DSID|X-Dsid)\s*[:=]\s*([^,\r\n]+)/gi, '$1=[REDACTED]');
}

/**
 * Direct execution of ipatool command.
 */
function runIpatoolDirect(args, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const fullArgs = [
      ...args,
      '--format', 'json',
      '--non-interactive',
      '--keychain-passphrase', KEYCHAIN_PASSPHRASE,
    ];

    execFile(binaryPath, fullArgs, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // If the process produced output before erroring, include it
        const output = redactCliOutput((stdout || '') + (stderr || ''));
        resolve({
          success: false,
          output: output || redactCliOutput(err.message),
          error: redactCliOutput(err.message),
        });
        return;
      }
      resolve({
        success: true,
        output: redactCliOutput((stdout || '').trim()),
      });
    });
  });
}

let activeReadOnlyProcesses = [];

/**
 * Run ipatool in a completely isolated temp home directory to avoid lock file conflicts.
 */
function runIpatoolIsolated(args, options = {}) {
  return new Promise((resolve) => {
    const tempHome = path.join(os.tmpdir(), `ipatool-isolated-${Date.now()}-${Math.random().toString(36).substring(2)}`);
    const tempIpatoolDir = path.join(tempHome, '.ipatool');
    
    try {
      fs.mkdirSync(tempIpatoolDir, { recursive: true });
      
      const masterDir = path.join(os.homedir(), '.ipatool');
      const filesToCopy = ['account', 'cookies'];
      for (const file of filesToCopy) {
        const srcPath = path.join(masterDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, path.join(tempIpatoolDir, file));
        }
      }
    } catch (err) {
      resolve({
        success: false,
        output: '',
        error: `Failed to initialize isolated environment: ${err.message}`
      });
      return;
    }

    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const fullArgs = [
      ...args,
      '--format', 'json',
      '--non-interactive',
      '--keychain-passphrase', KEYCHAIN_PASSPHRASE,
    ];

    let drive = '';
    let restPath = tempHome;
    if (tempHome.charAt(1) === ':') {
      drive = tempHome.substring(0, 2);
      restPath = tempHome.substring(2);
    }

    const env = {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      HOMEDRIVE: drive,
      HOMEPATH: restPath,
    };

    const proc = execFile(binaryPath, fullArgs, { timeout, env, windowsHide: true }, (err, stdout, stderr) => {
      // Remove from active processes list
      activeReadOnlyProcesses = activeReadOnlyProcesses.filter(p => p !== proc);

      // Async cleanup
      try {
        fs.rm(tempHome, { recursive: true, force: true }, () => {});
      } catch (_) {}

      if (err) {
        const output = redactCliOutput((stdout || '') + (stderr || ''));
        resolve({
          success: false,
          output: output || redactCliOutput(err.message),
          error: redactCliOutput(err.message),
        });
        return;
      }
      resolve({
        success: true,
        output: redactCliOutput((stdout || '').trim()),
      });
    });

    activeReadOnlyProcesses.push(proc);
  });
}

/**
 * Route commands: read-only run concurrently (isolated), writes run sequentially.
 */
function runIpatool(args, options = {}) {
  const cmd = args[0];
  const isReadOnly = cmd === 'search' || cmd === 'list-versions' || cmd === 'get-version-metadata' || (cmd === 'auth' && args[1] === 'info');

  if (isReadOnly) {
    return runIpatoolIsolated(args, options);
  } else {
    const run = async () => {
      // Add 150ms delay to let OS release locks completely
      await delay(150);
      return runIpatoolDirect(args, options);
    };
    ipatoolQueue = ipatoolQueue.then(run, run);
    return ipatoolQueue;
  }
}

// ── Auth Login with 2FA Support ────────────────────────────────────────────────
let activeAuthProcess = null;

function authLogin(email, password) {
  return new Promise((resolve) => {
    // Kill any lingering auth process
    if (activeAuthProcess) {
      try {
        activeAuthProcess.kill();
      } catch (_) {
        /* ignore */
      }
      activeAuthProcess = null;
    }

    const args = [
      'auth', 'login',
      '--email', email,
      '--password', password,
      '--format', 'json',
      '--keychain-passphrase', KEYCHAIN_PASSPHRASE,
    ];

    const proc = spawn(binaryPath, args, { windowsHide: true });
    activeAuthProcess = proc;

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        activeAuthProcess = null;
        resolve({
          success: false,
          output: stdout + stderr,
          error: 'Login timed out after 5 minutes',
        });
      }
    }, AUTH_TIMEOUT);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();

      // Check if 2FA is needed — ipatool asks for the code on stdout
      const combined = stdout.toLowerCase();
      if (combined.includes('2fa') || combined.includes('two-factor') || combined.includes('verification code') || combined.includes('code:')) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Don't kill the process — we need it alive for 2FA input
          resolve({
            success: false,
            output: stdout,
            needs2FA: true,
          });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();

      // Also check stderr for 2FA prompts
      const combined = stderr.toLowerCase();
      if (combined.includes('2fa') || combined.includes('two-factor') || combined.includes('verification code') || combined.includes('code:')) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            output: stdout + stderr,
            needs2FA: true,
          });
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeAuthProcess = null;
      if (!resolved) {
        resolved = true;
        resolve({
          success: code === 0,
          output: (stdout + stderr).trim(),
          error: code !== 0 ? `Process exited with code ${code}` : undefined,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeAuthProcess = null;
      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          output: stdout + stderr,
          error: err.message,
        });
      }
    });
  });
}

function auth2FA(code) {
  return new Promise((resolve) => {
    if (!activeAuthProcess || activeAuthProcess.killed) {
      resolve({
        success: false,
        output: '',
        error: 'No active auth process. Please start login again.',
      });
      return;
    }

    const proc = activeAuthProcess;
    let additionalOutput = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill();
        } catch (_) {
          /* ignore */
        }
        activeAuthProcess = null;
        resolve({
          success: false,
          output: additionalOutput,
          error: '2FA verification timed out',
        });
      }
    }, AUTH_TIMEOUT);

    // Collect any further output after writing the code
    const onStdout = (data) => {
      additionalOutput += data.toString();
    };
    const onStderr = (data) => {
      additionalOutput += data.toString();
    };

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);
      activeAuthProcess = null;
      if (!resolved) {
        resolved = true;
        resolve({
          success: exitCode === 0,
          output: additionalOutput.trim(),
          error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeAuthProcess = null;
      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          output: additionalOutput,
          error: err.message,
        });
      }
    });

    // Write the 2FA code to stdin
    try {
      proc.stdin.write(code + '\n');
    } catch (err) {
      clearTimeout(timeout);
      activeAuthProcess = null;
      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          output: additionalOutput,
          error: `Failed to send 2FA code: ${err.message}`,
        });
      }
    }
  });
}

// ── Download IPA with Streaming Output ─────────────────────────────────────────
const activeDownloadProcesses = new Map();
let purchaseLock = Promise.resolve();

function serializedPurchase(bundleId, appId, appPrice) {
  return new Promise((resolve) => {
    purchaseLock = purchaseLock.then(async () => {
      try {
        if (Number.isFinite(appPrice) && appPrice > 0) {
          resolve({ success: true, skipped: true, output: 'Paid app detected; automatic license acquisition skipped.' });
          return;
        }
        const args = ['purchase'];
        if (appId && Number.isSafeInteger(Number(appId)) && Number(appId) > 0 && appPrice === 0) {
          args.push('--app-id', String(Number(appId)));
        } else {
          args.push('--bundle-identifier', bundleId);
        }
        args.push('--platform', 'iphone');
        resolve(await runIpatool(args));
      } catch (err) {
        resolve({ success: false, output: '', error: err.message });
      }
    }).catch((err) => resolve({ success: false, output: '', error: err.message }));
  });
}

function downloadIpa(taskId, bundleId, appId, appPrice, outputDir, purchaseFlag, versionId) {
  return new Promise(async (resolve) => {
    if (purchaseFlag) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('command-output', { taskId, line: 'Checking/Acquiring application license (serialized purchase)...' });
      }
      const purchaseResult = await serializedPurchase(bundleId, appId, appPrice);
      if (purchaseResult && !purchaseResult.success) {
        const details = [purchaseResult.output, purchaseResult.error].filter(Boolean).join('\n').trim();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('command-output', {
            taskId,
            line: '❌ License acquisition failed. Download was stopped; see the ipatool response below.',
          });
          if (details) {
            details.split(/\r?\n/).filter(Boolean).forEach((line) => {
              mainWindow.webContents.send('command-output', { taskId, line: redactCliOutput(line) });
            });
          }
        }
        return resolve({
          success: false,
          output: redactCliOutput(details),
          error: 'License acquisition failed. See the ipatool response above.',
        });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        const message = purchaseResult && purchaseResult.skipped
          ? 'ℹ️ Paid app detected; automatic purchase was skipped.'
          : '✅ License acquired or verified successfully.';
        mainWindow.webContents.send('command-output', { taskId, line: message });
      }
    }

    const taskTempDir = path.join(outputDir, '.tmp-ipatool-' + taskId);
    try {
      if (!fs.existsSync(taskTempDir)) fs.mkdirSync(taskTempDir, { recursive: true });
    } catch (err) {
      return resolve({
        success: false,
        output: '',
        error: 'Failed to create isolated temp workspace: ' + err.message,
      });
    }

    const args = ['download'];
    if (appId && Number.isSafeInteger(Number(appId)) && Number(appId) > 0) {
      args.push('--app-id', String(Number(appId)));
    } else {
      args.push('--bundle-identifier', bundleId);
    }
    args.push(
      '--platform', 'iphone',
      '--output', taskTempDir,
      '--format', 'json',
      '--non-interactive',
      '--keychain-passphrase', KEYCHAIN_PASSPHRASE
    );
    if (versionId) args.push('--external-version-id', String(versionId));

    const proc = spawn(binaryPath, args, { windowsHide: true });
    activeDownloadProcesses.set(taskId, proc);
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      try {
        if (fs.existsSync(taskTempDir)) fs.rmSync(taskTempDir, { recursive: true, force: true });
      } catch (_) {}
      resolve({
        success: false,
        output: redactCliOutput(stdout + stderr),
        error: 'Download timed out after 5 minutes',
      });
    }, DOWNLOAD_TIMEOUT);

    proc.stdout.on('data', (data) => {
      const text = redactCliOutput(data.toString());
      stdout += text;
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      for (const line of lines) {
        if (line.startsWith('{"type":"progress"') || line.startsWith('{"type": "progress"')) {
          try {
            const progressData = JSON.parse(line);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-progress', { taskId, percentage: progressData.percentage });
            }
          } catch (_) {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('command-output', { taskId, line });
          }
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('command-output', { taskId, line });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = redactCliOutput(data.toString());
      stderr += text;
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      for (const line of lines) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('command-output', { taskId, line });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      activeDownloadProcesses.delete(taskId);
      if (code === 0) {
        try {
          const files = fs.readdirSync(taskTempDir);
          const ipaFile = files.find((file) => file.toLowerCase().endsWith('.ipa'));
          if (ipaFile) {
            const srcPath = path.join(taskTempDir, ipaFile);
            // The CLI uses numeric ID in the file name if --app-id was used.
            const finalFileName = appId
              ? ipaFile.replace(new RegExp('^' + String(Number(appId)) + '(?=_)'), bundleId)
              : ipaFile;
            const destPath = path.join(outputDir, finalFileName);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(srcPath, destPath);
            fs.rmSync(taskTempDir, { recursive: true, force: true });
            resolve({
              success: true,
              output: JSON.stringify({ success: true, path: destPath }),
              error: undefined,
            });
          } else {
            fs.rmSync(taskTempDir, { recursive: true, force: true });
            resolve({
              success: false,
              output: redactCliOutput((stdout + stderr).trim()),
              error: 'Download succeeded but could not locate the .ipa package in workspace',
            });
          }
        } catch (err) {
          try {
            if (fs.existsSync(taskTempDir)) fs.rmSync(taskTempDir, { recursive: true, force: true });
          } catch (_) {}
          resolve({
            success: false,
            output: redactCliOutput((stdout + stderr).trim()),
            error: 'Failed to finalize downloaded package: ' + err.message,
          });
        }
      } else {
        try {
          if (fs.existsSync(taskTempDir)) fs.rmSync(taskTempDir, { recursive: true, force: true });
        } catch (_) {}
        resolve({
          success: false,
          output: redactCliOutput((stdout + stderr).trim()),
          error: 'Process exited with code ' + code,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeDownloadProcesses.delete(taskId);
      try {
        if (fs.existsSync(taskTempDir)) fs.rmSync(taskTempDir, { recursive: true, force: true });
      } catch (_) {}
      resolve({
        success: false,
        output: redactCliOutput(stdout + stderr),
        error: redactCliOutput(err.message),
      });
    });
  });
}

// ── IPC Handlers ───────────────────────────────────────────────────────────────

// Binary management
ipcMain.handle('check-binary', () => {
  return { exists: binaryExists(), path: binaryPath };
});

ipcMain.handle('download-binary', async (event, { version } = {}) => {
  try {
    return await downloadBinary(event, version);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-local-cli-version', async () => {
  try {
    return await getLocalIpatoolVersion();
  } catch (err) {
    return 'Unknown';
  }
});

// Auth
ipcMain.handle('auth-login', async (_event, { email, password }) => {
  try {
    const res = await authLogin(email, password);
    if (res && res.success) {
      detectAndSyncStorefrontRegion();
    }
    return res;
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

ipcMain.handle('auth-2fa', async (_event, { code }) => {
  try {
    return await auth2FA(code);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

ipcMain.handle('cancel-auth', () => {
  if (activeAuthProcess) {
    try {
      activeAuthProcess.kill();
    } catch (_) {}
    activeAuthProcess = null;
  }
  return { success: true };
});

ipcMain.handle('auth-info', async () => {
  try {
    return await runIpatool(['auth', 'info']);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

ipcMain.handle('auth-revoke', async () => {
  try {
    return await runIpatool(['auth', 'revoke']);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// Enrich search output with artwork from public iTunes API
async function enrichSearchOutput(output, country = '') {
  if (!output) return output;
  const lines = output.split('\n');
  const enrichedLines = [];
  const parsedLines = [];
  const appIds = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      parsedLines.push({ isJson: false, raw: line });
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      parsedLines.push({ isJson: true, data: parsed, raw: line });
      if (parsed && Array.isArray(parsed.apps)) {
        for (const app of parsed.apps) {
          if (app.id) {
            appIds.push(app.id);
          }
        }
      }
    } catch (e) {
      parsedLines.push({ isJson: false, raw: line });
    }
  }

  if (appIds.length === 0) {
    return output;
  }

  let targetCountry = country;
  if (!targetCountry) {
    try {
      const result = await runIpatool(['auth', 'info']);
      if (result && result.success && result.output) {
        const match = result.output.match(/storeFront=([^\s\r\n]+)/) || result.output.match(/"storeFront"\s*:\s*"([^"]+)"/);
        if (match && match[1]) {
          const sfId = match[1].trim().split('-')[0];
          targetCountry = STOREFRONT_MAP[sfId];
        }
      }
    } catch (_) {}
  }
  if (!targetCountry) {
    targetCountry = 'us';
  }

  const artworkMap = new Map();
  try {
    const url = `https://itunes.apple.com/lookup?id=${appIds.join(',')}&country=${targetCountry.toLowerCase()}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.results)) {
        for (const item of data.results) {
          if (item.trackId && item.artworkUrl100) {
            artworkMap.set(item.trackId, item.artworkUrl100);
          }
        }
      }
    }
  } catch (err) {
    // Fail silently, returning original search results without logos
  }

  for (const line of parsedLines) {
    if (line.isJson) {
      const parsed = line.data;
      if (parsed && Array.isArray(parsed.apps)) {
        for (const app of parsed.apps) {
          if (app.id && artworkMap.has(app.id)) {
            const url = artworkMap.get(app.id);
            app.artworkUrl = url;
            app.artworkURL = url;
            app.artworkUrl100 = url;
          }
        }
      }
      enrichedLines.push(JSON.stringify(parsed));
    } else {
      enrichedLines.push(line.raw);
    }
  }

  return enrichedLines.join('\n');
}

// Search. The official ipatool CLI no longer accepts --country;
// use Apple's public Search API for an explicitly selected storefront.
ipcMain.handle('search', async (_event, { query, limit, country }) => {
  try {
    const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 5));
    if (country) {
      const searchUrl = new URL('https://itunes.apple.com/search');
      searchUrl.searchParams.set('term', String(query || ''));
      searchUrl.searchParams.set('country', String(country).toLowerCase());
      searchUrl.searchParams.set('entity', 'software');
      searchUrl.searchParams.set('limit', String(safeLimit));

      const response = await fetch(searchUrl.toString(), {
        headers: { 'User-Agent': 'Yuubagi-ipatool-gui' },
      });
      if (!response.ok) throw new Error('Apple Search API returned HTTP ' + response.status);
      const payload = await response.json();
      const apps = (Array.isArray(payload.results) ? payload.results : [])
        .filter((item) => item && item.bundleId && item.trackId)
        .map((item) => ({
          id: item.trackId,
          name: item.trackName || item.trackCensoredName || 'Unknown App',
          trackName: item.trackName || item.trackCensoredName || 'Unknown App',
          bundleID: item.bundleId,
          bundleId: item.bundleId,
          version: item.version || '—',
          price: typeof item.price === 'number' ? item.price : undefined,
          formattedPrice: item.formattedPrice || '',
          artworkURL: item.artworkUrl512 || item.artworkUrl100 || '',
          artworkUrl: item.artworkUrl512 || item.artworkUrl100 || '',
          artworkUrl100: item.artworkUrl100 || item.artworkUrl512 || '',
        }));
      return { success: true, output: JSON.stringify({ resultCount: apps.length, apps }) };
    }

    // With no region override, ipatool uses the logged-in Apple ID storefront.
    const result = await runIpatool(['search', String(query || ''), '--limit', String(safeLimit)]);
    if (result && result.success && result.output) {
      result.output = await enrichSearchOutput(result.output, '');
    }
    return result;
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// Purchase
ipcMain.handle('purchase', async (_event, { bundleId, appId, appPrice }) => {
  try {
    const args = ['purchase'];
    if (appId && Number.isSafeInteger(Number(appId)) && Number(appId) > 0 && appPrice === 0) args.push('--app-id', String(Number(appId)));
    else args.push('--bundle-identifier', bundleId);
    args.push('--platform', 'iphone');
    return await runIpatool(args);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// Download IPA
ipcMain.handle('download-ipa', async (_event, { taskId, bundleId, appId, appPrice, outputDir, purchase, versionId }) => {
  try {
    return await downloadIpa(taskId, bundleId, appId, appPrice, outputDir, purchase, versionId);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// List versions
ipcMain.handle('list-versions', async (_event, { bundleId }) => {
  try {
    return await runIpatool(['list-versions', '--bundle-identifier', bundleId]);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// Get version metadata
ipcMain.handle('get-version-metadata', async (_event, { bundleId, versionId }) => {
  try {
    return await runIpatool(['get-version-metadata', '--bundle-identifier', bundleId, '--external-version-id', String(versionId)]);
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
});

// Directory picker
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return { path: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Output Directory',
  });
  return { path: result.canceled ? null : result.filePaths[0] };
});

// Open file location
ipcMain.handle('open-file-location', async (_event, { path: filePath }) => {
  try {
    shell.showItemInFolder(path.normalize(filePath));
  } catch (err) {
    console.error('Failed to open file location:', err.message);
  }
});

// Settings
ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('save-settings', (_event, settings) => {
  const success = saveSettings(settings);
  return { success };
});

// Cancel download
ipcMain.handle('cancel-download', async (_event, { taskId } = {}) => {
  if (taskId && activeDownloadProcesses.has(taskId)) {
    const proc = activeDownloadProcesses.get(taskId);
    if (proc && !proc.killed) {
      try {
        // Resume first in case it's suspended, to ensure clean termination on Windows
        await resumeProcess(proc.pid);
        proc.kill();
        activeDownloadProcesses.delete(taskId);
        return { success: true };
      } catch (err) {
        // Fallback directly to kill
        try {
          proc.kill();
        } catch (_) {}
        activeDownloadProcesses.delete(taskId);
        return { success: true };
      }
    }
  }
  return { success: false, error: 'No active download process with specified Task ID found' };
});

// OS-Level Process Suspend/Resume Helpers for Windows
function suspendProcess(pid) {
  return new Promise((resolve) => {
    const code = `
      $member = '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr hProcess);'
      $type = Add-Type -MemberDefinition $member -Name 'ntdll' -Namespace 'Win32' -PassThru
      $proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($proc) {
        [void]$type::NtSuspendProcess($proc.Handle)
        exit 0
      } else {
        exit 1
      }
    `;
    const child = spawn('powershell', ['-Command', code], { windowsHide: true });
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

function resumeProcess(pid) {
  return new Promise((resolve) => {
    const code = `
      $member = '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr hProcess);'
      $type = Add-Type -MemberDefinition $member -Name 'ntdll' -Namespace 'Win32' -PassThru
      $proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($proc) {
        [void]$type::NtResumeProcess($proc.Handle)
        exit 0
      } else {
        exit 1
      }
    `;
    const child = spawn('powershell', ['-Command', code], { windowsHide: true });
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

// Pause download
ipcMain.handle('pause-download', async (_event, { taskId } = {}) => {
  if (taskId && activeDownloadProcesses.has(taskId)) {
    const proc = activeDownloadProcesses.get(taskId);
    if (proc && !proc.killed) {
      const success = await suspendProcess(proc.pid);
      return { success };
    }
  }
  return { success: false, error: 'No active download process with specified Task ID found' };
});

// Resume download
ipcMain.handle('resume-download', async (_event, { taskId } = {}) => {
  if (taskId && activeDownloadProcesses.has(taskId)) {
    const proc = activeDownloadProcesses.get(taskId);
    if (proc && !proc.killed) {
      const success = await resumeProcess(proc.pid);
      return { success };
    }
  }
  return { success: false, error: 'No active download process with specified Task ID found' };
});

// Cancel version details
ipcMain.handle('cancel-version-details', () => {
  for (const proc of activeReadOnlyProcesses) {
    try {
      proc.kill();
    } catch (_) {}
  }
  activeReadOnlyProcesses = [];
  return { success: true };
});

// Clean up interrupted or temporary download files
ipcMain.handle('clean-temp-files', async () => {
  try {
    let deletedCount = 0;
    
    // 1. Get output directory from settings
    const settings = loadSettings();
    const outputDir = settings.outputDir || app.getPath('downloads');
    
    // 2. Scan output directory for any *.ipa.tmp files
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.ipa.tmp')) {
          const filePath = path.join(outputDir, file);
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (e) {
            console.error(`Failed to delete temp file ${filePath}:`, e.message);
          }
        }
      }
    }
    
    // 3. Scan system temp directory for ipatool temp directories/files
    const sysTempDir = os.tmpdir();
    if (fs.existsSync(sysTempDir)) {
      const tempEntries = fs.readdirSync(sysTempDir);
      for (const entry of tempEntries) {
        const lowerEntry = entry.toLowerCase();
        if (lowerEntry.startsWith('ipatool-isolated-') || lowerEntry.startsWith('ipatool-') || lowerEntry.endsWith('.ipa.tmp')) {
          const fullPath = path.join(sysTempDir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
              deletedCount++;
            } else if (stat.isFile()) {
              fs.unlinkSync(fullPath);
              deletedCount++;
            }
          } catch (e) {
            console.error(`Failed to delete sys temp entry ${fullPath}:`, e.message);
          }
        }
      }
    }
    
    return { success: true, deletedCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});



// Fetch the latest CLI version from the official majd/ipatool release.
ipcMain.handle('fetch-ipatool-version', async () => {
  try {
    const release = await getGitHubJson('/repos/' + IPATOOL_REPO + '/releases/latest');
    return {
      success: true,
      tag: release.tag_name || 'unknown',
      releaseUrl: release.html_url || 'https://github.com/' + IPATOOL_REPO + '/releases',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Check GUI Updates from Yuubagi/ipatool-gui repository
ipcMain.handle('check-gui-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/' + GUI_REPO + '/releases/latest',
      headers: { 'User-Agent': 'ipatool-gui' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const latestVersion = json.tag_name ? json.tag_name.replace('v', '') : '1.0.0';
          const localVersion = app.getVersion() || '1.0.0';
          
          const latestParts = latestVersion.split('.').map(Number);
          const localParts = localVersion.split('.').map(Number);
          
          let downloadUrl = '';
          if (json.assets && Array.isArray(json.assets)) {
            const setupAsset = json.assets.find(asset => 
              asset.name.toLowerCase().includes('setup') && asset.name.toLowerCase().endsWith('.exe')
            );
            if (setupAsset) {
              downloadUrl = setupAsset.browser_download_url;
            }
          }

          let hasUpdate = false;
          for (let i = 0; i < Math.max(latestParts.length, localParts.length); i++) {
            const latestPart = latestParts[i] || 0;
            const localPart = localParts[i] || 0;
            if (latestPart > localPart) {
              hasUpdate = true;
              break;
            } else if (latestPart < localPart) {
              break;
            }
          }
          
          resolve({
            success: true,
            hasUpdate,
            latestVersion: json.tag_name || 'unknown',
            localVersion: 'v' + localVersion,
            releaseUrl: json.html_url || ('https://github.com/' + GUI_REPO + '/releases'),
            downloadUrl: downloadUrl
          });
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse update info' });
        }
      });
    }).on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

let activeGuiUpdateDownload = null;

function downloadGuiUpdate(url) {
  return new Promise((resolve) => {
    const tempDir = app.getPath('temp');
    const installerPath = path.join(tempDir, 'ipatool-gui-update-setup.exe');

    const sendProgress = (percentage) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gui-update-progress', percentage);
      }
    };

    httpsGetFollowRedirects(url, (err, res) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }

      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}` });
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      const fileStream = fs.createWriteStream(installerPath);

      activeGuiUpdateDownload = fileStream;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = Math.floor((downloadedBytes / totalBytes) * 100);
          sendProgress(progress);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          activeGuiUpdateDownload = null;

          // Launch the installer silently in the background
          try {
            const { spawn } = require('child_process');
            const child = spawn(installerPath, ['/S'], {
              detached: true,
              stdio: 'ignore',
              windowsHide: false
            });
            child.unref();
            
            // Exit Electron app immediately so the installer can overwrite the locked files
            setTimeout(() => {
              app.exit(0);
            }, 500);

            resolve({ success: true });
          } catch (spawnErr) {
            resolve({ success: false, error: `Failed to launch installer: ${spawnErr.message}` });
          }
        });
      });

      fileStream.on('error', (writeErr) => {
        activeGuiUpdateDownload = null;
        resolve({ success: false, error: writeErr.message });
      });
    });
  });
}

ipcMain.handle('download-gui-update', async (_event, { url }) => {
  try {
    return await downloadGuiUpdate(url);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Fetch GitHub avatar image as base64 for embedding
ipcMain.handle('fetch-github-avatar', (_event, { username }) => {
  return new Promise((resolve) => {
    const avatarUrl = `https://github.com/${username}.png?size=80`;
    httpsGetFollowRedirects(avatarUrl, (err, res) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}` });
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const contentType = res.headers['content-type'] || 'image/png';
        resolve({ success: true, dataUrl: `data:${contentType};base64,${base64}` });
      });
      res.on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
    });
  });
});

// Open external URL
ipcMain.handle('open-external', (_event, { url }) => {
  shell.openExternal(url);
});

// Window controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});
