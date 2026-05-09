const ITEMS_PER_PAGE = 20;

let dealsData = [];
let newReleasesData = [];
let currentTab = 'deals';
let currentPage = 1;
let priceInfoCache = {}; // { appid: { historicalLow, cdkeyPrice, ... } }

const $loading = document.getElementById('loading');
const $content = document.getElementById('content');
const $error = document.getElementById('error');
const $errorMsg = document.getElementById('error-msg');
const $grid = document.getElementById('grid');
const $pagination = document.getElementById('pagination');
const $stats = document.getElementById('stats');
const $tabs = document.querySelectorAll('.tab');

// Tab switching
$tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (tabName === currentTab) return;

    $tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tabName;
    currentPage = 1;
    render();
    loadPriceInfoForCurrentPage();
  });
});

function getCurrentData() {
  return currentTab === 'deals' ? dealsData : newReleasesData;
}

function getPageData() {
  const data = getCurrentData();
  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  return data.slice(start, start + ITEMS_PER_PAGE);
}

function render() {
  const data = getCurrentData();
  const totalPages = Math.max(1, Math.ceil(data.length / ITEMS_PER_PAGE));

  if (currentPage > totalPages) currentPage = totalPages;

  const pageData = getPageData();

  // Stats
  $stats.textContent = `共 ${data.length} 款游戏，第 ${currentPage}/${totalPages} 页`;

  // Cards
  $grid.innerHTML = '';
  if (data.length === 0) {
    $grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#8f98a0;padding:40px;">暂无数据</p>';
    $pagination.innerHTML = '';
    return;
  }

  for (const game of pageData) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.appid = game.appid;
    card.addEventListener('click', () => {
      window.steamAPI.openStore(game.appid);
    });

    let priceHTML = '';
    if (game.discountPercent > 0) {
      priceHTML = `
        <div class="card-price-row">
          <span class="discount-badge">-${game.discountPercent}%</span>
          <span class="price-original">${game.originalPrice}</span>
          <span class="price-final">${game.finalPrice}</span>
        </div>`;
    } else if (game.finalPrice) {
      priceHTML = `<div class="card-price-row"><span class="price-free">${game.finalPrice}</span></div>`;
    }

    // Price info placeholder (filled async)
    const priceInfo = priceInfoCache[game.appid];
    const extraHTML = buildPriceInfoHTML(priceInfo, game);

    card.innerHTML = `
      <img class="card-img" src="${game.img}" alt="${escapeHtml(game.name)}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 460 215%22><rect fill=%22%230e1a26%22 width=%22460%22 height=%22215%22/><text x=%2250%%22 y=%2250%%22 fill=%22%238f98a0%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2216%22>No Image</text></svg>'"/>
      <div class="card-body">
        <div class="card-name" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</div>
        <div class="card-date">${escapeHtml(game.releaseDate)}</div>
        ${priceHTML}
        <div class="card-extra" id="extra-${game.appid}">${extraHTML}</div>
      </div>`;

    $grid.appendChild(card);
    // Bind CDKey click events if data already cached
    if (priceInfo) {
      bindCdkeyClicks(card);
    }
  }

  // Pagination
  renderPagination(totalPages);
}

function parseCNYPrice(str) {
  if (!str) return 0;
  const m = str.replace(/[^0-9.]/g, '');
  return parseFloat(m) || 0;
}

function usdToCNY(usd, retailUSD, originalCNY) {
  // Convert USD price to approximate CNY using the ratio of known prices
  if (!retailUSD || !originalCNY) return null;
  return Math.round(originalCNY * (usd / retailUSD) * 100) / 100;
}

function formatCNY(val) {
  if (val === null || val === undefined) return '';
  return `¥${val.toFixed(2)}`;
}

function buildPriceInfoHTML(info, game) {
  if (!info) {
    return '<div class="price-loading">比价加载中...</div>';
  }

  let html = '';
  const originalCNY = parseCNYPrice(game.originalPrice);

  // Historical low badge — display in CNY
  if (info.historicalLowUSD !== undefined && info.retailPriceUSD) {
    const historicalLowCNY = usdToCNY(info.historicalLowUSD, info.retailPriceUSD, originalCNY);
    const currentCNY = parseCNYPrice(game.finalPrice);
    const isAtLow = currentCNY > 0 && historicalLowCNY !== null && currentCNY <= historicalLowCNY + 0.5;

    if (isAtLow) {
      html += `<div class="historical-low-row">
        <span class="badge-historical-low is-low">史低!</span>
        <span class="historical-low-detail">国区史低 ${formatCNY(historicalLowCNY)}</span>
      </div>`;
    } else if (historicalLowCNY !== null) {
      html += `<div class="historical-low-row">
        <span class="badge-historical-low">史低 ${formatCNY(historicalLowCNY)}</span>
        <span class="historical-low-detail">${info.historicalLowDate || ''}</span>
      </div>`;
    }
  }

  // CDKey cheapest — display in CNY, clickable
  if (info.cdkeyPriceUSD !== undefined && info.retailPriceUSD) {
    const cdkeyCNY = usdToCNY(info.cdkeyPriceUSD, info.retailPriceUSD, originalCNY);
    const currentCNY = parseCNYPrice(game.finalPrice);
    const isCheaper = currentCNY > 0 && cdkeyCNY !== null && cdkeyCNY < currentCNY;
    const cdkeyUrl = info.cdkeyUrl || '';

    html += `<div class="cdkey-row${isCheaper ? ' cdkey-cheaper' : ''}" data-url="${escapeHtml(cdkeyUrl)}">
      <span class="cdkey-label">CDKey</span>
      <span class="cdkey-price">${cdkeyCNY !== null ? formatCNY(cdkeyCNY) : `$${info.cdkeyPriceUSD.toFixed(2)}`}</span>
      <span class="cdkey-store">${escapeHtml(info.cdkeyStore || '')}</span>
      ${isCheaper ? '<span class="cdkey-cheaper-tag">更低</span>' : ''}
      <span class="cdkey-link-icon">&#8599;</span>
    </div>`;
  }

  if (!html) {
    html = '<div class="price-no-data">暂无比价数据</div>';
  }

  return html;
}

function bindCdkeyClicks(container) {
  container.querySelectorAll('.cdkey-row[data-url]').forEach((row) => {
    const url = row.dataset.url;
    if (!url) return;
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger card click (Steam store)
      window.steamAPI.openUrl(url);
    });
  });
}

async function loadPriceInfoForCurrentPage() {
  const pageData = getPageData();
  const appidsToFetch = pageData
    .map((g) => g.appid)
    .filter((id) => !priceInfoCache[id]);

  if (appidsToFetch.length === 0) return;

  try {
    const results = await window.steamAPI.fetchPriceInfo(appidsToFetch);

    // Merge into cache
    for (const [appid, info] of Object.entries(results)) {
      priceInfoCache[appid] = info;
    }
    // Mark missing ones so we don't re-fetch
    for (const appid of appidsToFetch) {
      if (!priceInfoCache[appid]) {
        priceInfoCache[appid] = {};
      }
    }

    // Update DOM for visible cards
    for (const game of pageData) {
      const el = document.getElementById(`extra-${game.appid}`);
      if (el) {
        el.innerHTML = buildPriceInfoHTML(priceInfoCache[game.appid], game);
        bindCdkeyClicks(el);
      }
    }
  } catch (err) {
    console.error('Failed to fetch price info:', err);
    // Don't block UI, just leave loading text
  }
}

function renderPagination(totalPages) {
  $pagination.innerHTML = '';

  if (totalPages <= 1) return;

  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '< 上一页';
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      render();
      loadPriceInfoForCurrentPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  $pagination.appendChild(prevBtn);

  // Page buttons - show limited range around current page
  const maxVisible = 7;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  if (startPage > 1) {
    addPageButton(1);
    if (startPage > 2) {
      const dots = document.createElement('span');
      dots.textContent = '...';
      dots.style.color = '#8f98a0';
      dots.style.padding = '0 4px';
      $pagination.appendChild(dots);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    addPageButton(i);
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const dots = document.createElement('span');
      dots.textContent = '...';
      dots.style.color = '#8f98a0';
      dots.style.padding = '0 4px';
      $pagination.appendChild(dots);
    }
    addPageButton(totalPages);
  }

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.textContent = '下一页 >';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      render();
      loadPriceInfoForCurrentPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  $pagination.appendChild(nextBtn);
}

function addPageButton(page) {
  const btn = document.createElement('button');
  btn.textContent = page;
  if (page === currentPage) btn.classList.add('active');
  btn.addEventListener('click', () => {
    currentPage = page;
    render();
    loadPriceInfoForCurrentPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $pagination.appendChild(btn);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showError(msg) {
  $loading.style.display = 'none';
  $content.style.display = 'none';
  $error.style.display = 'flex';
  $errorMsg.textContent = msg;
}

// Init - fetch data on startup
async function init() {
  let shownEarly = false;

  // Listen for first batch of deals — show immediately
  window.steamAPI.onDealsPartial((partialDeals) => {
    if (shownEarly) return;
    shownEarly = true;
    dealsData = partialDeals;
    $tabs[0].textContent = `热门折扣 ≥50% (${dealsData.length}+)`;
    $loading.style.display = 'none';
    $content.style.display = 'block';
    $loading.querySelector('p').textContent = '正在获取新游戏数据...';
    render();
    loadPriceInfoForCurrentPage();
  });

  try {
    // Fetch both in parallel
    const [deals, newReleases] = await Promise.all([
      window.steamAPI.fetchAllDeals(),
      window.steamAPI.fetchAllNewReleases(),
    ]);

    dealsData = deals;
    newReleasesData = newReleases;

    // Update tab labels with final counts
    $tabs[0].textContent = `热门折扣 ≥50% (${dealsData.length})`;
    $tabs[1].textContent = `今日新游 (${newReleasesData.length})`;

    if (!shownEarly) {
      $loading.style.display = 'none';
      $content.style.display = 'block';
    }
    render();
    loadPriceInfoForCurrentPage();
  } catch (err) {
    console.error('Failed to fetch Steam data:', err);
    if (!shownEarly) {
      showError(`获取 Steam 数据失败: ${err.message}`);
    }
  }

  // Check for updates (non-blocking)
  checkForUpdates();
}

async function checkForUpdates() {
  const $versionText = document.getElementById('version-text');
  const $updateBtn = document.getElementById('update-btn');

  try {
    const ver = await window.steamAPI.getCurrentVersion();
    $versionText.textContent = `v${ver}`;

    const update = await window.steamAPI.checkUpdate();
    if (update.hasUpdate) {
      $versionText.textContent = `v${update.currentVersion}`;
      $updateBtn.textContent = `新版本 v${update.latestVersion} 可用`;
      $updateBtn.style.display = 'inline-block';
      $updateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.steamAPI.openUrl(update.downloadUrl);
      });
    }
  } catch (_) {
    // Silent fail - update check is non-critical
  }
}

init();
