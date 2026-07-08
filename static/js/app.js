// API 基础路径
const API_BASE = '/api/v1/jsplugin/mylxmusic/api';
const MAIN_API = '/api/v1';

// 状态
let currentSources = [];
let batchCurrentId = '';            // 后台正在加载的源 id
let batchPendingIds = [];           // 后台等待加载的源 id 列表
let currentPlatforms = [];
let searchResults = [];
let currentPage = 1;
let totalResults = 0;
let currentPlatformId = '';
let currentKeyword = '';
let playlists = [];
let sourcesLoaded = false;
let hasEnabledSources = true; // 是否有启用的音源，默认 true 避免闪烁
let isImporting = false;      // 搜索页签:防止快速点击导致重复请求/重复创建歌单
let slIsImporting = false;    // 歌单详情页同上
let lbIsImporting = false;    // 排行榜页同上

// 跨页持久选择
const selectedSongs = new Map();

// ============ 平台名称映射 ============

function getPlatformName(source) {
    const names = { kg: '酷狗', kw: '酷我', tx: 'QQ', wy: '网易', mg: '咪咕' };
    return names[source] || source || '';
}

function getQualityLabel(quality) {
    if (!quality) return '';
    const q = (typeof quality === 'string') ? quality.toLowerCase() : String(quality).toLowerCase();
    if (q === 'flac' || q === 'ape' || q === 'wav' || q === 'dsd' || q === 'hi-res') return 'Hi-Res';
    if (q === '320k' || q === '320') return '320k';
    if (q === '128k' || q === '128') return '128k';
    return quality;
}

function getBestQuality(song) {
    // 从 song.types 数组中获取最高可用音质
    if (Array.isArray(song.types) && song.types.length > 0) {
        const priority = ['flac', 'ape', 'wav', 'dsd', '320k', '320', '192k', '128k', '128'];
        const typeValues = song.types.map(t => (typeof t === 'string' ? t : t.type || '').toLowerCase());
        for (const q of priority) {
            if (typeValues.includes(q)) return q;
        }
        return typeValues[0];
    }
    // 回退到 song.quality 字段
    if (song.quality) return song.quality;
    return '320k';
}

function renderBadges(source, quality) {
    const platformName = getPlatformName(source);
    const qualityLabel = getQualityLabel(quality);
    const isHiRes = qualityLabel === 'Hi-Res';
    const sourceBadge = platformName ? `<span class="source-badge">${escapeHtml(platformName)}</span>` : '';
    const qualityBadge = qualityLabel ? `<span class="quality-badge${isHiRes ? ' hi-res' : ''}">${escapeHtml(qualityLabel)}</span>` : '';
    return `<div class="result-badges">${sourceBadge}${qualityBadge}</div>`;
}

function backToHotSearch() {
    // 隐藏搜索结果，恢复热门歌曲网格
    document.getElementById('resultSection').style.display = 'none';
    const hotCard = document.getElementById('hotSearchCard');
    if (hotCard) { hotCard.style.opacity = ''; hotCard.style.maxHeight = ''; hotCard.style.overflow = ''; hotCard.style.marginTop = ''; hotCard.style.paddingTop = ''; hotCard.style.transition = ''; }
    // 清空搜索状态
    searchResults = [];
    totalResults = 0;
    currentKeyword = '';
    selectedSongs.clear();
    updateSelectedCount();
    document.getElementById('keyword').value = '';
    document.getElementById('keyword').focus();
}

// ============ 工具函数 ============

function getAuthToken() {
    try {
        const authData = localStorage.getItem('songloft-auth');
        if (authData) {
            return JSON.parse(authData).accessToken || '';
        }
    } catch (e) {}
    return '';
}

function getAuthHeaders(isJson = true) {
    const headers = {};
    if (isJson) headers['Content-Type'] = 'application/json';
    const token = getAuthToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

// ============ API 请求封装 ============

// 统一处理 HTTP 错误：非 2xx 时读取 JSON body 的 message 字段抛出，
// 配合后端 writePluginUnavailable 让插件未启用等场景显示友好中文，
// 而非 response.json() 解析纯文本时抛出的 SyntaxError。
async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        let msg = res.statusText || `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body && body.message) msg = body.message;
        } catch (_) { /* 非 JSON body 时保留 statusText */ }
        throw new Error(msg);
    }
    return res.json();
}

// 插件 API 封装：path 以 "/" 开头，自动拼接 API_BASE。
function apiGet(path) {
    return fetchJSON(API_BASE + path, { headers: getAuthHeaders() });
}

function apiPost(path, body) {
    return fetchJSON(API_BASE + path, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
    });
}

function apiPut(path, body) {
    return fetchJSON(API_BASE + path, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
    });
}

function apiDelete(path) {
    return fetchJSON(API_BASE + path, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
}

// FormData 上传：必须省略 Content-Type，让浏览器自动带 multipart boundary。
function apiPostForm(path, formData) {
    return fetchJSON(API_BASE + path, {
        method: 'POST',
        headers: getAuthHeaders(false),
        body: formData
    });
}

// 主程序 API 封装：path 以 "/" 开头，自动拼接 MAIN_API（如 /playlists 等共享资源）。
function mainApiGet(path) {
    return fetchJSON(MAIN_API + path, { headers: getAuthHeaders() });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSongKey(song) {
    return `${song.source}:${song.musicId || song.music_id || ''}`;
}

// ============ Snackbar ============

let snackbarTimer = null;

function showSnackbar(message, type = 'info', duration = 3000) {
    const el = document.getElementById('snackbar');
    if (snackbarTimer) clearTimeout(snackbarTimer);
    el.textContent = message;
    el.className = `snackbar ${type} show`;
    snackbarTimer = setTimeout(() => { el.className = 'snackbar'; }, duration);
}

// ============ Dialog ============

function showDialog(title, content, options) {
    return new Promise((resolve) => {
        document.getElementById('dialogTitle').textContent = title;
        const contentEl = document.getElementById('dialogContent');
        contentEl.style.whiteSpace = 'pre-line';
        contentEl.textContent = content;
        const overlay = document.getElementById('dialogOverlay');
        overlay.style.display = 'flex';
        const confirmBtn = document.getElementById('dialogConfirm');
        const cancelBtn = document.getElementById('dialogCancel');
        confirmBtn.textContent = (options && options.confirmText) || '确定';
        cancelBtn.textContent = (options && options.cancelText) || '取消';
        confirmBtn.onclick = () => { hideDialog(); resolve(true); };
        cancelBtn.onclick = () => { hideDialog(); resolve(false); };
    });
}

function hideDialog() {
    document.getElementById('dialogOverlay').style.display = 'none';
}

// ============ Tab 切换 ============

function initTabs() {
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.addEventListener('click', function () {
            const tab = this.dataset.tab;
            // 推入历史记录（popstate 触发时跳过）
            if (!window._isPopState) {
                history.pushState({ tab: tab }, '', '#' + tab);
            }
            document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            document.getElementById(`tab-${tab}`).classList.add('active');
            if (tab === 'sources' && !sourcesLoaded) {
                loadSources();
                sourcesLoaded = true;
            }
            if (tab === 'leaderboard' && !lbLeaderboardLoaded) {
                lbLoadBoards();
            }
        });
    });
}

/**
 * 切换到指定 Tab（供 popstate 回调使用）
 * @param {string} tab - Tab ID: 'search', 'songlist', 'sources'
 */
function switchToTab(tab) {
    document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector(`.tab-item[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    const content = document.getElementById(`tab-${tab}`);
    if (content) content.classList.add('active');

    // 切换 tab 时重新初始化回到顶部
    hideBackToTop();
    initBackToTop();

    if (tab === 'songlist') {
        const detailCard = document.getElementById('slDetailCard');
        const listCard = document.getElementById('slListCard');
        const filterBtn = document.getElementById('slFilterBtn');
        const sortChips = document.getElementById('slSortChips');
        if (detailCard) detailCard.style.display = 'none';
        slCloseTagDrawer();
        if (slCurrentMode === 'recommend') {
            if (listCard) listCard.style.display = '';
            if (filterBtn) filterBtn.style.display = '';
            if (sortChips) sortChips.style.display = '';
        } else if (slCurrentMode === 'search') {
            if (listCard) listCard.style.display = '';
            if (filterBtn) filterBtn.style.display = 'none';
            if (sortChips) sortChips.style.display = 'none';
        } else {
            // parse 模式没有列表
            if (listCard) listCard.style.display = 'none';
            if (filterBtn) filterBtn.style.display = 'none';
            if (sortChips) sortChips.style.display = 'none';
        }
    }

    // 切换到搜索 tab 时，如果没有搜索结果，恢复热门歌曲网格
    if (tab === 'search' && (!searchResults || searchResults.length === 0)) {
        const hotCard = document.getElementById('hotSearchCard');
        if (hotCard) { hotCard.style.opacity = ''; hotCard.style.maxHeight = ''; hotCard.style.overflow = ''; hotCard.style.marginTop = ''; hotCard.style.paddingTop = ''; hotCard.style.transition = ''; }
    }

    // 同步播放状态对应的 padding
    syncPlayerPadding();
}

// ============ 平台管理 ============

async function loadPlatforms() {
    try {
        const result = await apiGet('/platforms');
        if (result.code === 0) {
            currentPlatforms = result.data || [];
            renderPlatformSelect();
        } else {
            showSnackbar('加载平台列表失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('加载平台列表失败: ' + e.message, 'error');
    }
}

function renderPlatformSelect() {
    const select = document.getElementById('platformSelect');
    const searchBtn = document.getElementById('searchBtn');
    if (currentPlatforms.length === 0) {
        select.innerHTML = '<option value="">暂无可用平台</option>';
        searchBtn.disabled = true;
    } else {
        select.innerHTML = currentPlatforms.map(p =>
            `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
        ).join('');
        searchBtn.disabled = false;
    }
}

// ============ 歌单管理 ============

async function loadPlaylists() {
    try {
        const data = await mainApiGet('/playlists');
        playlists = data.playlists || data.data || data || [];
        renderPlaylistSelect();
    } catch (e) {
        console.error('加载歌单失败:', e);
    }
}

function renderPlaylistSelect() {
    let html = '<option value="">不添加到歌单</option>';
    if (Array.isArray(playlists)) {
        for (const pl of playlists) {
            html += `<option value="${pl.id}">${escapeHtml(pl.name)}</option>`;
        }
    }
    html += '<option value="__new__">+ 新建歌单...</option>';
    // 同步填充搜索页签和排行榜页签的歌单下拉（歌单页签在进入详情时单独渲染）
    for (const selectId of ['playlistSelect', 'lbPlaylistSelect']) {
        const select = document.getElementById(selectId);
        if (select) select.innerHTML = html;
    }
}

// ============ 音源状态检查 ============

async function checkSourceStatus() {
    try {
        const result = await apiGet('/sources');
        if (result.code === 0) {
            const data = result.data || {};
            const sources = data.list || [];
            hasEnabledSources = data.has_enabled || sources.some(s => s.enabled);
        } else {
            hasEnabledSources = false;
        }
    } catch (e) {
        console.error('检查音源状态失败:', e);
    }
    updateWarningBanners();
}

function updateWarningBanners() {
    const searchBanner = document.getElementById('searchWarningBanner');
    const songlistBanner = document.getElementById('songlistWarningBanner');
    const lbBanner = document.getElementById('lbWarningBanner');
    if (searchBanner) searchBanner.classList.toggle('hidden', hasEnabledSources);
    if (songlistBanner) songlistBanner.classList.toggle('hidden', hasEnabledSources);
    if (lbBanner) lbBanner.classList.toggle('hidden', hasEnabledSources);
}

// ============ 插件设置 ============

async function loadConfig() {
    try {
        const result = await apiGet('/config');
        if (result.code === 0 && result.data) {
            const cfg = result.data;
            // 填充平台 checkbox
            const container = document.getElementById('cfgPlatforms');
            if (container) {
                const boxes = container.querySelectorAll('input[type="checkbox"]');
                boxes.forEach(cb => {
                    cb.checked = Array.isArray(cfg.defaultPlatforms) && cfg.defaultPlatforms.includes(cb.value);
                });
            }
            // 填充音质
            const qualityEl = document.getElementById('cfgQuality');
            if (qualityEl && cfg.defaultQuality) {
                qualityEl.value = cfg.defaultQuality;
            }
        }
    } catch (e) {
        console.warn('加载配置失败:', e);
    }
}

async function saveConfig() {
    const container = document.getElementById('cfgPlatforms');
    const platforms = [];
    if (container) {
        container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            platforms.push(cb.value);
        });
    }
    if (platforms.length === 0) {
        showSnackbar('至少选择一个平台', 'warning');
        return;
    }
    const quality = document.getElementById('cfgQuality')?.value || '320k';
    try {
        const result = await apiPost('/config', { defaultPlatforms: platforms, defaultQuality: quality });
        if (result.code === 0) {
            showSnackbar('设置已保存', 'success');
        } else {
            showSnackbar('保存失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('保存失败: ' + e.message, 'error');
    }
}

// ============ 音源管理 ============

function applySourcesResponse(data) {
    currentSources = data.list || [];
    batchCurrentId = data.batch_current_id || '';
    batchPendingIds = Array.isArray(data.batch_pending_ids) ? data.batch_pending_ids : [];
    renderSources();
}

async function loadSources() {
    const container = document.getElementById('sourceList');
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>加载中...</p></div>';
    try {
        const result = await apiGet('/sources');
        if (result.code === 0) {
            const data = result.data || {};
            applySourcesResponse(data);
            // 若后台有批量加载在跑，启动轮询直到 loading=0
            if (data.loading && data.loading > 0) startSourceLoadingPoll();
        } else {
            showSnackbar('加载音源失败: ' + (result.msg || '未知错误'), 'error');
            container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
        }
    } catch (e) {
        showSnackbar('加载音源失败: ' + e.message, 'error');
    }
}

// 批量异步加载状态轮询：每 2s 拉一次，直到 loading=0
let sourceLoadingPollTimer = null;
function startSourceLoadingPoll() {
    if (sourceLoadingPollTimer) return; // 已在轮询
    sourceLoadingPollTimer = setInterval(async () => {
        try {
            const result = await apiGet('/sources');
            if (result.code !== 0) return;
            const data = result.data || {};
            applySourcesResponse(data);
            checkSourceStatus();
            if (!data.loading || data.loading <= 0) {
                clearInterval(sourceLoadingPollTimer);
                sourceLoadingPollTimer = null;
                showSnackbar('批量加载完成', 'success');
            }
        } catch (e) { /* 网络抖动忽略，下次再试 */ }
    }, 2000);
}

function renderSources() {
    const container = document.getElementById('sourceList');
    if (currentSources.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">inbox</span><p>暂无音源。导入洛雪音源脚本后，即可获取歌曲播放链接。<br>支持导入 .js 脚本文件或 .zip 压缩包。</p></div>';
        return;
    }
    const pendingSet = new Set(batchPendingIds);
    container.innerHTML = currentSources.map(source => {
        const isLoading = source.id === batchCurrentId;
        const isPending = pendingSet.has(source.id);
        // 加载中或等待中：用状态徽标替换 toggle，禁止用户在此时切换；其他时候正常开关。
        const trailing = (isLoading || isPending)
            ? `<span class="source-status-chip ${isLoading ? 'loading' : 'pending'}">
                    <span class="material-symbols-outlined">${isLoading ? 'progress_activity' : 'hourglass_empty'}</span>
                    ${isLoading ? '加载中...' : '等待加载'}
               </span>`
            : `<label class="md-switch" title="${source.enabled ? '已启用' : '已禁用'}">
                    <input type="checkbox" ${source.enabled ? 'checked' : ''}
                        onchange="toggleSource('${escapeHtml(source.id)}', this.checked)">
                    <span class="switch-track"></span>
                    <span class="switch-thumb"></span>
               </label>`;
        return `
        <div class="list-item ${isLoading ? 'is-loading' : (isPending ? 'is-pending' : '')}" data-id="${escapeHtml(source.id)}">
            <div class="list-item-info">
                <div class="list-item-title">${escapeHtml(source.name)}</div>
                <div class="list-item-subtitle">
                    版本: ${escapeHtml(source.version || '-')} &nbsp;|&nbsp;
                    作者: ${escapeHtml(source.author || '-')} &nbsp;|&nbsp;
                    ${source.imported_at ? new Date(source.imported_at).toLocaleString() : '-'}
                </div>
                ${source.platforms && source.platforms.length > 0
                    ? '<div class="platform-chips">' + source.platforms.map(p => '<span class="chip chip-platform">' + escapeHtml(p) + '</span>').join('') + '</div>'
                    : ''}
            </div>
            <div class="list-item-trailing">
                ${trailing}
                <button class="btn-icon danger" onclick="deleteSource('${escapeHtml(source.id)}')" title="删除" ${isLoading ? 'disabled' : ''}>
                    <span class="material-symbols-outlined">delete</span>
                </button>
            </div>
        </div>
        `;
    }).join('');
}

async function toggleSource(id, enabled) {
    try {
        const result = await apiPut('/sources/toggle', { id, enabled });
        if (result.code === 0) {
            showSnackbar(enabled ? '音源已启用' : '音源已禁用', 'success');
            const source = currentSources.find(s => s.id === id);
            if (source) source.enabled = enabled;
            checkSourceStatus();
        } else {
            showSnackbar('操作失败: ' + (result.msg || '未知错误'), 'error');
            loadSources();
        }
    } catch (e) {
        showSnackbar('操作失败: ' + e.message, 'error');
        loadSources();
    }
}

async function importSource(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
        showSnackbar('正在导入...', 'info');
        const result = await apiPostForm('/sources/import', formData);
        if (result.code === 0) {
            if (result.warning) {
                showSnackbar('导入成功（有警告）: ' + result.warning, 'warning');
            } else {
                showSnackbar('导入成功', 'success');
            }
            loadSources(); // loadSources 内部会按需启动轮询
            checkSourceStatus();
        } else {
            showSnackbar('导入失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('导入失败: ' + e.message, 'error');
    }
}

async function importSourceFromURL(url) {
    if (!url || !url.trim()) { showSnackbar('请输入音源 URL', 'warning'); return; }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        showSnackbar('URL 必须以 http:// 或 https:// 开头', 'warning'); return;
    }
    try {
        showSnackbar('正在从 URL 导入...', 'info');
        const result = await apiPost('/sources/import-url', { url: url.trim() });
        if (result.code === 0) {
            if (result.warning) {
                showSnackbar('导入成功（有警告）: ' + result.warning, 'warning');
            } else {
                showSnackbar('导入成功', 'success');
            }
            document.getElementById('sourceUrl').value = '';
            loadSources();
            checkSourceStatus();
        } else {
            showSnackbar('导入失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('导入失败: ' + e.message, 'error');
    }
}

async function deleteSource(id) {
    const confirmed = await showDialog('确认删除', '确定要删除这个音源吗？删除后不可恢复。');
    if (!confirmed) return;
    try {
        const result = await apiDelete(`/sources?id=${encodeURIComponent(id)}`);
        if (result.code === 0) {
            showSnackbar('删除成功', 'success');
            loadSources();
            checkSourceStatus();
        } else {
            showSnackbar('删除失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('删除失败: ' + e.message, 'error');
    }
}

async function deleteAllSources() {
    if (!currentSources || currentSources.length === 0) {
        showSnackbar('当前没有音源', 'warning');
        return;
    }
    const confirmed = await showDialog(
        '确认删除所有音源',
        `确定要删除全部 ${currentSources.length} 个音源吗？删除后不可恢复。`
    );
    if (!confirmed) return;

    const ids = currentSources.map(s => s.id);
    let success = 0;
    let failed = 0;
    for (const id of ids) {
        try {
            const result = await apiDelete(`/sources?id=${encodeURIComponent(id)}`);
            if (result.code === 0) success++; else failed++;
        } catch (e) {
            failed++;
        }
    }
    if (failed === 0) {
        showSnackbar(`已删除 ${success} 个音源`, 'success');
    } else {
        showSnackbar(`删除完成：成功 ${success} 个，失败 ${failed} 个`, failed === ids.length ? 'error' : 'warning');
    }
    loadSources();
    checkSourceStatus();
}

// ============ 搜索 ============

async function search(keyword, platformId, page = 1) {
    if (!keyword.trim()) { showSnackbar('请输入搜索关键词', 'warning'); return; }
    if (!platformId) { showSnackbar('请选择平台', 'warning'); return; }

    // 清理旧的导入进度
    resetImportProgress('importProgress', 'progressFill', 'progressText', 'importResults');

    // 切换关键词或平台时清空跨页选择（同一搜索内翻页保留选择）
    if (keyword !== currentKeyword || platformId !== currentPlatformId) {
        selectedSongs.clear();
        updateSelectedCount();
    }

    currentKeyword = keyword;
    currentPlatformId = platformId;
    currentPage = page;

    const searchBtn = document.getElementById('searchBtn');
    searchBtn.disabled = true;
    searchBtn.innerHTML = '<span class="spinner"></span>搜索中...';

    try {
        // 主程序新约定:search 改为 POST,body 含 keyword/source_id/page/page_size
        const result = await apiPost('/search', {
            keyword,
            source_id: platformId,
            page,
            page_size: 30,
        });
        if (result.code === 0) {
            searchResults = result.data.list || [];
            totalResults = result.data.total || 0;
            renderResults();
            document.getElementById('resultSection').style.display = '';
            // 搜索后隐藏热门歌曲网格
            const hotCard = document.getElementById('hotSearchCard');
            if (hotCard) { hotCard.style.transition = 'opacity .3s, max-height .4s var(--ease-out)'; hotCard.style.opacity = '0'; hotCard.style.maxHeight = '0'; hotCard.style.overflow = 'hidden'; hotCard.style.marginTop = '0'; hotCard.style.paddingTop = '0'; }
            initBackToTop();
        } else {
            showSnackbar('搜索失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('搜索失败: ' + e.message, 'error');
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = '搜索';
    }
}

// ============ 搜索结果渲染 ============

function renderResults() {
    const container = document.getElementById('resultList');
    document.getElementById('resultCount').textContent = `共 ${totalResults} 条`;

    if (searchResults.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>没有找到相关歌曲</p></div>';
        renderPagination();
        return;
    }

    container.innerHTML = searchResults.map((song, i) => {
        const key = getSongKey(song);
        const checked = selectedSongs.has(key) ? 'checked' : '';
        const selectedClass = selectedSongs.has(key) ? ' selected' : '';
        const playingClass = (srCurrentSong && getSongKey(song) === getSongKey(srCurrentSong)) ? ' playing' : '';
        const imgHtml = song.img
            ? `<img src="${escapeHtml(song.img)}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<span class=\\'material-symbols-outlined\\'>music_note</span>'">`
            : '<span class="material-symbols-outlined">music_note</span>';
        const playIcon = (srCurrentSong && getSongKey(song) === getSongKey(srCurrentSong) && srIsPlaying) ? 'pause' : 'play_arrow';
        const badgesHtml = renderBadges(song.source, getBestQuality(song));
        return `
            <div class="result-item${selectedClass}${playingClass} animate-slide-up" data-index="${i}" style="animation-delay:${Math.min(i, 15) * 0.03}s">
                <div class="col-index">
                    <input type="checkbox" class="result-checkbox" data-index="${i}" ${checked}
                        onchange="onSongCheckChanged(${i}, this.checked)" style="accent-color:var(--md-primary);width:18px;height:18px;cursor:pointer">
                </div>
                <div class="col-title">
                    <div class="result-thumb">${imgHtml}</div>
                    <div class="result-title-wrap">
                        <div class="result-name">${escapeHtml(song.name)}${badgesHtml}</div>
                    </div>
                </div>
                <div class="col-artist">${escapeHtml(song.singer || '')}</div>
                <div class="col-album">${escapeHtml(song.album || '')}</div>
                <div class="col-duration">${formatDuration(song.duration)}</div>
                <div class="col-actions">
                    <button class="play-btn sr-play-btn" data-index="${i}" title="播放">
                        <span class="material-symbols-outlined">${playIcon}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // 同步全选状态
    const allChecked = searchResults.every(s => selectedSongs.has(getSongKey(s)));
    document.getElementById('selectAll').checked = allChecked && searchResults.length > 0;

    // 绑定搜索结果行播放按钮点击事件
    container.querySelectorAll('.sr-play-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.getAttribute('data-index'));
            srPlaySong(idx);
        });
    });

    updateSelectedCount();
    renderPagination();
}

function onSongCheckChanged(index, checked) {
    const song = searchResults[index];
    const key = getSongKey(song);
    if (checked) selectedSongs.set(key, song);
    else selectedSongs.delete(key);
    // 更新行样式
    const row = document.querySelector(`.result-item[data-index="${index}"]`);
    if (row) row.classList.toggle('selected', checked);
    updateSelectedCount();
    // 检查全选状态
    const allChecked = searchResults.every(s => selectedSongs.has(getSongKey(s)));
    document.getElementById('selectAll').checked = allChecked;
}

function toggleSelectAll() {
    const checked = document.getElementById('selectAll').checked;
    searchResults.forEach(song => {
        const key = getSongKey(song);
        if (checked) selectedSongs.set(key, song);
        else selectedSongs.delete(key);
    });
    renderResults();
}

function updateSelectedCount() {
    const count = selectedSongs.size;
    const badge = document.getElementById('selectedBadge');
    if (badge) badge.textContent = count;
    document.getElementById('importSongsBtn').disabled = count === 0;
    document.getElementById('clearSelectionBtn').style.display = count > 0 ? '' : 'none';
}

function clearSelection() {
    selectedSongs.clear();
    renderResults();
}

// ============ 分页 ============

function renderPagination() {
    const container = document.getElementById('pagination');
    const totalPages = Math.ceil(totalResults / 30);
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    container.innerHTML = `
        <button class="btn-icon" title="上一页" ${currentPage <= 1 ? 'disabled' : ''}
            onclick="search('${escapeHtml(currentKeyword)}','${escapeHtml(currentPlatformId)}',${currentPage - 1})">
            <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <span class="page-info">第 ${currentPage} / ${totalPages} 页</span>
        <input type="number" class="text-field page-jump" value="${currentPage}" min="1" max="${totalPages}"
            onchange="jumpToPage(this.value, ${totalPages})">
        <button class="btn-icon" title="下一页" ${currentPage >= totalPages ? 'disabled' : ''}
            onclick="search('${escapeHtml(currentKeyword)}','${escapeHtml(currentPlatformId)}',${currentPage + 1})">
            <span class="material-symbols-outlined">chevron_right</span>
        </button>
    `;
}

function jumpToPage(val, totalPages) {
    const page = Math.min(totalPages, Math.max(1, parseInt(val) || 1));
    if (page !== currentPage) {
        search(currentKeyword, currentPlatformId, page);
    }
}

// ============ 批量导入（分批） ============

/** 隐藏并重置导入进度区域 */
function resetImportProgress(progressSectionId, progressFillId, progressTextId, importResultsId) {
    const section = document.getElementById(progressSectionId);
    if (section) section.style.display = 'none';
    const fill = document.getElementById(progressFillId);
    if (fill) fill.style.width = '0%';
    const text = document.getElementById(progressTextId);
    if (text) text.textContent = '准备中...';
    const results = document.getElementById(importResultsId);
    if (results) results.innerHTML = '';
}

const BATCH_SIZE = 20;

function mapSongToRequest(song) {
    return {
        name: song.name,
        singer: song.singer,
        album: song.album,
        source: song.source,
        musicId: song.musicId || song.music_id,
        img: song.img,
        hash: song.hash,
        songmid: song.songmid,
        strMediaMid: song.strMediaMid,
        albumMid: song.albumMid,
        copyrightId: song.copyrightId,
        albumId: song.albumId,
        duration: song.duration,
        types: song.types
    };
}

/**
 * 分批导入歌曲的公共函数
 * @param {Array} songs - 待导入歌曲数组
 * @param {Object} options - 配置项
 * @param {string} options.quality - 音质
 * @param {number} options.playlistId - 歌单 ID（0 表示不添加）
 * @param {string} options.newPlaylistName - 新歌单名称（空字符串表示不创建）
 * @param {string} options.progressFillId - 进度条填充元素 ID
 * @param {string} options.progressTextId - 进度文本元素 ID
 * @param {string} options.importResultsId - 导入结果列表元素 ID
 * @returns {Object} { totalSuccess, totalFailed, playlistConflict }
 */
async function batchImportSongs(songs, options) {
    const { quality, progressFillId, progressTextId, importResultsId } = options;
    let { playlistId, newPlaylistName } = options;

    const progressFill = document.getElementById(progressFillId);
    const progressText = document.getElementById(progressTextId);
    const importResultsEl = document.getElementById(importResultsId);

    let totalSuccess = 0;
    let totalFailed = 0;
    const allResults = [];
    let playlistConflict = false;
    let lastWarning = '';

    const totalCount = songs.length;

    for (let i = 0; i < totalCount; i += BATCH_SIZE) {
        const batch = songs.slice(i, i + BATCH_SIZE);
        const batchRequest = {
            songs: batch.map(mapSongToRequest),
            quality,
            playlist_id: playlistId,
            new_playlist_name: (i === 0) ? newPlaylistName : ''
        };

        const completed = Math.min(i + batch.length, totalCount);
        progressText.textContent = `正在导入... (${completed}/${totalCount})`;
        const progress = Math.round((i / totalCount) * 100);
        progressFill.style.width = progress + '%';

        try {
            const result = await apiPost('/songs/import', batchRequest);
            if (result.code === 0) {
                const data = result.data;
                totalSuccess += (data.success || 0);
                totalFailed += (data.failed || 0);
                if (data.results) allResults.push(...data.results);
                if (data.warning) lastWarning = data.warning;

                // 第一批创建歌单后，后续批次使用返回的 playlist_id
                if (i === 0 && newPlaylistName && data.playlist_id) {
                    playlistId = data.playlist_id;
                    newPlaylistName = '';
                }

                // 歌单创建冲突，中止后续批次
                if (data.playlist_error && data.playlist_error.code === 'name_conflict') {
                    playlistConflict = true;
                    showSnackbar(data.playlist_error.message || '已存在同名歌单,请改名或选择已有歌单', 'error', 5000);
                    break;
                }
            } else {
                const msg = result.msg || '未知错误';
                const friendlyMsg = msg.includes('音源') ? '未配置有效的音源，无法获取播放链接。请先前往音源管理导入音源。' : msg;
                // 记录错误但继续下一批
                totalFailed += batch.length;
                batch.forEach(song => allResults.push({ name: song.name, success: false, error: friendlyMsg }));
            }
        } catch (e) {
            // 网络错误等，记录并继续
            totalFailed += batch.length;
            batch.forEach(song => allResults.push({ name: song.name, success: false, error: e.message }));
        }

        // 更新进度
        const currentProgress = Math.min(100, Math.round((Math.min(i + batch.length, totalCount) / totalCount) * 100));
        progressFill.style.width = currentProgress + '%';
    }

    // 最终结果
    progressFill.style.width = '100%';
    progressText.textContent = `导入完成：成功 ${totalSuccess} 首，失败 ${totalFailed} 首`;
    importResultsEl.innerHTML = allResults.map(item =>
        item.success
            ? `<div class="import-result-item success">✓ ${escapeHtml(item.name)}</div>`
            : `<div class="import-result-item error">✗ ${escapeHtml(item.name)}: ${escapeHtml(item.error)}</div>`
    ).join('');

    if (lastWarning) showSnackbar(lastWarning, 'warning', 5000);

    return { totalSuccess, totalFailed, playlistConflict };
}

async function importSelectedSongs() {
    if (isImporting) return;

    const songs = Array.from(selectedSongs.values());
    if (songs.length === 0) { showSnackbar('请选择要导入的歌曲', 'warning'); return; }

    if (!hasEnabledSources) {
        const proceed = await showDialog(
            '未配置音源',
            '当前未配置有效的洛雪音源，导入的歌曲将无法播放。\n\n是否仍要继续导入？',
            { confirmText: '继续导入', cancelText: '去配置音源' }
        );
        if (!proceed) { switchToTab('sources'); return; }
    }

    const quality = 'flac';
    const playlistSelect = document.getElementById('playlistSelect');
    let playlistId = 0;
    let newPlaylistName = '';

    if (playlistSelect.value === '__new__') {
        newPlaylistName = document.getElementById('newPlaylistName').value.trim();
        if (!newPlaylistName) { showSnackbar('请输入歌单名称', 'error'); return; }
    } else if (playlistSelect.value) {
        playlistId = parseInt(playlistSelect.value);
    }

    isImporting = true;

    const progressSection = document.getElementById('importProgress');
    progressSection.style.display = '';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '正在导入...';
    document.getElementById('importResults').innerHTML = '';

    const importBtn = document.getElementById('importSongsBtn');
    importBtn.disabled = true;
    importBtn.innerHTML = '<span class="spinner"></span>导入中...';

    try {
        const { totalSuccess, totalFailed, playlistConflict } = await batchImportSongs(songs, {
            quality,
            playlistId,
            newPlaylistName,
            progressFillId: 'progressFill',
            progressTextId: 'progressText',
            importResultsId: 'importResults'
        });

        if (playlistConflict) {
            await loadPlaylists();
        } else if (totalSuccess > 0) {
            showSnackbar(`成功导入 ${totalSuccess} 首歌曲`, 'success');
            selectedSongs.clear();
            updateSelectedCount();
            loadPlaylists();
        }
        if (totalFailed > 0) showSnackbar(`${totalFailed} 首歌曲导入失败`, 'error');
    } catch (e) {
        document.getElementById('progressText').textContent = '导入失败: ' + e.message;
        showSnackbar('导入失败: ' + e.message, 'error');
    } finally {
        isImporting = false;
        importBtn.disabled = selectedSongs.size === 0;
        importBtn.innerHTML = `导入选中 <span id="selectedBadge" class="badge">${selectedSongs.size}</span>`;
    }
}

// ============ 初始化 ============

document.addEventListener('DOMContentLoaded', function () {
    // 设置初始历史状态（使用 replaceState 避免多余条目）
    history.replaceState({ tab: 'search' }, '', '#search');

    // 监听浏览器返回/前进，恢复对应 Tab/子页面
    window.addEventListener('popstate', (event) => {
        // slBackToList 触发的 history.back() 在此跳过，避免重复 DOM 操作
        if (window._skipNextPopstate) {
            window._skipNextPopstate = false;
            return;
        }
        if (event.state && event.state.tab) {
            window._isPopState = true;
            if (event.state.detail) {
                // 返回到歌单详情（前进时）
                slOpenDetail(event.state.detail);
            } else {
                switchToTab(event.state.tab);
            }
            window._isPopState = false;
        }
    });

    initTabs();
    loadPlatforms();
    loadPlaylists();
    checkSourceStatus();
    loadConfig();
    loadHotSearch();

    // 导入音源文件
    document.getElementById('importBtn').addEventListener('click', () => {
        document.getElementById('sourceFile').click();
    });
    document.getElementById('sourceFile').addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file) { importSource(file); e.target.value = ''; }
    });

    // 从 URL 导入音源
    document.getElementById('importUrlBtn').addEventListener('click', () => {
        importSourceFromURL(document.getElementById('sourceUrl').value);
    });
    document.getElementById('sourceUrl').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') importSourceFromURL(this.value);
    });

    // 删除所有音源
    document.getElementById('deleteAllSourcesBtn').addEventListener('click', deleteAllSources);

    // 保存插件设置
    document.getElementById('cfgSaveBtn').addEventListener('click', saveConfig);

    // 搜索
    document.getElementById('searchBtn').addEventListener('click', () => {
        search(document.getElementById('keyword').value, document.getElementById('platformSelect').value, 1);
    });
    document.getElementById('keyword').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            search(this.value, document.getElementById('platformSelect').value, 1);
        }
    });

    // 全选
    document.getElementById('selectAll').addEventListener('change', toggleSelectAll);

    // 导入歌曲
    document.getElementById('importSongsBtn').addEventListener('click', importSelectedSongs);

    // 清除选择
    document.getElementById('clearSelectionBtn').addEventListener('click', clearSelection);

    // 歌单选择变化
    document.getElementById('playlistSelect').addEventListener('change', function () {
        const wrapper = document.getElementById('newPlaylistWrapper');
        wrapper.style.display = this.value === '__new__' ? 'flex' : 'none';
    });

    // Dialog 点击遮罩关闭
    document.getElementById('dialogOverlay').addEventListener('click', function (e) {
        if (e.target === this) hideDialog();
    });

    // 初始化歌单 Tab
    initSonglistTab();

    // 初始化排行榜 Tab
    initLeaderboardTab();

    // 绑定搜索结果播放按钮
    document.getElementById('srPlayAllBtn').addEventListener('click', srPlayAll);
    document.getElementById('srShuffleBtn').addEventListener('click', srShufflePlay);

    // 绑定排行榜播放按钮
    document.getElementById('lbPlayAllBtn').addEventListener('click', lbPlayAll);
    document.getElementById('lbShuffleBtn').addEventListener('click', lbShufflePlay);

    // 初始化统一回到顶部
    initBackToTop();
});

// ============ 歌单 Tab ============

// 歌单状态
let slCurrentPlatform = 'kg';
let slCurrentMode = 'recommend';
let slCurrentSortId = '';
let slCurrentTagId = '';
let slSortList = [];
let slTags = null;
let slSongLists = [];
let slCurrentPage = 1;
let slTotalResults = 0;
let slDetailSongs = [];
let slDetailInfo = null;
let slDetailPage = 1;
let slDetailTotal = 0;
let slSelectedSongs = new Map();
let slTagsLoaded = false;

// ============ 播放器状态（统一） ============
let currentPlaySong = null;   // 当前播放的歌曲对象
let isPlaying = false;        // 是否正在播放
let audioElement = null;     // audio 元素

// 当前播放的歌曲列表（搜索结果、歌单详情、排行榜共用）
let currentSongList = [];
let shuffleList = [];        // 随机播放列表（存储索引）
let currentShuffleIndex = 0; // 当前播放索引

// 搜索结果页播放器状态
let srCurrentSong = null;
let srIsPlaying = false;
let srAudioElement = null;
let srShuffleList = [];
let srCurrentShuffleIndex = 0;

// 排行榜页播放器状态
let lbCurrentSong = null;
let lbIsPlaying = false;
let lbAudioElement = null;
let lbShuffleList = [];
let lbCurrentShuffleIndex = 0;

// 歌单详情页播放器状态
let slShuffleList = [];
let slCurrentShuffleIndex = 0;

// 当前活跃的播放器来源：'sl' | 'sr' | 'lb'
let currentPlayerSource = 'sl';

// 循环模式：'off' | 'all' | 'one'
let repeatMode = 'off';
// 播放速度列表和当前索引
const speedOptions = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
let currentSpeedIndex = 2; // 默认 1.0x

// 全屏播放器状态
let fullPlayerOpen = false;
let parsedLyrics = [];      // [{time: ms, text: string}]
let currentLyricIndex = -1;
let lyricsRequestId = 0;     // 请求令牌，每次新请求递增，旧请求响应到达时检查是否过期
let lyricsCache = {};        // songKey -> lrc string

// 迷你播放器显示/隐藏（同步调整内容区底部边距）
function showMiniPlayer() {
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) {
        miniPlayer.style.display = '';
        miniPlayer.classList.remove('player-animate-in');
        void miniPlayer.offsetWidth; // force reflow for animation restart
        miniPlayer.classList.add('player-animate-in');
    }
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('has-mini-player'));
    // 重置线性进度条
    const bar = document.getElementById('playerProgressBarFill');
    if (bar) bar.style.width = '0%';
    const tc = document.getElementById('playerTimeCurrent');
    const tt = document.getElementById('playerTimeTotal');
    if (tc) tc.textContent = '0:00';
    if (tt) tt.textContent = '0:00';
}

function hideMiniPlayer() {
    const miniPlayer = document.getElementById('miniPlayer');
    if (miniPlayer) miniPlayer.style.display = 'none';
    syncPlayerPadding();
}

// 根据播放状态同步内容区底部边距
function syncPlayerPadding() {
    const isAnyPlaying = isPlaying || srIsPlaying || lbIsPlaying;
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('has-mini-player', isAnyPlaying);
    });
}

// 更新迷你播放器线性进度条 + 时间显示
function updatePlayerProgress() {
    let audioEl = null;
    if (currentPlayerSource === 'sr' && srAudioElement) audioEl = srAudioElement;
    else if (currentPlayerSource === 'lb' && lbAudioElement) audioEl = lbAudioElement;
    else if (currentPlayerSource === 'sl' && audioElement) audioEl = audioElement;

    const bar = document.getElementById('playerProgressBarFill');
    const timeCurrent = document.getElementById('playerTimeCurrent');
    const timeTotal = document.getElementById('playerTimeTotal');
    if (!bar) return;

    if (!audioEl || !audioEl.duration || isNaN(audioEl.duration)) {
        bar.style.width = '0%';
        if (timeCurrent) timeCurrent.textContent = '0:00';
        if (timeTotal) timeTotal.textContent = '0:00';
        return;
    }

    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    bar.style.width = pct + '%';
    if (timeCurrent) timeCurrent.textContent = formatDuration(Math.floor(audioEl.currentTime));
    if (timeTotal) timeTotal.textContent = formatDuration(Math.floor(audioEl.duration));

    // 同步全屏播放器进度和歌词
    if (fullPlayerOpen) {
        updateFullPlayerProgress();
        syncLyricsHighlight(audioEl.currentTime * 1000);
    }
}

// 点击进度条跳转播放位置
function seekPlayerProgress(event) {
    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));

    let audioEl = null;
    if (currentPlayerSource === 'sr' && srAudioElement) audioEl = srAudioElement;
    else if (currentPlayerSource === 'lb' && lbAudioElement) audioEl = lbAudioElement;
    else if (currentPlayerSource === 'sl' && audioElement) audioEl = audioElement;

    if (audioEl && audioEl.duration && !isNaN(audioEl.duration)) {
        audioEl.currentTime = pct * audioEl.duration;
    }
}

// 音量控制
function onVolumeChange(value) {
    const vol = parseInt(value) / 100;
    let audioEl = null;
    if (currentPlayerSource === 'sr' && srAudioElement) audioEl = srAudioElement;
    else if (currentPlayerSource === 'lb' && lbAudioElement) audioEl = lbAudioElement;
    else if (currentPlayerSource === 'sl' && audioElement) audioEl = audioElement;
    if (audioEl) audioEl.volume = vol;
}

// 获取当前播放列表和播放函数
function getCurrentPlayContext() {
    switch (currentPlayerSource) {
        case 'sr': return {
            list: searchResults, current: srCurrentSong, playFn: srPlaySong,
            shuffleList: typeof srShuffleList !== 'undefined' ? srShuffleList : null,
            shuffleIndex: typeof srShuffleIndex !== 'undefined' ? srShuffleIndex : -1
        };
        case 'lb': return {
            list: lbSongs, current: lbCurrentSong, playFn: lbPlaySong,
            shuffleList: typeof lbShuffleList !== 'undefined' ? lbShuffleList : null,
            shuffleIndex: typeof lbShuffleIndex !== 'undefined' ? lbShuffleIndex : -1
        };
        default: return {
            list: slDetailSongs, current: currentPlaySong, playFn: slPlaySong,
            shuffleList: typeof slShuffleList !== 'undefined' ? slShuffleList : null,
            shuffleIndex: typeof slShuffleIndex !== 'undefined' ? slShuffleIndex : -1
        };
    }
}

// 上一首
function prevCurrentPlayer() {
    const ctx = getCurrentPlayContext();
    if (!ctx.list || ctx.list.length === 0) return;
    if (ctx.shuffleList && ctx.shuffleList.length > 1) {
        const newIdx = (ctx.shuffleIndex - 1 + ctx.shuffleList.length) % ctx.shuffleList.length;
        ctx.playFn(ctx.shuffleList[newIdx]);
    } else {
        const idx = ctx.list.indexOf(ctx.current);
        const newIdx = idx <= 0 ? ctx.list.length - 1 : idx - 1;
        ctx.playFn(newIdx);
    }
}

// 下一首
function nextCurrentPlayer() {
    const ctx = getCurrentPlayContext();
    if (!ctx.list || ctx.list.length === 0) return;
    if (ctx.shuffleList && ctx.shuffleList.length > 1) {
        const newIdx = (ctx.shuffleIndex + 1) % ctx.shuffleList.length;
        ctx.playFn(ctx.shuffleList[newIdx]);
    } else {
        const idx = ctx.list.indexOf(ctx.current);
        const newIdx = idx >= ctx.list.length - 1 ? 0 : idx + 1;
        ctx.playFn(newIdx);
    }
}

// 通用播放控制函数（供迷你播放器按钮调用）
function toggleCurrentPlayer() {
    switch (currentPlayerSource) {
        case 'sr': srTogglePlay(); break;
        case 'lb': lbTogglePlay(); break;
        default: slTogglePlay(); break;
    }
}

function stopCurrentPlayer() {
    switch (currentPlayerSource) {
        case 'sr': srStopPlay(); break;
        case 'lb': lbStopPlay(); break;
        default: slStopPlay(); break;
    }
}

// ============ 播放器增强功能 ============

/** 获取当前活跃的 audio 元素 */
function getActiveAudio() {
    if (currentPlayerSource === 'sr' && srAudioElement) return srAudioElement;
    if (currentPlayerSource === 'lb' && lbAudioElement) return lbAudioElement;
    if (currentPlayerSource === 'sl' && audioElement) return audioElement;
    return null;
}

/** 获取当前播放的歌曲对象 */
function getActiveSong() {
    if (currentPlayerSource === 'sr') return srCurrentSong;
    if (currentPlayerSource === 'lb') return lbCurrentSong;
    return currentPlaySong;
}

/** 更新播放器显示信息（名称、歌手、badges、状态） */
function updatePlayerDisplay(song) {
    if (!song) return;
    const quality = getBestQuality(song);
    const qualityLabel = getQualityLabel(quality);

    // 迷你播放器
    const coverEl = document.getElementById('playerCover');
    const nameEl = document.getElementById('playerName');
    const singerEl = document.getElementById('playerSinger');
    const badgesEl = document.getElementById('playerBadges');
    const statusEl = document.getElementById('playerStatus');
    if (coverEl) coverEl.src = song.img || '';
    if (nameEl) nameEl.textContent = song.name || '';
    if (singerEl) singerEl.textContent = song.singer || '';
    if (badgesEl) badgesEl.innerHTML = renderBadges(song.source, quality);
    if (statusEl) statusEl.textContent = qualityLabel ? '播放中 (' + qualityLabel + ')' : '播放中';

    // 全屏播放器
    const fpCover = document.getElementById('fpCover');
    const fpName = document.getElementById('fpName');
    const fpSinger = document.getElementById('fpSinger');
    const fpBadges = document.getElementById('fpBadges');
    if (fpCover) fpCover.src = song.img || '';
    if (fpName) fpName.textContent = song.name || '';
    if (fpSinger) fpSinger.textContent = song.singer || '';
    if (fpBadges) fpBadges.innerHTML = renderBadges(song.source, quality);
}

/** 同步播放/暂停按钮图标（迷你 + 全屏） */
function syncPlayButtons(playing) {
    const icon = playing ? 'pause' : 'play_arrow';
    ['playerPlayBtn', 'fpPlayBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            const span = btn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = icon;
        }
    });
}

/** 循环模式切换：off → all → one */
function toggleRepeatMode() {
    if (repeatMode === 'off') repeatMode = 'all';
    else if (repeatMode === 'all') repeatMode = 'one';
    else repeatMode = 'off';

    const audio = getActiveAudio();
    if (audio) audio.loop = (repeatMode === 'one');

    // 更新按钮状态
    updateRepeatButtons();
}

function updateRepeatButtons() {
    const icon = repeatMode === 'one' ? 'repeat_one' : 'repeat';
    const active = repeatMode !== 'off';
    ['playerRepeatBtn', 'fpRepeatBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.classList.toggle('repeat-active', active);
            const span = btn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = icon;
        }
    });
}

/** 播放速度切换 */
function cycleSpeed() {
    currentSpeedIndex = (currentSpeedIndex + 1) % speedOptions.length;
    const speed = speedOptions[currentSpeedIndex];
    const audio = getActiveAudio();
    if (audio) audio.playbackRate = speed;

    const label = speed === 1.0 ? '1.0x' : speed + 'x';
    const isActive = speed !== 1.0;
    ['playerSpeedBtn', 'fpSpeedBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.textContent = label;
            btn.classList.toggle('speed-active', isActive);
        }
    });
}

/** 全屏播放器切换 */
function toggleFullPlayer() {
    const fp = document.getElementById('fullPlayer');
    if (!fp) return;
    fullPlayerOpen = !fullPlayerOpen;
    fp.style.display = fullPlayerOpen ? '' : 'none';

    if (fullPlayerOpen) {
        // 同步当前歌曲信息到全屏
        const song = getActiveSong();
        if (song) {
            updatePlayerDisplay(song);
            // 获取歌词
            fetchAndDisplayLyrics(song);
        }
        // 同步进度
        updateFullPlayerProgress();
    }
}

function onFullPlayerBackdropClick(event) {
    if (event.target === event.currentTarget) toggleFullPlayer();
}

function closeFullPlayer() {
    if (!fullPlayerOpen) return;
    fullPlayerOpen = false;
    const fp = document.getElementById('fullPlayer');
    if (fp) fp.style.display = 'none';
}

function updateFullPlayerProgress() {
    const audio = getActiveAudio();
    const fpBar = document.getElementById('fpProgressBarFill');
    const fpCurrent = document.getElementById('fpTimeCurrent');
    const fpTotal = document.getElementById('fpTimeTotal');
    if (!audio || !audio.duration || isNaN(audio.duration)) {
        if (fpBar) fpBar.style.width = '0%';
        if (fpCurrent) fpCurrent.textContent = '0:00';
        if (fpTotal) fpTotal.textContent = '0:00';
        return;
    }
    const pct = (audio.currentTime / audio.duration) * 100;
    if (fpBar) fpBar.style.width = pct + '%';
    if (fpCurrent) fpCurrent.textContent = formatDuration(Math.floor(audio.currentTime));
    if (fpTotal) fpTotal.textContent = formatDuration(Math.floor(audio.duration));
}

// ============ 歌词系统 ============

/** 获取并显示歌词 */
async function fetchAndDisplayLyrics(song) {
    if (!song) return;
    const key = getSongKey(song);
    const lyricsEl = document.getElementById('fpLyrics');

    // 检查缓存
    if (lyricsCache[key] !== undefined) {
        parsedLyrics = parseLRC(lyricsCache[key]);
        renderLyricsLines(lyricsEl);
        return;
    }

    // 递增请求令牌，取消旧请求
    const myRequestId = ++lyricsRequestId;

    if (lyricsEl) lyricsEl.innerHTML = '<div class="fp-lyrics-placeholder">歌词加载中...</div>';

    try {
        // 构建歌词请求参数
        const params = new URLSearchParams();
        params.set('source', song.source || '');
        if (song.musicId) params.set('musicId', song.musicId);
        if (song.songmid) params.set('songmid', song.songmid || song.musicId);
        if (song.hash) params.set('hash', song.hash);
        if (song.copyrightId) params.set('copyrightId', song.copyrightId);
        if (song.name) params.set('name', song.name);
        if (song.singer) params.set('singer', song.singer);
        if (song.album) params.set('album', song.album);
        if (song.duration) params.set('duration', String(song.duration));

        const resp = await apiGet('/direct/lyric?' + params.toString());

        // 检查是否已被更新的请求取代
        if (myRequestId !== lyricsRequestId) return;

        const lrc = resp?.data?.lyric || resp?.lyric || '';
        lyricsCache[key] = lrc;
        parsedLyrics = parseLRC(lrc);
        renderLyricsLines(lyricsEl);
    } catch (e) {
        if (myRequestId !== lyricsRequestId) return;
        console.error('歌词获取失败:', e);
        if (lyricsEl) lyricsEl.innerHTML = '<div class="fp-lyrics-placeholder">暂无歌词</div>';
        parsedLyrics = [];
        lyricsCache[key] = '';
    }
}

/** 解析 LRC 歌词文本 */
function parseLRC(lrc) {
    if (!lrc) return [];
    const lines = lrc.split('\n');
    const result = [];
    const timeRe = /\[(\d{1,2}):(\d{2})[.:](\d{1,3})\]/g;

    for (const line of lines) {
        const text = line.replace(/\[\d{1,2}:\d{2}[.:]\d{1,3}\]/g, '').trim();
        if (!text) continue;
        // 跳过 LRC 头标签
        if (/^\[(ti|ar|al|offset|by|hash|id):/i.test(line)) continue;

        let match;
        timeRe.lastIndex = 0;
        while ((match = timeRe.exec(line)) !== null) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            let ms = parseInt(match[3], 10);
            if (match[3].length === 2) ms *= 10; // 两位毫秒补零
            if (match[3].length === 1) ms *= 100; // 一位毫秒
            const time = min * 60000 + sec * 1000 + ms;
            result.push({ time, text });
        }
    }

    result.sort((a, b) => a.time - b.time);
    return result;
}

/** 渲染歌词行到 DOM */
function renderLyricsLines(container) {
    if (!container) return;
    if (parsedLyrics.length === 0) {
        container.innerHTML = '<div class="fp-lyrics-placeholder">暂无歌词</div>';
        return;
    }
    container.innerHTML = parsedLyrics.map((line, i) =>
        '<div class="fp-lyric-line" data-index="' + i + '" onclick="seekToLyricLine(' + i + ')">' + escapeHtml(line.text) + '</div>'
    ).join('');
    currentLyricIndex = -1;
}

/** 点击歌词行跳转到对应时间 */
function seekToLyricLine(index) {
    if (index < 0 || index >= parsedLyrics.length) return;
    const audio = getActiveAudio();
    if (audio && audio.duration) {
        audio.currentTime = parsedLyrics[index].time / 1000;
    }
}

/** 同步歌词高亮（在 updatePlayerProgress 中调用） */
function syncLyricsHighlight(currentTimeMs) {
    if (!fullPlayerOpen || parsedLyrics.length === 0) return;

    let newIndex = -1;
    for (let i = parsedLyrics.length - 1; i >= 0; i--) {
        if (currentTimeMs >= parsedLyrics[i].time) {
            newIndex = i;
            break;
        }
    }

    if (newIndex === currentLyricIndex) return;
    currentLyricIndex = newIndex;

    const container = document.getElementById('fpLyrics');
    if (!container) return;
    const lines = container.querySelectorAll('.fp-lyric-line');
    lines.forEach((el, i) => {
        el.classList.toggle('active', i === newIndex);
    });

    // 滚动到当前行
    if (newIndex >= 0 && lines[newIndex]) {
        lines[newIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ============ 热门歌曲（使用排行榜 API） ============

let hotSearchSongs = [];
let hotSearchLoaded = false;

async function loadHotSearch() {
    const grid = document.getElementById('hotSearchGrid');
    if (!grid) return;

    grid.innerHTML = '<div class="hot-search-loading"><span class="spinner"></span>加载中...</div>';

    try {
        // 获取第一个平台的排行榜列表
        const platformId = currentPlatforms.length > 0 ? currentPlatforms[0].id : 'kg';
        const boardsResult = await apiGet(`/leaderboard/boards?source_id=${platformId}`);

        if (boardsResult.code !== 0 || !boardsResult.data || boardsResult.data.length === 0) {
            grid.innerHTML = '<div class="hot-search-loading"><span class="material-symbols-outlined" style="font-size:32px;opacity:0.4">music_off</span>暂无热门歌曲</div>';
            return;
        }

        // 取第一个榜单（通常是"热歌榜"或"新歌榜"）
        const firstBoard = boardsResult.data[0];
        const params = new URLSearchParams({
            source_id: platformId,
            board_id: firstBoard.id,
            page: 1
        });
        const listResult = await apiGet(`/leaderboard/list?${params}`);

        if (listResult.code === 0 && listResult.data && listResult.data.list) {
            hotSearchSongs = listResult.data.list.slice(0, 20);
            hotSearchLoaded = true;
            renderHotSearchGrid(platformId);
        } else {
            grid.innerHTML = '<div class="hot-search-loading"><span class="material-symbols-outlined" style="font-size:32px;opacity:0.4">music_off</span>加载失败</div>';
        }
    } catch (e) {
        grid.innerHTML = '<div class="hot-search-loading"><span class="material-symbols-outlined" style="font-size:32px;opacity:0.4">error</span>加载失败: ' + escapeHtml(e.message) + '</div>';
    }
}

function renderHotSearchGrid(platformId) {
    const grid = document.getElementById('hotSearchGrid');
    if (!grid || hotSearchSongs.length === 0) {
        if (grid) grid.innerHTML = '<div class="hot-search-loading"><span class="material-symbols-outlined" style="font-size:32px;opacity:0.4">music_off</span>暂无热门歌曲</div>';
        return;
    }

    grid.innerHTML = hotSearchSongs.map((song, i) => {
        const rankClass = i < 3 ? ` top-${i + 1}` : '';
        const name = song.name || '';
        const singer = song.singer || '';
        return `
            <div class="hot-search-item animate-slide-up" style="animation-delay:${Math.min(i, 15) * 0.03}s" onclick="onHotSearchItemClick(${i})">
                <span class="hot-search-rank${rankClass}">${i + 1}</span>
                <span class="hot-search-name" title="${escapeHtml(name)} - ${escapeHtml(singer)}">${escapeHtml(name)}</span>
                <span class="material-symbols-outlined hot-search-icon">search</span>
            </div>
        `;
    }).join('');
}

function onHotSearchItemClick(index) {
    const song = hotSearchSongs[index];
    if (!song) return;

    // 设置搜索关键词
    const keywordInput = document.getElementById('keyword');
    if (keywordInput) keywordInput.value = song.name || '';

    // 选择对应平台
    const platformId = currentPlatforms.length > 0 ? currentPlatforms[0].id : 'kg';
    const platformSelect = document.getElementById('platformSelect');
    if (platformSelect) platformSelect.value = platformId;

    // 触发搜索
    search(song.name || '', platformId, 1);
}

function initSonglistTab() {
    // 模式切换
    document.querySelectorAll('.segment-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const mode = this.dataset.mode;
            switchSonglistMode(mode);
        });
    });

    // 平台切换
    document.getElementById('slPlatformSelect').addEventListener('change', function () {
        slCurrentPlatform = this.value;
        slTagsLoaded = false;
        slCurrentSortId = '';
        slCurrentTagId = '';
        if (slCurrentMode === 'recommend') {
            loadSonglistTagsAndList();
        }
    });

    // 搜索按钮
    document.getElementById('slActionBtn').addEventListener('click', slDoAction);

    // 搜索输入框回车
    document.getElementById('slSearchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') slDoAction();
    });
    document.getElementById('slParseInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') slDoAction();
    });

    // 歌单列表内搜索
    const gridSearchInput = document.getElementById('slGridSearchInput');
    if (gridSearchInput) {
        gridSearchInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                const keyword = this.value.trim();
                if (keyword) {
                    switchSonglistMode('search');
                    document.getElementById('slSearchInput').value = keyword;
                    slSearchSonglist(keyword, 1);
                }
            }
        });
    }

    // 全选
    document.getElementById('slSelectAll').addEventListener('change', slToggleSelectAll);

    // 导入
    document.getElementById('slImportBtn').addEventListener('click', slImportSelectedSongs);

    // 歌单选择变化
    document.getElementById('slPlaylistSelect').addEventListener('change', function () {
        const wrapper = document.getElementById('slNewPlaylistWrapper');
        const nameInput = document.getElementById('slNewPlaylistName');
        if (this.value === '__new__') {
            wrapper.style.display = 'flex';
            // 回填当前歌单名称为默认歌单名
            if (nameInput && slDetailInfo && slDetailInfo.name) {
                nameInput.value = slDetailInfo.name;
            }
        } else {
            wrapper.style.display = 'none';
        }
    });

    // 播放全部和随机播放按钮
    const slPlayAllBtn = document.getElementById('slPlayAllBtn');
    if (slPlayAllBtn) slPlayAllBtn.addEventListener('click', slPlayAll);
    const slShuffleBtn = document.getElementById('slShuffleBtn');
    if (slShuffleBtn) slShuffleBtn.addEventListener('click', slShufflePlay);
}

function switchSonglistMode(mode) {
    slCurrentMode = mode;
    document.querySelectorAll('.segment-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    const searchWrapper = document.getElementById('slSearchWrapper');
    const parseWrapper = document.getElementById('slParseWrapper');
    const actionBtn = document.getElementById('slActionBtn');
    const filterBtn = document.getElementById('slFilterBtn');
    const sortChips = document.getElementById('slSortChips');

    searchWrapper.style.display = 'none';
    parseWrapper.style.display = 'none';
    actionBtn.style.display = 'none';
    filterBtn.style.display = 'none';
    sortChips.style.display = 'none';

    // 切换模式时关闭抽屉、隐藏详情、显示列表
    slCloseTagDrawer();
    document.getElementById('slDetailCard').style.display = 'none';

    if (mode === 'recommend') {
        filterBtn.style.display = '';
        sortChips.style.display = '';
        loadSonglistTagsAndList();
    } else if (mode === 'search') {
        searchWrapper.style.display = '';
        actionBtn.style.display = '';
        actionBtn.textContent = '搜索';
        document.getElementById('slListCard').style.display = 'none';
    } else if (mode === 'parse') {
        parseWrapper.style.display = '';
        actionBtn.style.display = '';
        actionBtn.textContent = '解析';
        document.getElementById('slListCard').style.display = 'none';
    }
}

function slDoAction() {
    if (slCurrentMode === 'search') {
        const keyword = document.getElementById('slSearchInput').value.trim();
        if (!keyword) { showSnackbar('请输入搜索关键词', 'warning'); return; }
        slSearchSonglist(keyword, 1);
    } else if (slCurrentMode === 'parse') {
        const link = document.getElementById('slParseInput').value.trim();
        if (!link) { showSnackbar('请输入歌单链接', 'warning'); return; }
        slParseSonglistLink(link);
    }
}

// 加载标签和列表
async function loadSonglistTagsAndList() {
    if (!slTagsLoaded) {
        await Promise.all([slLoadTags(), slLoadSorts()]);
        slTagsLoaded = true;
    }
    slLoadList(1);
}

async function slLoadTags() {
    try {
        const result = await apiGet(`/songlist/tags?source_id=${slCurrentPlatform}`);
        if (result.code === 0) {
            slTags = result.data;
            slRenderTagChips();
            document.getElementById('slFilterBtn').style.display = '';
        }
    } catch (e) {
        console.error('加载标签失败:', e);
    }
}

async function slLoadSorts() {
    try {
        const result = await apiGet(`/songlist/sorts?source_id=${slCurrentPlatform}`);
        if (result.code === 0) {
            slSortList = result.data || [];
            if (slSortList.length > 0) slCurrentSortId = slSortList[0].id;
            slRenderSortChips();
        }
    } catch (e) {
        console.error('加载排序失败:', e);
    }
}

function slRenderSortChips() {
    const container = document.getElementById('slSortChips');
    if (!slSortList || slSortList.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = slSortList.map(s =>
        `<button class="tag-chip${s.id === slCurrentSortId ? ' active' : ''}" data-sort-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`
    ).join('');
    container.querySelectorAll('.tag-chip').forEach(chip => {
        chip.addEventListener('click', function () {
            slCurrentSortId = this.dataset.sortId;
            slRenderSortChips();
            slLoadList(1);
        });
    });
}

function slRenderTagChips() {
    const container = document.getElementById('slTagChips');
    if (!slTags) { container.innerHTML = ''; return; }

    let html = '';

    // 热门标签
    if (slTags.hot && slTags.hot.length > 0) {
        html += '<div class="tag-group-title">热门</div><div class="tag-group-chips">';
        html += `<button class="tag-chip${slCurrentTagId === '' ? ' active' : ''}" data-tag-id="">全部</button>`;
        html += slTags.hot.map(t =>
            `<button class="tag-chip${t.id === slCurrentTagId ? ' active' : ''}" data-tag-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>`
        ).join('');
        html += '</div>';
    }

    // 分组标签
    if (slTags.tags && slTags.tags.length > 0) {
        slTags.tags.forEach(group => {
            if (!group.list || group.list.length === 0) return;
            html += `<div class="tag-group-title">${escapeHtml(group.name)}</div><div class="tag-group-chips">`;
            html += group.list.map(t =>
                `<button class="tag-chip${t.id === slCurrentTagId ? ' active' : ''}" data-tag-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>`
            ).join('');
            html += '</div>';
        });
    }

    container.innerHTML = html;
    container.querySelectorAll('.tag-chip').forEach(chip => {
        chip.addEventListener('click', function () {
            slCurrentTagId = this.dataset.tagId;
            slRenderTagChips();
            slLoadList(1);
        });
    });
}

async function slLoadList(page) {
    slCurrentPage = page;
    const listCard = document.getElementById('slListCard');
    const grid = document.getElementById('slGrid');
    listCard.style.display = '';
    grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>加载中...</p></div>';

    try {
        const params = new URLSearchParams({
            source_id: slCurrentPlatform,
            sort_id: slCurrentSortId,
            tag_id: slCurrentTagId,
            page: page
        });
        const result = await apiGet(`/songlist/list?${params}`);
        if (result.code === 0) {
            slSongLists = result.data.list || [];
            slTotalResults = result.data.total || 0;
            slRenderGrid();
        } else {
            grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
        }
    } catch (e) {
        grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败: ' + escapeHtml(e.message) + '</p></div>';
    }
}

async function slSearchSonglist(keyword, page) {
    slCurrentPage = page;
    const listCard = document.getElementById('slListCard');
    const grid = document.getElementById('slGrid');
    listCard.style.display = '';
    grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>搜索中...</p></div>';

    const actionBtn = document.getElementById('slActionBtn');
    actionBtn.disabled = true;
    actionBtn.innerHTML = '<span class="spinner"></span>';

    try {
        const params = new URLSearchParams({ source_id: slCurrentPlatform, keyword, page });
        const result = await apiGet(`/songlist/search?${params}`);
        if (result.code === 0) {
            slSongLists = result.data.list || [];
            slTotalResults = result.data.total || 0;
            slRenderGrid();
            document.getElementById('slListCount').textContent = `共 ${slTotalResults} 条`;
        } else {
            grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>搜索失败</p></div>';
        }
    } catch (e) {
        grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>搜索失败: ' + escapeHtml(e.message) + '</p></div>';
    } finally {
        actionBtn.disabled = false;
        actionBtn.textContent = '搜索';
    }
}

async function slParseSonglistLink(link) {
    const actionBtn = document.getElementById('slActionBtn');
    actionBtn.disabled = true;
    actionBtn.innerHTML = '<span class="spinner"></span>';

    try {
        const params = new URLSearchParams({ source_id: slCurrentPlatform, id: link, page: 1 });
        const result = await apiGet(`/songlist/detail?${params}`);
        if (result.code === 0) {
            slDetailSongs = result.data.list || [];
            slDetailInfo = result.data.info || {};
            slDetailPage = 1;
            slDetailTotal = result.data.total || 0;
            slShowDetail();
        } else {
            showSnackbar('解析失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('解析失败: ' + e.message, 'error');
    } finally {
        actionBtn.disabled = false;
        actionBtn.textContent = '解析';
    }
}

function slRenderGrid() {
    const grid = document.getElementById('slGrid');
    const countEl = document.getElementById('slListCount');

    if (slSongLists.length === 0) {
        grid.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">queue_music</span><p>暂无歌单</p></div>';
        countEl.textContent = '';
        document.getElementById('slPagination').innerHTML = '';
        return;
    }

    countEl.textContent = slTotalResults > 0 ? `共 ${slTotalResults} 条` : '';

    grid.innerHTML = slSongLists.map((item, i) => {
        const img = item.img
            ? `<img class="songlist-cover" src="${escapeHtml(item.img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : '<div class="songlist-cover" style="display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:40px;color:var(--md-outline)">queue_music</span></div>';
        const playCount = item.play_count || item.playCount || '';
        const songCount = item.song_count || item.total || item.count || '';
        const overlayHtml = playCount
            ? `<div class="songlist-card-overlay">
                   <span><span class="material-symbols-outlined">headphones</span>${escapeHtml(playCount)}</span>
               </div>`
            : '';
        return `
            <div class="songlist-card animate-slide-up" data-index="${i}" onclick="slOpenDetail('${escapeHtml(item.id)}')" style="animation-delay:${Math.min(i, 12) * 0.05}s">
                <div class="songlist-cover-wrap">
                    ${img}
                    ${overlayHtml}
                </div>
                <div class="songlist-card-body">
                    <div class="songlist-name">${escapeHtml(item.name)}</div>
                    ${item.author ? `<div class="songlist-card-author">${escapeHtml(item.author)}</div>` : ''}
                    <div class="songlist-card-stats">
                        ${songCount ? `<span><span class="material-symbols-outlined" style="font-size:13px">music_note</span>${escapeHtml(songCount)}</span>` : ''}
                        ${playCount ? `<span><span class="material-symbols-outlined" style="font-size:13px">headphones</span>${escapeHtml(playCount)}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    slRenderListPagination();
}

function slRenderListPagination() {
    const container = document.getElementById('slPagination');
    const limit = 30;
    const totalPages = Math.max(1, Math.ceil(slTotalResults / limit));
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    const prevDisabled = slCurrentPage <= 1 ? 'disabled' : '';
    const nextDisabled = slCurrentPage >= totalPages ? 'disabled' : '';

    container.innerHTML = `
        <button class="btn-icon" title="上一页" ${prevDisabled} onclick="slPageNav(${slCurrentPage - 1})">
            <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <span class="page-info">第 ${slCurrentPage} / ${totalPages} 页</span>
        <button class="btn-icon" title="下一页" ${nextDisabled} onclick="slPageNav(${slCurrentPage + 1})">
            <span class="material-symbols-outlined">chevron_right</span>
        </button>
    `;
}

function slPageNav(page) {
    if (slCurrentMode === 'search') {
        const keyword = document.getElementById('slSearchInput').value.trim();
        slSearchSonglist(keyword, page);
    } else {
        slLoadList(page);
    }
}

async function slOpenDetail(id) {
    // 推入子页面历史记录
    if (!window._isPopState) {
        history.pushState({ tab: 'songlist', detail: id }, '', '#songlist-detail');
    }

    // 清理旧的导入进度
    resetImportProgress('slImportProgress', 'slProgressFill', 'slProgressText', 'slImportResults');

    const detailCard = document.getElementById('slDetailCard');
    const listCard = document.getElementById('slListCard');
    const detailList = document.getElementById('slDetailList');

    detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>加载中...</p></div>';
    detailCard.style.display = '';
    listCard.style.display = 'none';
    document.getElementById('slFilterBtn').style.display = 'none';
    document.getElementById('slSortChips').style.display = 'none';
    slCloseTagDrawer();

    slSelectedSongs.clear();
    slUpdateSelectedCount();

    // 初始化返回顶部按钮
    initBackToTop();

    try {
        const params = new URLSearchParams({ source_id: slCurrentPlatform, id, page: 1 });
        const result = await apiGet(`/songlist/detail?${params}`);
        if (result.code === 0) {
            slDetailSongs = result.data.list || [];
            slDetailInfo = result.data.info || {};
            slDetailPage = 1;
            slDetailTotal = result.data.total || 0;
            slCurrentDetailId = id;
            slShowDetail();
        } else {
            detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
        }
    } catch (e) {
        detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败: ' + escapeHtml(e.message) + '</p></div>';
    }
}

let slCurrentDetailId = '';

function slShowDetail() {
    const detailCard = document.getElementById('slDetailCard');
    const listCard = document.getElementById('slListCard');

    detailCard.style.display = '';
    listCard.style.display = 'none';
    document.getElementById('slFilterBtn').style.display = 'none';
    document.getElementById('slSortChips').style.display = 'none';
    slCloseTagDrawer();

    // 渲染歌单信息
    const infoEl = document.getElementById('slDetailInfo');
    if (slDetailInfo && (slDetailInfo.name || slDetailInfo.img)) {
        const img = slDetailInfo.img
            ? `<img class="songlist-info-cover" src="${escapeHtml(slDetailInfo.img)}" alt="" onerror="this.style.display='none'">`
            : '<div class="songlist-info-cover" style="display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:48px;color:var(--md-outline)">queue_music</span></div>';
        const playCount = slDetailInfo.play_count || slDetailInfo.playCount || '';
        const songCount = slDetailInfo.song_count || slDetailInfo.total || slDetailInfo.count || (slDetailTotal > 0 ? slDetailTotal : '');
        const createTime = slDetailInfo.create_time || slDetailInfo.createTime || '';
        const descText = slDetailInfo.desc || slDetailInfo.description || '';
        infoEl.innerHTML = `
            ${img}
            <div class="songlist-info-detail">
                <div class="songlist-info-name">${escapeHtml(slDetailInfo.name || '')}</div>
                <div class="songlist-info-author">
                    ${slDetailInfo.author ? escapeHtml(slDetailInfo.author) : ''}
                    ${createTime ? ' · ' + escapeHtml(createTime) : ''}
                </div>
                <div class="songlist-info-stats">
                    ${songCount ? `<span><span class="material-symbols-outlined">music_note</span>${escapeHtml(songCount)} 首</span>` : ''}
                    ${playCount ? `<span><span class="material-symbols-outlined">headphones</span>${escapeHtml(playCount)}</span>` : ''}
                </div>
                ${descText ? `<div class="songlist-info-desc" onclick="this.classList.toggle('expanded')">${escapeHtml(descText)}<span class="expand-link">展开全部 ▼</span></div>` : ''}
            </div>
        `;
    } else {
        infoEl.innerHTML = '';
    }

    // 渲染歌曲列表
    slRenderDetailList();

    // 渲染歌单选择（复用主页的歌单数据）
    const select = document.getElementById('slPlaylistSelect');
    let html = '<option value="">不添加到歌单</option>';
    if (Array.isArray(playlists)) {
        for (const pl of playlists) {
            html += `<option value="${pl.id}">${escapeHtml(pl.name)}</option>`;
        }
    }
    html += '<option value="__new__">+ 新建歌单...</option>';
    select.innerHTML = html;

    // 如果有音频正在播放或加载中，显示迷你播放器
    if (currentPlaySong || srCurrentSong || lbCurrentSong) {
        showMiniPlayer();
        syncPlayerPadding();
    }
}

function slRenderDetailList() {
    const container = document.getElementById('slDetailList');

    if (slDetailSongs.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">music_off</span><p>暂无歌曲</p></div>';
        document.getElementById('slDetailPagination').innerHTML = '';
        return;
    }

    container.innerHTML = slDetailSongs.map((song, i) => {
        const key = getSongKey(song);
        const checked = slSelectedSongs.has(key) ? 'checked' : '';
        const selectedClass = slSelectedSongs.has(key) ? ' selected' : '';
        const playingClass = (currentPlaySong && getSongKey(song) === getSongKey(currentPlaySong)) ? ' playing' : '';
        const imgHtml = song.img
            ? `<img src="${escapeHtml(song.img)}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<span class=\\'material-symbols-outlined\\'>music_note</span>'">`
            : '<span class="material-symbols-outlined">music_note</span>';
        const playIcon = (currentPlaySong && getSongKey(song) === getSongKey(currentPlaySong) && isPlaying) ? 'pause' : 'play_arrow';
        const badgesHtml = renderBadges(song.source, getBestQuality(song));
        return `
            <div class="result-item${selectedClass}${playingClass} animate-slide-up" data-index="${i}" style="animation-delay:${Math.min(i, 15) * 0.03}s">
                <div class="col-index">
                    <input type="checkbox" class="sl-detail-checkbox" data-index="${i}" ${checked}
                        onchange="slOnSongCheckChanged(${i}, this.checked)" style="accent-color:var(--md-primary);width:18px;height:18px;cursor:pointer">
                </div>
                <div class="col-title">
                    <div class="result-thumb">${imgHtml}</div>
                    <div class="result-title-wrap">
                        <div class="result-name">${escapeHtml(song.name)}${badgesHtml}</div>
                    </div>
                </div>
                <div class="col-artist">${escapeHtml(song.singer || '')}</div>
                <div class="col-album">${escapeHtml(song.album || '')}</div>
                <div class="col-duration">${formatDuration(song.duration)}</div>
                <div class="col-actions">
                    <button class="play-btn" onclick="slPlaySong(${i})" title="播放">
                        <span class="material-symbols-outlined">${playIcon}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // 同步全选状态
    const allChecked = slDetailSongs.every(s => slSelectedSongs.has(getSongKey(s)));
    document.getElementById('slSelectAll').checked = allChecked && slDetailSongs.length > 0;

    slRenderDetailPagination();
}

function slOnSongCheckChanged(index, checked) {
    const song = slDetailSongs[index];
    const key = getSongKey(song);
    if (checked) slSelectedSongs.set(key, song);
    else slSelectedSongs.delete(key);
    const row = document.querySelectorAll('#slDetailList .result-item')[index];
    if (row) row.classList.toggle('selected', checked);
    slUpdateSelectedCount();
    const allChecked = slDetailSongs.every(s => slSelectedSongs.has(getSongKey(s)));
    document.getElementById('slSelectAll').checked = allChecked;
}

function slToggleSelectAll() {
    const checked = document.getElementById('slSelectAll').checked;
    slDetailSongs.forEach(song => {
        const key = getSongKey(song);
        if (checked) slSelectedSongs.set(key, song);
        else slSelectedSongs.delete(key);
    });
    slRenderDetailList();
    slUpdateSelectedCount();
}

function slUpdateSelectedCount() {
    const count = slSelectedSongs.size;
    const badge = document.getElementById('slSelectedBadge');
    if (badge) badge.textContent = count;
    document.getElementById('slImportBtn').disabled = count === 0;
}

function slRenderDetailPagination() {
    const container = document.getElementById('slDetailPagination');
    const limit = 50;
    const totalPages = Math.max(1, Math.ceil(slDetailTotal / limit));
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    const prevDisabled = slDetailPage <= 1 ? 'disabled' : '';
    const nextDisabled = slDetailPage >= totalPages ? 'disabled' : '';

    container.innerHTML = `
        <button class="btn-icon" title="上一页" ${prevDisabled} onclick="slDetailPageNav(${slDetailPage - 1})">
            <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <span class="page-info">第 ${slDetailPage} / ${totalPages} 页</span>
        <button class="btn-icon" title="下一页" ${nextDisabled} onclick="slDetailPageNav(${slDetailPage + 1})">
            <span class="material-symbols-outlined">chevron_right</span>
        </button>
    `;
}

async function slDetailPageNav(page) {
    if (!slCurrentDetailId) return;
    slDetailPage = page;
    const detailList = document.getElementById('slDetailList');
    detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>加载中...</p></div>';

    try {
        const params = new URLSearchParams({ source_id: slCurrentPlatform, id: slCurrentDetailId, page });
        const result = await apiGet(`/songlist/detail?${params}`);
        if (result.code === 0) {
            slDetailSongs = result.data.list || [];
            slDetailTotal = result.data.total || 0;
            slRenderDetailList();
        } else {
            detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
        }
    } catch (e) {
        detailList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
    }
}

function slOpenTagDrawer() {
    document.getElementById('slTagDrawerOverlay').classList.add('open');
    document.getElementById('slTagDrawer').classList.add('open');
}

function slCloseTagDrawer() {
    const overlay = document.getElementById('slTagDrawerOverlay');
    const drawer = document.getElementById('slTagDrawer');
    if (overlay) overlay.classList.remove('open');
    if (drawer) drawer.classList.remove('open');
}

function slBackToList() {
    // 直接按当前模式恢复 UI，不依赖 popstate 异步回调
    document.getElementById('slDetailCard').style.display = 'none';
    if (slCurrentMode === 'recommend') {
        document.getElementById('slListCard').style.display = '';
        document.getElementById('slFilterBtn').style.display = '';
        document.getElementById('slSortChips').style.display = '';
    } else if (slCurrentMode === 'search') {
        document.getElementById('slListCard').style.display = '';
        document.getElementById('slFilterBtn').style.display = 'none';
        document.getElementById('slSortChips').style.display = 'none';
    } else {
        // parse 模式没有列表
        document.getElementById('slListCard').style.display = 'none';
        document.getElementById('slFilterBtn').style.display = 'none';
        document.getElementById('slSortChips').style.display = 'none';
    }
    // 同步浏览器历史：如果是从 slOpenDetail pushState 进来的，弹出 detail 状态
    // 用标志位让 popstate 跳过 UI 操作，避免和上面的直接操作重复
    if (!window._isPopState && history.state && history.state.detail) {
        window._skipNextPopstate = true;
        history.back();
    }
    // 离开详情页时不停止播放，只隐藏详情页 UI，迷你播放器保持显示
    // 同步 padding
    syncPlayerPadding();
    // 隐藏返回顶部按钮
    hideBackToTop();
}

// ============ 统一回到顶部功能 ============

let _backToTopScrollHandler = null;
let _backToTopContainer = null;

function initBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    btn.classList.remove('show');
    btn.style.display = '';

    // 移除旧监听器
    if (_backToTopScrollHandler) {
        if (_backToTopContainer) {
            _backToTopContainer.removeEventListener('scroll', _backToTopScrollHandler);
        }
        window.removeEventListener('scroll', _backToTopScrollHandler);
        _backToTopScrollHandler = null;
        _backToTopContainer = null;
    }

    _backToTopScrollHandler = function() {
        const b = document.getElementById('backToTop');
        if (!b) return;
        // 同时检测容器滚动和 window 滚动
        if (_backToTopContainer && _backToTopContainer.scrollTop > _backToTopContainer.clientHeight) {
            b.classList.add('show');
        } else if (window.scrollY > window.innerHeight) {
            b.classList.add('show');
        } else {
            b.classList.remove('show');
        }
    };

    // 监听当前活动标签的内容区滚动（移动端）
    const container = document.querySelector('.tab-content.active');
    if (container) {
        _backToTopContainer = container;
        container.addEventListener('scroll', _backToTopScrollHandler);
    }
    // 同时监听 window 滚动（桌面端/WebView）
    window.addEventListener('scroll', _backToTopScrollHandler);

    // 点击返回顶部
    btn.addEventListener('click', function() {
        if (_backToTopContainer && _backToTopContainer.scrollTop > 0) {
            _backToTopContainer.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        setTimeout(() => {
            const b = document.getElementById('backToTop');
            if (b) b.classList.remove('show');
        }, 500);
    });
}

function hideBackToTop() {
    const btn = document.getElementById('backToTop');
    if (btn) {
        btn.classList.remove('show');
        btn.style.display = 'none';
    }
    if (_backToTopScrollHandler) {
        if (_backToTopContainer) {
            _backToTopContainer.removeEventListener('scroll', _backToTopScrollHandler);
        }
        window.removeEventListener('scroll', _backToTopScrollHandler);
        _backToTopScrollHandler = null;
        _backToTopContainer = null;
    }
}

// ============ 播放全部/随机播放 ============

function slPlayAll() {
    if (!slDetailSongs || slDetailSongs.length === 0) return;
    // 顺序播放全部：从第一首开始，自动播放下一首
    slShuffleList = slDetailSongs.map((_, i) => i);
    slCurrentShuffleIndex = 0;
    slPlaySong(0);
}

function slShufflePlay() {
    if (!slDetailSongs || slDetailSongs.length === 0) return;
    // 随机播放全部：生成随机顺序的索引列表
    slShuffleList = slDetailSongs.map((_, i) => i);
    // Fisher-Yates 洗牌算法
    for (let i = slShuffleList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slShuffleList[i], slShuffleList[j]] = [slShuffleList[j], slShuffleList[i]];
    }
    slCurrentShuffleIndex = 0;
    slPlaySong(slShuffleList[0]);
}

// ============ 搜索结果播放全部/随机播放 ============

function srPlayAll() {
    if (!searchResults || searchResults.length === 0) return;
    srShuffleList = searchResults.map((_, i) => i);
    srCurrentShuffleIndex = 0;
    srPlaySong(0);
}

function srShufflePlay() {
    if (!searchResults || searchResults.length === 0) return;
    srShuffleList = searchResults.map((_, i) => i);
    for (let i = srShuffleList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [srShuffleList[i], srShuffleList[j]] = [srShuffleList[j], srShuffleList[i]];
    }
    srCurrentShuffleIndex = 0;
    srPlaySong(srShuffleList[0]);
}

async function srPlaySong(index) {
    const song = searchResults[index];
    if (!song) return;

    if (srCurrentSong && getSongKey(song) === getSongKey(srCurrentSong)) {
        srTogglePlay();
        return;
    }

    srStopPlay();

    const quality = getBestQuality(song);

    const miniPlayer = document.getElementById('miniPlayer');
    const playerLoading = document.getElementById('playerLoading');
    showMiniPlayer();
    playerLoading.style.display = '';
    updatePlayerDisplay(song);

    try {
        const songInfo = {
            source: song.source,
            songmid: song.songmid || song.musicId,
            musicId: song.musicId || song.songmid,
            name: song.name,
            singer: song.singer,
            album: song.album || '',
            duration: song.duration,
        };
        if (song.hash) songInfo.hash = song.hash;
        if (song.albumId || song.album_id) songInfo.albumId = song.albumId || song.album_id;
        if (song.strMediaMid) songInfo.strMediaMid = song.strMediaMid;
        if (song.albumMid) songInfo.albumMid = song.albumMid;
        if (song.copyrightId) songInfo.copyrightId = song.copyrightId;

        const resp = await apiPost('/music/url', {
            source_data: {
                platform: song.source,
                quality: quality,
                songInfo: songInfo
            }
        });

        if (resp.url) {
            srCurrentSong = song;
            srIsPlaying = true;
            currentPlayerSource = 'sr';

            let audioUrl = resp.url;
            if (audioUrl.startsWith('http:')) {
                const token = getAuthToken();
                audioUrl = MAIN_API + '/proxy?url=' + encodeURIComponent(audioUrl) + '&access_token=' + encodeURIComponent(token);
            }

            srAudioElement = new Audio(audioUrl);
            srAudioElement.volume = 1.0;
            srAudioElement.playbackRate = speedOptions[currentSpeedIndex];
            srAudioElement.loop = (repeatMode === 'one');
            srAudioElement.addEventListener('timeupdate', updatePlayerProgress);

            srAudioElement.oncanplay = () => {
                srAudioElement.play().catch(e => {
                    console.error('播放失败:', e);
                    showSnackbar('播放失败: ' + e.message, 'error');
                    srStopPlay();
                });
            };

            srAudioElement.onended = () => {
                srIsPlaying = false;
                syncPlayButtons(false);
                if (repeatMode === 'all' || (srShuffleList.length > 0 && srCurrentShuffleIndex < srShuffleList.length - 1)) {
                    if (srShuffleList.length > 0 && srCurrentShuffleIndex < srShuffleList.length - 1) {
                        srCurrentShuffleIndex++;
                        srPlaySong(srShuffleList[srCurrentShuffleIndex]);
                    } else if (repeatMode === 'all') {
                        // 列表循环：回到第一首
                        srPlaySong(0);
                    } else {
                        srCurrentSong = null;
                        hideMiniPlayer();
                    }
                } else {
                    srCurrentSong = null;
                    hideMiniPlayer();
                    srShuffleList = [];
                    srCurrentShuffleIndex = 0;
                }
                srRenderResults();
            };

            playerLoading.style.display = 'none';
            srUpdatePlayBtn(true);
            syncPlayButtons(true);
            srRenderResults();
        } else {
            showSnackbar('获取播放链接失败', 'error');
            hideMiniPlayer();
        }
    } catch (e) {
        console.error('获取播放URL失败:', e);
        showSnackbar('获取播放链接失败: ' + e.message, 'error');
        hideMiniPlayer();
    }
}

function srTogglePlay() {
    if (!srAudioElement || !srCurrentSong) return;
    if (srIsPlaying) {
        srAudioElement.pause();
        srIsPlaying = false;
    } else {
        srAudioElement.play().catch(e => {
            console.error('播放失败:', e);
            showSnackbar('播放失败: ' + e.message, 'error');
        });
        srIsPlaying = true;
    }
    srUpdatePlayBtn(srIsPlaying);
    syncPlayButtons(srIsPlaying);
    srRenderResults();
}

function srStopPlay() {
    if (srAudioElement) {
        srAudioElement.pause();
        srAudioElement.src = '';
        srAudioElement = null;
    }
    // 停止其他页面的播放器
    if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
        audioElement = null;
    }
    if (lbAudioElement) {
        lbAudioElement.pause();
        lbAudioElement.src = '';
        lbAudioElement = null;
    }
    isPlaying = false;
    currentPlaySong = null;
    lbIsPlaying = false;
    lbCurrentSong = null;
    srIsPlaying = false;
    srCurrentSong = null;
    hideMiniPlayer();
    closeFullPlayer();
    srUpdatePlayBtn(false);
    syncPlayButtons(false);
    srRenderResults();
    lbRenderList();
    slRenderDetailList();
}

function srUpdatePlayBtn(playing) {
    const btn = document.getElementById('playerPlayBtn');
    if (btn) {
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
    }
}

function srRenderResults() {
    // 仅重新渲染列表，不重置分页等状态
    const container = document.getElementById('resultList');
    if (!container || !searchResults.length) return;

    container.innerHTML = searchResults.map((song, i) => {
        const key = getSongKey(song);
        const checked = selectedSongs.has(key) ? 'checked' : '';
        const selectedClass = selectedSongs.has(key) ? ' selected' : '';
        const playingClass = (srCurrentSong && getSongKey(song) === getSongKey(srCurrentSong)) ? ' playing' : '';
        const imgHtml = song.img
            ? `<img src="${escapeHtml(song.img)}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<span class=\\'material-symbols-outlined\\'>music_note</span>'">`
            : '<span class="material-symbols-outlined">music_note</span>';
        const playIcon = (srCurrentSong && getSongKey(song) === getSongKey(srCurrentSong) && srIsPlaying) ? 'pause' : 'play_arrow';
        const badgesHtml = renderBadges(song.source, getBestQuality(song));
        return `
            <div class="result-item${selectedClass}${playingClass} animate-slide-up" data-index="${i}" style="animation-delay:${Math.min(i, 15) * 0.03}s">
                <div class="col-index">
                    <input type="checkbox" class="result-checkbox" data-index="${i}" ${checked}
                        onchange="onSongCheckChanged(${i}, this.checked)" style="accent-color:var(--md-primary);width:18px;height:18px;cursor:pointer">
                </div>
                <div class="col-title">
                    <div class="result-thumb">${imgHtml}</div>
                    <div class="result-title-wrap">
                        <div class="result-name">${escapeHtml(song.name)}${badgesHtml}</div>
                    </div>
                </div>
                <div class="col-artist">${escapeHtml(song.singer || '')}</div>
                <div class="col-album">${escapeHtml(song.album || '')}</div>
                <div class="col-duration">${formatDuration(song.duration)}</div>
                <div class="col-actions">
                    <button class="play-btn sr-play-btn" data-index="${i}" title="播放">
                        <span class="material-symbols-outlined">${playIcon}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // 绑定搜索结果行播放按钮点击事件
    container.querySelectorAll('.sr-play-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.getAttribute('data-index'));
            srPlaySong(idx);
        });
    });
}

// ============ 排行榜播放全部/随机播放 ============

function lbPlayAll() {
    if (!lbSongs || lbSongs.length === 0) return;
    lbShuffleList = lbSongs.map((_, i) => i);
    lbCurrentShuffleIndex = 0;
    lbPlaySong(0);
}

function lbShufflePlay() {
    if (!lbSongs || lbSongs.length === 0) return;
    lbShuffleList = lbSongs.map((_, i) => i);
    for (let i = lbShuffleList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lbShuffleList[i], lbShuffleList[j]] = [lbShuffleList[j], lbShuffleList[i]];
    }
    lbCurrentShuffleIndex = 0;
    lbPlaySong(lbShuffleList[0]);
}

async function lbPlaySong(index) {
    const song = lbSongs[index];
    if (!song) return;

    if (lbCurrentSong && getSongKey(song) === getSongKey(lbCurrentSong)) {
        lbTogglePlay();
        return;
    }

    lbStopPlay();

    const quality = getBestQuality(song);

    const miniPlayer = document.getElementById('miniPlayer');
    const playerLoading = document.getElementById('playerLoading');
    showMiniPlayer();
    playerLoading.style.display = '';
    updatePlayerDisplay(song);

    try {
        const songInfo = {
            source: song.source,
            songmid: song.songmid || song.musicId,
            musicId: song.musicId || song.songmid,
            name: song.name,
            singer: song.singer,
            album: song.album || '',
            duration: song.duration,
        };
        if (song.hash) songInfo.hash = song.hash;
        if (song.albumId || song.album_id) songInfo.albumId = song.albumId || song.album_id;
        if (song.strMediaMid) songInfo.strMediaMid = song.strMediaMid;
        if (song.albumMid) songInfo.albumMid = song.albumMid;
        if (song.copyrightId) songInfo.copyrightId = song.copyrightId;

        const resp = await apiPost('/music/url', {
            source_data: {
                platform: song.source,
                quality: quality,
                songInfo: songInfo
            }
        });

        if (resp.url) {
            lbCurrentSong = song;
            lbIsPlaying = true;
            currentPlayerSource = 'lb';

            let audioUrl = resp.url;
            if (audioUrl.startsWith('http:')) {
                const token = getAuthToken();
                audioUrl = MAIN_API + '/proxy?url=' + encodeURIComponent(audioUrl) + '&access_token=' + encodeURIComponent(token);
            }

            lbAudioElement = new Audio(audioUrl);
            lbAudioElement.volume = 1.0;
            lbAudioElement.playbackRate = speedOptions[currentSpeedIndex];
            lbAudioElement.loop = (repeatMode === 'one');
            lbAudioElement.addEventListener('timeupdate', updatePlayerProgress);

            lbAudioElement.oncanplay = () => {
                lbAudioElement.play().catch(e => {
                    console.error('播放失败:', e);
                    showSnackbar('播放失败: ' + e.message, 'error');
                    lbStopPlay();
                });
            };

            lbAudioElement.onended = () => {
                lbIsPlaying = false;
                syncPlayButtons(false);
                if (repeatMode === 'all' || (lbShuffleList.length > 0 && lbCurrentShuffleIndex < lbShuffleList.length - 1)) {
                    if (lbShuffleList.length > 0 && lbCurrentShuffleIndex < lbShuffleList.length - 1) {
                        lbCurrentShuffleIndex++;
                        lbPlaySong(lbShuffleList[lbCurrentShuffleIndex]);
                    } else if (repeatMode === 'all') {
                        lbPlaySong(0);
                    } else {
                        lbCurrentSong = null;
                        hideMiniPlayer();
                    }
                } else {
                    lbCurrentSong = null;
                    hideMiniPlayer();
                    lbShuffleList = [];
                    lbCurrentShuffleIndex = 0;
                }
                lbRenderList();
            };

            playerLoading.style.display = 'none';
            lbUpdatePlayBtn(true);
            syncPlayButtons(true);
            lbRenderList();
        } else {
            showSnackbar('获取播放链接失败', 'error');
            hideMiniPlayer();
        }
    } catch (e) {
        console.error('获取播放URL失败:', e);
        showSnackbar('获取播放链接失败: ' + e.message, 'error');
        hideMiniPlayer();
    }
}

function lbTogglePlay() {
    if (!lbAudioElement || !lbCurrentSong) return;
    if (lbIsPlaying) {
        lbAudioElement.pause();
        lbIsPlaying = false;
    } else {
        lbAudioElement.play().catch(e => {
            console.error('播放失败:', e);
            showSnackbar('播放失败: ' + e.message, 'error');
        });
        lbIsPlaying = true;
    }
    lbUpdatePlayBtn(lbIsPlaying);
    syncPlayButtons(lbIsPlaying);
    lbRenderList();
}

function lbStopPlay() {
    if (lbAudioElement) {
        lbAudioElement.pause();
        lbAudioElement.src = '';
        lbAudioElement = null;
    }
    // 停止其他页面的播放器
    if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
        audioElement = null;
    }
    if (srAudioElement) {
        srAudioElement.pause();
        srAudioElement.src = '';
        srAudioElement = null;
    }
    isPlaying = false;
    currentPlaySong = null;
    srIsPlaying = false;
    srCurrentSong = null;
    lbIsPlaying = false;
    lbCurrentSong = null;
    hideMiniPlayer();
    closeFullPlayer();
    lbUpdatePlayBtn(false);
    syncPlayButtons(false);
    lbRenderList();
    srRenderResults();
    slRenderDetailList();
}

function lbUpdatePlayBtn(playing) {
    const btn = document.getElementById('playerPlayBtn');
    if (btn) {
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
    }
}

// ============ 播放器功能 ============

async function slPlaySong(index) {
    const song = slDetailSongs[index];
    if (!song) return;

    // 如果正在播放同一首歌，切换播放/暂停状态
    if (currentPlaySong && getSongKey(song) === getSongKey(currentPlaySong)) {
        slTogglePlay();
        return;
    }

    // 停止当前播放
    slStopPlay();

    const quality = getBestQuality(song);

    // 显示加载状态
    const miniPlayer = document.getElementById('miniPlayer');
    const playerLoading = document.getElementById('playerLoading');
    showMiniPlayer();
    playerLoading.style.display = '';
    updatePlayerDisplay(song);

    try {
        // 调用 /api/music/url 获取播放 URL
        const songInfo = {
            source: song.source,
            songmid: song.songmid || song.musicId,
            musicId: song.musicId || song.songmid,
            name: song.name,
            singer: song.singer,
            album: song.album || '',
            duration: song.duration,
        };
        if (song.hash) songInfo.hash = song.hash;
        if (song.albumId || song.album_id) songInfo.albumId = song.albumId || song.album_id;
        if (song.strMediaMid) songInfo.strMediaMid = song.strMediaMid;
        if (song.albumMid) songInfo.albumMid = song.albumMid;
        if (song.copyrightId) songInfo.copyrightId = song.copyrightId;

        const resp = await apiPost('/music/url', {
            source_data: {
                platform: song.source,
                quality: quality,
                songInfo: songInfo
            }
        });

        if (resp.url) {
            currentPlaySong = song;
            isPlaying = true;
            currentPlayerSource = 'sl';

            // 处理 Mixed Content 问题：HTTP URL 在 HTTPS 页面会被浏览器阻止
            // 使用 Songloft 代理转发音频请求（需要携带 token 认证）
            let audioUrl = resp.url;
            if (audioUrl.startsWith('http:')) {
                const token = getAuthToken();
                audioUrl = MAIN_API + '/proxy?url=' + encodeURIComponent(audioUrl) + '&access_token=' + encodeURIComponent(token);
            }

            // 创建 audio 元素并播放
            audioElement = new Audio(audioUrl);
            audioElement.playbackRate = speedOptions[currentSpeedIndex];
            audioElement.loop = (repeatMode === 'one');
            audioElement.addEventListener('timeupdate', updatePlayerProgress);
            audioElement.play().catch(e => {
                console.error('播放失败:', e);
                showSnackbar('播放失败: ' + e.message, 'error');
                slStopPlay();
            });

            // 监听播放结束
            audioElement.onended = () => {
                isPlaying = false;
                syncPlayButtons(false);
                if (repeatMode === 'all' || (slShuffleList.length > 0 && slCurrentShuffleIndex < slShuffleList.length - 1)) {
                    if (slShuffleList.length > 0 && slCurrentShuffleIndex < slShuffleList.length - 1) {
                        slCurrentShuffleIndex++;
                        slPlaySong(slShuffleList[slCurrentShuffleIndex]);
                    } else if (repeatMode === 'all') {
                        slPlaySong(0);
                    } else {
                        currentPlaySong = null;
                        slHideMiniPlayer();
                    }
                } else {
                    // 播放完毕
                    currentPlaySong = null;
                    slHideMiniPlayer();
                    slShuffleList = [];
                    slCurrentShuffleIndex = 0;
                }
            };

            // 监听错误
            /*audioElement.onerror = () => {
                isPlaying = false;
                showSnackbar('播放失败: 无法加载音频', 'error');
                slStopPlay();
            };*/

            playerLoading.style.display = 'none';
            slUpdatePlayBtn(true);
            syncPlayButtons(true);
            slRenderDetailList(); // 更新播放图标
        } else {
            showSnackbar('获取播放链接失败', 'error');
            slHideMiniPlayer();
        }
    } catch (e) {
        console.error('获取播放URL失败:', e);
        showSnackbar('获取播放链接失败: ' + e.message, 'error');
        slHideMiniPlayer();
    }
}

function slTogglePlay() {
    if (!audioElement || !currentPlaySong) return;

    if (isPlaying) {
        audioElement.pause();
        isPlaying = false;
    } else {
        audioElement.play().catch(e => {
            console.error('播放失败:', e);
            showSnackbar('播放失败: ' + e.message, 'error');
        });
        isPlaying = true;
    }
    slUpdatePlayBtn(isPlaying);
    syncPlayButtons(isPlaying);
    slRenderDetailList();
}

function slStopPlay() {
    if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
        audioElement = null;
    }
    // 停止其他页面的播放器
    if (srAudioElement) {
        srAudioElement.pause();
        srAudioElement.src = '';
        srAudioElement = null;
    }
    if (lbAudioElement) {
        lbAudioElement.pause();
        lbAudioElement.src = '';
        lbAudioElement = null;
    }
    isPlaying = false;
    currentPlaySong = null;
    srIsPlaying = false;
    srCurrentSong = null;
    lbIsPlaying = false;
    lbCurrentSong = null;
    slHideMiniPlayer();
    closeFullPlayer();
    slUpdatePlayBtn(false);
    syncPlayButtons(false);
    slRenderDetailList();
    srRenderResults();
    lbRenderList();
}

function slHideMiniPlayer() {
    hideMiniPlayer();
}

function slUpdatePlayBtn(playing) {
    const btn = document.getElementById('playerPlayBtn');
    if (btn) {
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
    }
}

async function slImportSelectedSongs() {
    if (slIsImporting) return;

    const songs = Array.from(slSelectedSongs.values());
    if (songs.length === 0) { showSnackbar('请选择要导入的歌曲', 'warning'); return; }

    if (!hasEnabledSources) {
        const proceed = await showDialog(
            '未配置音源',
            '当前未配置有效的洛雪音源，导入的歌曲将无法播放。\n\n是否仍要继续导入？',
            { confirmText: '继续导入', cancelText: '去配置音源' }
        );
        if (!proceed) { switchToTab('sources'); return; }
    }

    const quality = 'flac';
    const playlistSelect = document.getElementById('slPlaylistSelect');
    let playlistId = 0;
    let newPlaylistName = '';

    if (playlistSelect.value === '__new__') {
        newPlaylistName = document.getElementById('slNewPlaylistName').value.trim();
        if (!newPlaylistName) { showSnackbar('请输入歌单名称', 'error'); return; }
    } else if (playlistSelect.value) {
        playlistId = parseInt(playlistSelect.value);
    }

    slIsImporting = true;

    const progressSection = document.getElementById('slImportProgress');
    progressSection.style.display = '';
    document.getElementById('slProgressFill').style.width = '0%';
    document.getElementById('slProgressText').textContent = '正在导入...';
    document.getElementById('slImportResults').innerHTML = '';

    const importBtn = document.getElementById('slImportBtn');
    importBtn.disabled = true;
    importBtn.innerHTML = '<span class="spinner"></span>导入中...';

    try {
        const { totalSuccess, totalFailed, playlistConflict } = await batchImportSongs(songs, {
            quality,
            playlistId,
            newPlaylistName,
            progressFillId: 'slProgressFill',
            progressTextId: 'slProgressText',
            importResultsId: 'slImportResults'
        });

        if (playlistConflict) {
            await loadPlaylists();
        } else if (totalSuccess > 0) {
            showSnackbar(`成功导入 ${totalSuccess} 首歌曲`, 'success');
            slSelectedSongs.clear();
            slUpdateSelectedCount();
            loadPlaylists();
        }
        if (totalFailed > 0) showSnackbar(`${totalFailed} 首歌曲导入失败`, 'error');
    } catch (e) {
        document.getElementById('slProgressText').textContent = '导入失败: ' + e.message;
        showSnackbar('导入失败: ' + e.message, 'error');
    } finally {
        slIsImporting = false;
        importBtn.disabled = slSelectedSongs.size === 0;
        importBtn.innerHTML = `导入选中 <span id="slSelectedBadge" class="badge">${slSelectedSongs.size}</span>`;
    }
}

// ============ 排行榜 Tab ============

// 排行榜状态
let lbCurrentPlatform = 'kg';
let lbBoards = [];
let lbCurrentBoard = null;
let lbSongs = [];
let lbCurrentPage = 1;
let lbTotal = 0;
let lbSelectedSongs = new Map();
let lbBoardsCardCollapsed = false;
let lbLeaderboardLoaded = false;

function initLeaderboardTab() {
    document.getElementById('lbPlatformSelect').addEventListener('change', function () {
        lbCurrentPlatform = this.value;
        lbBoards = [];
        lbCurrentBoard = null;
        lbSelectedSongs.clear();
        lbUpdateSelectedCount();
        // 重置右侧内容区
        document.getElementById('lbBoardTitle').textContent = '请选择榜单';
        document.getElementById('lbBoardCount').textContent = '';
        document.getElementById('lbPlayAllBtn').style.display = 'none';
        document.getElementById('lbImportToolbar').style.display = 'none';
        document.getElementById('lbListHeader').style.display = 'none';
        document.getElementById('lbSongList').innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">leaderboard</span><p>选择左侧榜单查看歌曲</p></div>';
        document.getElementById('lbPagination').innerHTML = '';
        lbLoadBoards();
    });

    document.getElementById('lbSelectAll').addEventListener('change', lbToggleSelectAll);
    document.getElementById('lbImportBtn').addEventListener('click', lbImportSelectedSongs);

    document.getElementById('lbPlaylistSelect').addEventListener('change', function () {
        const wrapper = document.getElementById('lbNewPlaylistWrapper');
        wrapper.style.display = this.value === '__new__' ? 'flex' : 'none';
    });
}

async function lbLoadBoards() {
    const statusEl = document.getElementById('lbLoadStatus');
    statusEl.textContent = '加载中...';

    try {
        const result = await apiGet(`/leaderboard/boards?source_id=${lbCurrentPlatform}`);
        if (result.code === 0) {
            lbBoards = result.data || [];
            lbRenderBoards();
            statusEl.textContent = lbBoards.length > 0 ? `${lbBoards.length} 个榜单` : '';
            lbLeaderboardLoaded = true;
        } else {
            showSnackbar('加载排行榜失败: ' + (result.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showSnackbar('加载排行榜失败: ' + e.message, 'error');
        statusEl.textContent = '加载失败';
    }
}

function lbRenderBoards() {
    const container = document.getElementById('lbBoardList');
    if (lbBoards.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:24px 16px"><p style="font-size:12px;color:var(--text-tertiary)">暂无可用排行榜</p></div>';
        return;
    }
    container.innerHTML = lbBoards.map(b =>
        `<div class="lb-board-item" data-board-id="${escapeHtml(b.id)}">${escapeHtml(b.name)}</div>`
    ).join('');
    container.querySelectorAll('.lb-board-item').forEach(item => {
        item.addEventListener('click', function () {
            // 高亮当前选中项
            container.querySelectorAll('.lb-board-item').forEach(el => el.classList.remove('active'));
            this.classList.add('active');

            const newBoard = lbBoards.find(b => b.id === this.dataset.boardId);
            if (!lbCurrentBoard || lbCurrentBoard.id !== this.dataset.boardId) {
                lbSelectedSongs.clear();
                lbUpdateSelectedCount();
            }
            lbCurrentBoard = newBoard;
            lbLoadList(1);
        });
    });
    // 自动选中第一个榜单
    if (lbBoards.length > 0) {
        const firstItem = container.querySelector('.lb-board-item');
        if (firstItem) {
            firstItem.classList.add('active');
            lbCurrentBoard = lbBoards[0];
            lbLoadList(1);
        }
    }
}

async function lbLoadList(page) {
    if (!lbCurrentBoard) return;
    lbCurrentPage = page;

    // 清理旧的导入进度
    resetImportProgress('lbImportProgress', 'lbProgressFill', 'lbProgressText', 'lbImportResults');

    const songList = document.getElementById('lbSongList');
    document.getElementById('lbBoardTitle').textContent = lbCurrentBoard.name;
    document.getElementById('lbBoardCount').textContent = '';
    document.getElementById('lbPlayAllBtn').style.display = '';
    document.getElementById('lbImportToolbar').style.display = 'flex';
    document.getElementById('lbListHeader').style.display = '';
    songList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>加载中...</p></div>';

    try {
        const params = new URLSearchParams({
            source_id: lbCurrentPlatform,
            board_id: lbCurrentBoard.id,
            page: page
        });
        const result = await apiGet(`/leaderboard/list?${params}`);
        if (result.code === 0) {
            lbSongs = result.data.list || [];
            lbTotal = result.data.total || 0;
            document.getElementById('lbBoardCount').textContent = lbTotal > 0 ? `· ${lbTotal} 首` : '';
            lbRenderList();
            initBackToTop();
        } else {
            songList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败</p></div>';
        }
    } catch (e) {
        songList.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>加载失败: ' + escapeHtml(e.message) + '</p></div>';
    }
}

function lbRenderList() {
    const container = document.getElementById('lbSongList');
    if (!container || !lbSongs.length) {
        if (lbSongs.length === 0) {
            container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">music_off</span><p>暂无歌曲</p></div>';
            document.getElementById('lbPagination').innerHTML = '';
        }
        return;
    }

    container.innerHTML = lbSongs.map((song, i) => {
        const key = getSongKey(song);
        const checked = lbSelectedSongs.has(key) ? 'checked' : '';
        const selectedClass = lbSelectedSongs.has(key) ? ' selected' : '';
        const playingClass = (lbCurrentSong && getSongKey(song) === getSongKey(lbCurrentSong)) ? ' playing' : '';
        const imgHtml = song.img
            ? `<img src="${escapeHtml(song.img)}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<span class=\\'material-symbols-outlined\\'>music_note</span>'">`
            : '<span class="material-symbols-outlined">music_note</span>';
        const playIcon = (lbCurrentSong && getSongKey(song) === getSongKey(lbCurrentSong) && lbIsPlaying) ? 'pause' : 'play_arrow';
        const badgesHtml = renderBadges(song.source, getBestQuality(song));
        return `
            <div class="result-item${selectedClass}${playingClass} animate-slide-up" data-index="${i}" style="animation-delay:${Math.min(i, 15) * 0.03}s">
                <div class="col-index">
                    <input type="checkbox" class="lb-checkbox" data-index="${i}" ${checked}
                        onchange="lbOnSongCheckChanged(${i}, this.checked)" style="accent-color:var(--md-primary);width:18px;height:18px;cursor:pointer">
                </div>
                <div class="col-title">
                    <div class="result-thumb">${imgHtml}</div>
                    <div class="result-title-wrap">
                        <div class="result-name">${escapeHtml(song.name)}${badgesHtml}</div>
                    </div>
                </div>
                <div class="col-artist">${escapeHtml(song.singer || '')}</div>
                <div class="col-album">${escapeHtml(song.album || '')}</div>
                <div class="col-duration">${formatDuration(song.duration)}</div>
                <div class="col-actions">
                    <button class="play-btn lb-play-btn" data-index="${i}" title="播放">
                        <span class="material-symbols-outlined">${playIcon}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // 绑定排行榜行播放按钮点击事件
    container.querySelectorAll('.lb-play-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.getAttribute('data-index'));
            lbPlaySong(idx);
        });
    });

    const allChecked = lbSongs.every(s => lbSelectedSongs.has(getSongKey(s)));
    document.getElementById('lbSelectAll').checked = allChecked && lbSongs.length > 0;

    lbRenderPagination();
    lbUpdateSelectedCount();
}

function lbOnSongCheckChanged(index, checked) {
    const song = lbSongs[index];
    const key = getSongKey(song);
    if (checked) lbSelectedSongs.set(key, song);
    else lbSelectedSongs.delete(key);
    const row = document.querySelectorAll('#lbSongList .result-item')[index];
    if (row) row.classList.toggle('selected', checked);
    lbUpdateSelectedCount();
    const allChecked = lbSongs.every(s => lbSelectedSongs.has(getSongKey(s)));
    document.getElementById('lbSelectAll').checked = allChecked;
}

function lbToggleSelectAll() {
    const checked = document.getElementById('lbSelectAll').checked;
    lbSongs.forEach(song => {
        const key = getSongKey(song);
        if (checked) lbSelectedSongs.set(key, song);
        else lbSelectedSongs.delete(key);
    });
    lbRenderList();
    lbUpdateSelectedCount();
}

function lbUpdateSelectedCount() {
    const count = lbSelectedSongs.size;
    const badge = document.getElementById('lbSelectedBadge');
    if (badge) badge.textContent = count;
    document.getElementById('lbImportBtn').disabled = count === 0;
}

function lbRenderPagination() {
    const container = document.getElementById('lbPagination');
    // 后端各排行榜统一按 100 条/页返回，保持前后端一致以避免最后一页长度偏小时计算错误
    const limit = 100;
    const totalPages = Math.max(1, Math.ceil(lbTotal / limit));
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    const prevDisabled = lbCurrentPage <= 1 ? 'disabled' : '';
    const nextDisabled = lbCurrentPage >= totalPages ? 'disabled' : '';

    container.innerHTML = `
        <button class="btn-icon" title="上一页" ${prevDisabled} onclick="lbPageNav(${lbCurrentPage - 1})">
            <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <span class="page-info">第 ${lbCurrentPage} / ${totalPages} 页</span>
        <input type="number" class="text-field page-jump" value="${lbCurrentPage}" min="1" max="${totalPages}"
            onchange="lbJumpToPage(this.value, ${totalPages})">
        <button class="btn-icon" title="下一页" ${nextDisabled} onclick="lbPageNav(${lbCurrentPage + 1})">
            <span class="material-symbols-outlined">chevron_right</span>
        </button>
    `;
}

function lbPageNav(page) {
    lbLoadList(page);
}

function lbJumpToPage(val, totalPages) {
    const page = Math.min(totalPages, Math.max(1, parseInt(val) || 1));
    if (page !== lbCurrentPage) {
        lbLoadList(page);
    }
}

// lbBackToBoards 和 lbToggleBoardsCard 已废弃（新布局始终显示侧边栏）

async function lbImportSelectedSongs() {
    if (lbIsImporting) return;

    const songs = Array.from(lbSelectedSongs.values());
    if (songs.length === 0) { showSnackbar('请选择要导入的歌曲', 'warning'); return; }

    if (!hasEnabledSources) {
        const proceed = await showDialog(
            '未配置音源',
            '当前未配置有效的洛雪音源，导入的歌曲将无法播放。\n\n是否仍要继续导入？',
            { confirmText: '继续导入', cancelText: '去配置音源' }
        );
        if (!proceed) { switchToTab('sources'); return; }
    }

    const quality = 'flac';
    const playlistSelect = document.getElementById('lbPlaylistSelect');
    let playlistId = 0;
    let newPlaylistName = '';

    if (playlistSelect.value === '__new__') {
        newPlaylistName = document.getElementById('lbNewPlaylistName').value.trim();
        if (!newPlaylistName) { showSnackbar('请输入歌单名称', 'error'); return; }
    } else if (playlistSelect.value) {
        playlistId = parseInt(playlistSelect.value);
    }

    lbIsImporting = true;

    const progressSection = document.getElementById('lbImportProgress');
    progressSection.style.display = '';
    document.getElementById('lbProgressFill').style.width = '0%';
    document.getElementById('lbProgressText').textContent = '正在导入...';
    document.getElementById('lbImportResults').innerHTML = '';

    const importBtn = document.getElementById('lbImportBtn');
    importBtn.disabled = true;
    importBtn.innerHTML = '<span class="spinner"></span>导入中...';

    try {
        const { totalSuccess, totalFailed, playlistConflict } = await batchImportSongs(songs, {
            quality,
            playlistId,
            newPlaylistName,
            progressFillId: 'lbProgressFill',
            progressTextId: 'lbProgressText',
            importResultsId: 'lbImportResults'
        });

        if (playlistConflict) {
            await loadPlaylists();
        } else if (totalSuccess > 0) {
            showSnackbar(`成功导入 ${totalSuccess} 首歌曲`, 'success');
            lbSelectedSongs.clear();
            lbUpdateSelectedCount();
            loadPlaylists();
        }
        if (totalFailed > 0) showSnackbar(`${totalFailed} 首歌曲导入失败`, 'error');
    } catch (e) {
        document.getElementById('lbProgressText').textContent = '导入失败: ' + e.message;
        showSnackbar('导入失败: ' + e.message, 'error');
    } finally {
        lbIsImporting = false;
        importBtn.disabled = lbSelectedSongs.size === 0;
        importBtn.innerHTML = `导入选中 <span id="lbSelectedBadge" class="badge">${lbSelectedSongs.size}</span>`;
    }
}

// ============ 暴露到全局作用域 ============
// 构建工具 (esbuild format:'iife') 会将所有代码包裹在 IIFE 中，
// 导致 inline onclick/onchange 无法访问函数。显式挂载到 window 解决此问题。
window.switchToTab = switchToTab;
window.slOpenTagDrawer = slOpenTagDrawer;
window.slCloseTagDrawer = slCloseTagDrawer;
window.slBackToList = slBackToList;
// lbToggleBoardsCard / lbBackToBoards removed - new layout always shows sidebar
window.toggleSource = toggleSource;
window.deleteSource = deleteSource;
window.search = search;
window.jumpToPage = jumpToPage;
window.onSongCheckChanged = onSongCheckChanged;
window.slOpenDetail = slOpenDetail;
window.slPageNav = slPageNav;
window.slDetailPageNav = slDetailPageNav;
window.slOnSongCheckChanged = slOnSongCheckChanged;
window.lbPageNav = lbPageNav;
window.lbJumpToPage = lbJumpToPage;
window.lbOnSongCheckChanged = lbOnSongCheckChanged;
window.slPlaySong = slPlaySong;
window.slTogglePlay = slTogglePlay;
window.slStopPlay = slStopPlay;
window.toggleCurrentPlayer = toggleCurrentPlayer;
window.stopCurrentPlayer = stopCurrentPlayer;
window.prevCurrentPlayer = prevCurrentPlayer;
window.nextCurrentPlayer = nextCurrentPlayer;
window.seekPlayerProgress = seekPlayerProgress;
window.onVolumeChange = onVolumeChange;
window.onHotSearchItemClick = onHotSearchItemClick;
window.backToHotSearch = backToHotSearch;
// ============ 歌曲下载 ============

let isDownloading = false;

async function downloadCurrentSong() {
    if (isDownloading) { showSnackbar('正在下载中，请稍候...', 'warning'); return; }

    const song = getActiveSong();
    if (!song) { showSnackbar('没有正在播放的歌曲', 'warning'); return; }

    const name = song.name || '';
    const singer = song.singer || '';
    const album = song.album || '';
    const source = song.source || '';
    const quality = getBestQuality(song);

    const downloadBtn = document.getElementById('playerDownloadBtn');
    const fpDownloadBtn = document.getElementById('fpDownloadBtn');

    const setDownloadingState = (dl) => {
        isDownloading = dl;
        if (downloadBtn) {
            downloadBtn.classList.toggle('downloading', dl);
            const span = downloadBtn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = dl ? 'downloading' : 'download_for_offline';
        }
        if (fpDownloadBtn) {
            fpDownloadBtn.classList.toggle('downloading', dl);
            const span = fpDownloadBtn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = dl ? 'downloading' : 'download_for_offline';
        }
    };

    const setDoneState = () => {
        if (downloadBtn) {
            downloadBtn.classList.remove('downloading');
            downloadBtn.classList.add('download-done');
            const span = downloadBtn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = 'download_done';
            setTimeout(() => {
                downloadBtn.classList.remove('download-done');
                if (span) span.textContent = 'download_for_offline';
            }, 2500);
        }
        if (fpDownloadBtn) {
            fpDownloadBtn.classList.remove('downloading');
            fpDownloadBtn.classList.add('download-done');
            const span = fpDownloadBtn.querySelector('.material-symbols-outlined');
            if (span) span.textContent = 'download_done';
            setTimeout(() => {
                fpDownloadBtn.classList.remove('download-done');
                if (span) span.textContent = 'download_for_offline';
            }, 2500);
        }
    };

    setDownloadingState(true);
    showSnackbar('正在下载: ' + name + '...', 'info');

    try {
        const body = {
            name, singer, album, source, quality,
            musicId: song.musicId || song.songmid || '',
            songmid: song.songmid || song.musicId || '',
            hash: song.hash || '',
            duration: song.duration || 0,
            img: song.img || '',
        };
        if (song.albumId) body.albumId = song.albumId;
        if (song.strMediaMid) body.strMediaMid = song.strMediaMid;
        if (song.albumMid) body.albumMid = song.albumMid;
        if (song.copyrightId) body.copyrightId = song.copyrightId;

        const resp = await apiPost('/direct/download', body);

        if (resp.code === 0) {
            setDoneState();
            showSnackbar('下载成功: ' + name + ' (已嵌入元数据)', 'success');
        } else {
            setDownloadingState(false);
            showSnackbar('下载失败: ' + (resp.message || '未知错误'), 'error');
        }
    } catch (e) {
        setDownloadingState(false);
        console.error('下载歌曲失败:', e);
        showSnackbar('下载失败: ' + (e.message || '网络错误'), 'error');
    }
}

// Player v2.5.0 new functions
window.toggleRepeatMode = toggleRepeatMode;
window.cycleSpeed = cycleSpeed;
window.toggleFullPlayer = toggleFullPlayer;
window.onFullPlayerBackdropClick = onFullPlayerBackdropClick;
window.seekToLyricLine = seekToLyricLine;
window.downloadCurrentSong = downloadCurrentSong;