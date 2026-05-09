const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Steam 优惠工具',
    backgroundColor: '#1b2838',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ── HTTP helper (uses Node https, no fetch dependency) ──

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function fetchSteamSearch(params) {
  const url = new URL('https://store.steampowered.com/search/results/');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const raw = await httpsGet(url.toString());
  return JSON.parse(raw);
}

// ── HTML parsing ──

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const games = [];

  $('a.search_result_row').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const appidMatch = href.match(/\/app\/(\d+)/);
    if (!appidMatch) return;

    const appid = appidMatch[1];
    const name = $el.find('.title').text().trim();
    const discountText = $el.find('.discount_pct').text().trim();
    const discountPercent = parseInt(discountText) || 0;
    const originalPrice = $el.find('.discount_original_price').text().trim();
    const finalPrice = $el.find('.discount_final_price').text().trim();
    const releaseDate = $el.find('.search_released').text().trim();
    const searchPrice = $el.find('.search_price').text().trim();

    games.push({
      appid,
      name,
      img: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      discountPercent: Math.abs(discountPercent),
      originalPrice: originalPrice || searchPrice || '',
      finalPrice: finalPrice || searchPrice || '',
      releaseDate,
    });
  });

  return games;
}

function parseChineseDate(str) {
  let match = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ── IPC handlers ──

ipcMain.handle('fetch-deals', async () => {
  const allGames = [];
  let start = 0;
  const batchSize = 100;

  for (let i = 0; i < 5; i++) {
    const data = await fetchSteamSearch({
      specials: '1',
      start: String(start),
      count: String(batchSize),
      cc: 'cn',
      l: 'schinese',
      infinite: '1',
      hidef2p: '1',
    });

    const games = parseSearchResults(data.results_html || '');
    const filtered = games.filter((g) => g.discountPercent >= 50);
    allGames.push(...filtered);

    if (games.length < batchSize) break;
    start += batchSize;
  }

  return allGames;
});

ipcMain.handle('fetch-new-releases', async () => {
  const allGames = [];
  let start = 0;
  const batchSize = 100;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (let i = 0; i < 5; i++) {
    const data = await fetchSteamSearch({
      sort_by: 'Released_DESC',
      category1: '998',
      start: String(start),
      count: String(batchSize),
      cc: 'cn',
      l: 'schinese',
      infinite: '1',
      hidef2p: '1',
    });

    const games = parseSearchResults(data.results_html || '');
    let hitOldGame = false;

    for (const g of games) {
      if (!g.releaseDate) {
        allGames.push(g);
        continue;
      }
      const parsed = parseChineseDate(g.releaseDate);
      if (parsed && parsed < sevenDaysAgo) {
        hitOldGame = true;
        break;
      }
      allGames.push(g);
    }

    if (hitOldGame || games.length < batchSize) break;
    start += batchSize;
  }

  return allGames;
});

ipcMain.handle('open-store', (_, appid) => {
  shell.openExternal(`steam://store/${appid}`);
});

ipcMain.handle('open-url', (_, url) => {
  shell.openExternal(url);
});

// ── CheapShark price info ──

const STORE_NAMES = {
  '1': 'Steam', '2': 'GamersGate', '3': 'GreenManGaming', '7': 'GOG',
  '11': 'Humble', '13': 'Uplay', '15': 'Fanatical', '21': 'WinGameStore',
  '23': 'GameBillet', '25': 'Epic Games', '27': 'Gamesplanet',
  '28': 'Gamesload', '29': '2Game', '30': 'IndieGala', '35': 'DreamGame',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchCheapSharkGameID(steamAppID) {
  try {
    const raw = await httpsGet(`https://www.cheapshark.com/api/1.0/games?steamAppID=${steamAppID}`);
    const arr = JSON.parse(raw);
    if (arr && arr.length > 0) return arr[0].gameID;
  } catch (_) {}
  return null;
}

async function fetchCheapSharkDetail(gameID) {
  try {
    const raw = await httpsGet(`https://www.cheapshark.com/api/1.0/games?id=${gameID}`);
    return JSON.parse(raw);
  } catch (_) {}
  return null;
}

ipcMain.handle('fetch-price-info', async (_, appids) => {
  const results = {};
  // Process in batches of 5 to avoid rate limiting
  for (let i = 0; i < appids.length; i += 5) {
    const batch = appids.slice(i, i + 5);
    const promises = batch.map(async (appid) => {
      const gameID = await fetchCheapSharkGameID(appid);
      if (!gameID) return;

      const detail = await fetchCheapSharkDetail(gameID);
      if (!detail) return;

      const info = {};

      // Historical low
      if (detail.cheapestPriceEver) {
        info.historicalLow = parseFloat(detail.cheapestPriceEver.price);
        info.historicalLowDate = detail.cheapestPriceEver.date
          ? new Date(detail.cheapestPriceEver.date * 1000).toLocaleDateString('zh-CN')
          : '';
      }

      // Current Steam price (USD) from CheapShark
      const steamDeal = (detail.deals || []).find((d) => d.storeID === '1');
      if (steamDeal) {
        info.steamPriceUSD = parseFloat(steamDeal.price);
      }

      // Cheapest non-Steam deal (CDKey)
      const nonSteamDeals = (detail.deals || []).filter((d) => d.storeID !== '1');
      if (nonSteamDeals.length > 0) {
        const cheapest = nonSteamDeals.reduce((a, b) =>
          parseFloat(a.price) <= parseFloat(b.price) ? a : b
        );
        info.cdkeyPrice = parseFloat(cheapest.price);
        info.cdkeyStore = STORE_NAMES[cheapest.storeID] || `Store#${cheapest.storeID}`;
        info.cdkeyDealID = cheapest.dealID;
      }

      results[appid] = info;
    });

    await Promise.all(promises);
    if (i + 5 < appids.length) await sleep(250);
  }
  return results;
});

// ── Version update check ──

const GITHUB_REPO = 'xianqiujys/SteamTool';

ipcMain.handle('get-current-version', () => {
  return app.getVersion();
});

ipcMain.handle('check-update', async () => {
  try {
    const raw = await httpsGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const release = JSON.parse(raw);
    const remoteVersion = (release.tag_name || '').replace(/^v/, '');
    const localVersion = app.getVersion();

    if (!remoteVersion) return { hasUpdate: false };

    const hasUpdate = compareVersions(remoteVersion, localVersion) > 0;

    let downloadUrl = release.html_url; // fallback to release page
    // Find .exe asset
    if (release.assets && release.assets.length > 0) {
      const exeAsset = release.assets.find((a) => a.name.endsWith('.exe'));
      if (exeAsset) {
        downloadUrl = exeAsset.browser_download_url;
      }
    }

    return {
      hasUpdate,
      currentVersion: localVersion,
      latestVersion: remoteVersion,
      downloadUrl,
      releaseNotes: release.body || '',
      releaseName: release.name || `v${remoteVersion}`,
    };
  } catch (err) {
    console.error('Update check failed:', err.message);
    return { hasUpdate: false, error: err.message };
  }
});

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ── App lifecycle ──

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
