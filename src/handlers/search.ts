// 洛雪音源插件 — 搜索 / music_url / 导入 / lyric 处理器
//
// 2026 重构:
//   - 删除 urlmapStore(主程序新架构把音源元数据直接存到 song 表的 source_data 字段)
//   - search 改 POST,返回 { results: SearchResultItem[] },每条带 source_data
//   - music/url 改 POST,接受 source_data + fallback hint,内部解析为 CDN URL
//   - import handler 把前端传来的旧格式 ImportSongItem 转换成 source_data,
//     调主程序 /api/v1/songs/remote(新形态:plugin_entry_path + source_data)
//   - /api/direct/* 接口保留不变(给 lxmusic-api 等使用 platform 原始字段的插件用)

import {
  createSearchHandler,
  createMusicUrlHandler,
  type SearchResultItem,
  type FallbackMatch,
  type MusicUrlFallbackHint,
} from '@songloft/plugin-sdk';
import type { Router, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import type { Registry } from '@songloft/musicsdk/dist/index.js';
import type { RuntimeManager } from '../engine/manager';
import { callHostAPI } from '../utils/http';
import type { ImportSongsRequest, ImportSongItem } from '../types';
import { getConfig } from '../config';
import { successResponse, errorResponse } from './response';

/** lxmusic source_data 结构:opaque 给主程序看,内部包含解析 URL 所需全部信息 */
interface LxSourceData {
  platform: string;
  quality: string;
  songInfo: Record<string, unknown>;
}

/**
 * 计算 song 的稳定去重 key。
 * 形如 "<platform>:<id>",主程序会和 plugin_entry_path 组成 UNIQUE 索引,
 * 同一首歌再次导入不会创建新 song,而是命中已有 ID。
 * 各平台稳定身份字段优先级:songmid(qq) → musicId(wy/kw) → hash(kg) → copyrightId(mg)。
 * 全部缺失时返回空,主程序会跳过去重直接 INSERT(避免误判成"同一首")。
 */
function buildDedupKey(song: ImportSongItem): string {
  const platform = song.source || '';
  if (!platform) return '';
  const id = song.songmid || song.musicId || song.hash || song.copyrightId || '';
  if (!id) return '';
  return `${platform}:${id}`;
}

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * 按平台构造歌词查询 URL,主程序的 GetSongLyric 会代理到 /api/v1/jsplugin/lxmusic/api/direct/lyric。
 *
 * "每个平台需要哪些字段"这份知识由 musicsdk 各 LyricFetcher 自己声明(lyricParams 方法),
 * 这里只负责:把 ImportSongItem 拍平成 songInfo → 委托 fetcher 挑字段 → 拼成 URL。
 * 未注册 LyricFetcher 或必需字段缺失时返回空字符串(歌曲入库时 lyric_source 会留空)。
 */
function buildLyricURL(registry: Registry, song: ImportSongItem): string {
  const source = song.source || '';
  if (!source) return '';

  const fetcher = registry.getLyricFetcher(source);
  if (!fetcher) return '';

  // 把 ImportSongItem 的全部已知字段透传给 fetcher,由 fetcher 自行 pick。
  // musicId 和 songmid 互为 fallback,在这里归一化以兼容 lxmusic 历史字段命名混乱。
  const songInfo: Record<string, unknown> = {
    source,
    name: song.name,
    singer: song.singer,
    album: song.album,
    duration: song.duration,
    musicId: song.musicId || song.songmid || '',
    songmid: song.songmid || song.musicId || '',
    hash: song.hash,
    copyrightId: song.copyrightId,
    strMediaMid: song.strMediaMid,
    albumMid: song.albumMid,
    albumId: song.albumId,
  };

  const picked = fetcher.lyricParams(songInfo);
  if (!picked) return '';

  const params: Record<string, string> = { source, ...picked };
  const qs = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `/api/v1/jsplugin/mylxmusic/api/direct/lyric?${qs}`;
}

/** 构建歌词响应（带永久缓存头） */
function lyricResponse(lyric: string): HTTPResponse {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: JSON.stringify({ code: 0, data: { lyric } }),
  };
}

/**
 * 如果歌单没有封面，随机选一个导入歌曲的封面设置到歌单
 */
async function setPlaylistCoverIfEmpty(playlistID: number, songs: ImportSongItem[]): Promise<void> {
  const songsWithCover = songs.filter(s => s.img);
  if (songsWithCover.length === 0) return;

  try {
    const playlist = await callHostAPI<{ cover_path: string; cover_url: string; name: string; type: string }>(
      'GET', `/api/v1/playlists/${playlistID}`,
    );
    if (playlist.cover_path || playlist.cover_url) return;

    const selectedSong = songsWithCover[Math.floor(Math.random() * songsWithCover.length)];
    await callHostAPI('PUT', `/api/v1/playlists/${playlistID}`, {
      name: playlist.name,
      type: playlist.type,
      cover_url: selectedSong.img,
    });
    songloft.log.info(`已为歌单设置封面: playlistID=${playlistID}, coverURL=${selectedSong.img}`);
  } catch (e: any) {
    songloft.log.warn(`设置歌单封面失败: playlistID=${playlistID}, error=${e.message || e}`);
  }
}

/** 把搜索返回的单条记录转成 source_data + SearchResultItem */
function toSearchResultItem(item: Record<string, unknown>, platform: string, quality: string): SearchResultItem | null {
  // musicsdk 返回字段是小写驼峰(name/singer/musicId/songmid 等),
  // 同时容忍大写(防御性,musicsdk 升级时不会立即崩)
  const name = String(item.name || item.Name || '');
  const singer = String(item.singer || item.Singer || '');
  const album = String(item.album || item.Album || '');
  const duration = Number(item.duration || item.Duration || 0);
  const img = String(item.img || item.Img || '');

  if (!name) return null;

  // 构造 songInfo:保留所有平台特有字段(供 resolveUrl/getMusicUrl 使用)
  const songInfo: Record<string, unknown> = {
    name,
    singer,
    album,
    source: platform,
    musicId: String(item.musicId || item.MusicID || item.songmid || item.Songmid || ''),
    duration,
  };
  // 平台特有字段:逐个透传,opaque 不解释
  const passthroughKeys = ['songmid', 'Songmid', 'hash', 'Hash', 'strMediaMid', 'StrMediaMid',
    'albumMid', 'AlbumMid', 'albumId', 'AlbumID', 'copyrightId', 'CopyrightId', 'types', 'Types'];
  for (const k of passthroughKeys) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') {
      const lk = k.charAt(0).toLowerCase() + k.slice(1);
      songInfo[lk] = item[k];
    }
  }

  const sourceData: LxSourceData = { platform, quality, songInfo };
  return {
    title: name,
    artist: singer,
    album,
    duration,
    cover_url: img,
    source_data: sourceData as unknown as Record<string, unknown>,
  };
}

/**
 * 把 raw search item + SearchResultItem 转成 ImportSongItem,
 * 供 buildDedupKey / buildLyricURL 在 topone 等场景复用。
 */
function rawToImportSongItem(raw: Record<string, unknown>, sr: SearchResultItem, platform: string): ImportSongItem {
  const sd = sr.source_data as unknown as LxSourceData;
  const si = sd.songInfo;
  return {
    name: sr.title,
    singer: sr.artist,
    source: platform,
    musicId: String(si.musicId || raw.musicId || raw.MusicID || raw.songmid || raw.Songmid || ''),
    album: sr.album,
    duration: sr.duration,
    img: sr.cover_url,
    songmid: String(si.songmid || raw.songmid || raw.Songmid || raw.musicId || raw.MusicID || ''),
    hash: String(si.hash || raw.hash || raw.Hash || ''),
    copyrightId: String(si.copyrightId || raw.copyrightId || raw.CopyrightId || ''),
    strMediaMid: String(si.strMediaMid || raw.strMediaMid || raw.StrMediaMid || ''),
    albumMid: String(si.albumMid || raw.albumMid || raw.AlbumMid || ''),
    albumId: String(si.albumId || raw.albumId || raw.AlbumID || ''),
  };
}

/**
 * 注册搜索和导入相关路由(新形态)
 * POST /api/search          → 多平台搜索(返回 source_data)
 * GET  /api/platforms       → 列出可用平台
 * POST /api/music/url       → 用 source_data 获取播放 URL(支持 L1 自搜 fallback)
 * POST /api/songs/import    → 批量导入歌曲到音乐库
 * POST /api/direct/music/url → 直接接口(songInfo+quality),供 lxmusic-api 使用,不变
 * GET  /api/direct/lyric    → 直接歌词接口,不变
 */
export function registerSearchHandlers(
  router: Router,
  registry: Registry,
  runtimeManager: RuntimeManager,
): void {

  // POST /api/search — 多平台搜索(主程序约定的 SDK 形态)
  router.post('/api/search', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const keyword = String(body.keyword || '').trim();
    const sourceID = String(body.source_id || '').trim();
    const quality = String(body.quality || '320k').trim();
    const page = typeof body.page === 'number' && body.page > 0 ? body.page : 1;
    const pageSize = typeof body.page_size === 'number' && body.page_size > 0 ? body.page_size : 30;

    if (!keyword) return errorResponse(400, '缺少 keyword');
    if (!sourceID) return errorResponse(400, '缺少 source_id');

    const searcher = registry.get(sourceID);
    if (!searcher) return errorResponse(400, '不支持的平台: ' + sourceID);

    try {
      const result = await searcher.search(keyword, page, pageSize);
      // musicsdk 返回 { list, total } 形式;list 中每条已是小写驼峰
      const rawItems: Record<string, unknown>[] = ((result as any)?.list || (result as any)?.songs || []) as Record<string, unknown>[];
      const results: SearchResultItem[] = [];
      for (const item of rawItems) {
        const sr = toSearchResultItem(item, sourceID, quality);
        if (sr) results.push(sr);
      }
      // 同时透出 list/total(给 lxmusic 内置前端 UI 用)
      // 和 results(给主程序 SourceResolver fan-out 用 — 每条带 source_data)
      const total = (result as any)?.total ?? rawItems.length;
      return successResponse({
        list: rawItems,
        total,
        page,
        page_size: pageSize,
        results,
      });
    } catch (e: any) {
      songloft.log.error(`搜索失败: source_id=${sourceID}, keyword=${keyword}, error=${e.message || e}`);
      return errorResponse(500, '搜索失败: ' + (e.message || String(e)));
    }
  });

  // GET /api/platforms — 列出可用平台
  router.get('/api/platforms', () => {
    const platforms = registry.all();
    return successResponse(platforms);
  });

  // POST /api/music/url — 主程序 SourceFetcher 调用入口
  // body: { source_data: LxSourceData, fallback?: { enabled, title, artist, duration } }
  router.post('/api/music/url', createMusicUrlHandler({
    resolveUrl: async (sourceData) => {
      const sd = sourceData as unknown as LxSourceData;
      if (!sd.platform || !sd.songInfo) {
        throw new Error('invalid source_data: missing platform or songInfo');
      }
      const quality = sd.quality || '320k';
      const url = await runtimeManager.getMusicUrl(sd.platform, quality, sd.songInfo);
      if (!url) {
        if (runtimeManager.count() === 0) {
          throw new Error('no music source configured');
        }
        throw new Error('empty url from runtime');
      }
      return url;
    },
    fallbackSearch: async (hint: MusicUrlFallbackHint): Promise<FallbackMatch | null> => {
      // 跨所有平台搜索,选 title 最匹配的第一条
      // 简化打分:title 包含 hint.title 且 artist 匹配优先
      const keyword = `${hint.title} ${hint.artist}`.trim();
      if (!keyword) return null;
      const platforms = registry.all() as unknown as string[];
      const candidates: Array<{ score: number; match: FallbackMatch }> = [];
      for (const p of platforms) {
        const searcher = registry.get(p);
        if (!searcher) continue;
        try {
          const r = await searcher.search(keyword, 1, 10);
          const items: Record<string, unknown>[] = ((r as any)?.list || (r as any)?.songs || []) as Record<string, unknown>[];
          for (const item of items) {
            const title = String(item.Name || item.name || '');
            const artist = String(item.Singer || item.singer || '');
            if (!title) continue;
            // 简单评分:title 与 artist 子串/包含/精确
            let score = 0;
            if (title === hint.title) score += 0.5;
            else if (title.includes(hint.title) || hint.title.includes(title)) score += 0.3;
            if (artist === hint.artist) score += 0.3;
            else if (artist.includes(hint.artist) || hint.artist.includes(artist)) score += 0.15;
            if (score < 0.4) continue;
            const sr = toSearchResultItem(item, p, '320k');
            if (!sr) continue;
            candidates.push({
              score,
              match: { source_data: sr.source_data, title: sr.title, artist: sr.artist },
            });
          }
        } catch {
          // 单平台失败不影响其他
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].match;
    },
  }));

  // POST /api/songs/import — 批量导入歌曲
  router.post('/api/songs/import', async (req: HTTPRequest) => {
    const request: ImportSongsRequest = parseBody(req);

    if (!request.songs || request.songs.length === 0) {
      return errorResponse(400, '请选择至少一首歌曲');
    }

    const quality = request.quality || '320k';

    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    let successCount = 0;
    let failedCount = 0;
    const importedSongIDs: number[] = [];

    // 把 ImportSongItem 转成主程序需要的 RemoteSongInput 格式
    interface BatchItem {
      song: ImportSongItem;
      sourceData: LxSourceData;
    }
    const batch: BatchItem[] = [];

    for (const song of request.songs) {
      // 归一化:musicId 和 songmid 互为 fallback
      const musicID = song.musicId || song.songmid || '';
      const songmid = song.songmid || song.musicId || '';

      const songInfo: Record<string, unknown> = {
        name: song.name,
        singer: song.singer,
        album: song.album || '',
        source: song.source,
        musicId: musicID,
        duration: song.duration || 0,
      };
      if (song.hash) songInfo.hash = song.hash;
      if (songmid) songInfo.songmid = songmid;
      if (song.strMediaMid) songInfo.strMediaMid = song.strMediaMid;
      if (song.albumMid) songInfo.albumMid = song.albumMid;
      if (song.copyrightId) songInfo.copyrightId = song.copyrightId;
      if (song.albumId) songInfo.albumId = song.albumId;

      const sourceData: LxSourceData = {
        platform: song.source,
        quality,
        songInfo,
      };
      batch.push({ song, sourceData });
    }

    // 批量调主程序新接口
    if (batch.length > 0) {
      const batchBody = batch.map(item => {
        // 按平台构造歌词 URL:字段需求由 musicsdk 的 LyricFetcher 自己声明,缺关键字段时返回空。
        // 客户端拉歌词时主程序会代理转发到 /api/v1/jsplugin/lxmusic/api/direct/lyric,
        // 该接口返回 {code:0, data:{lyric:"..."}} JSON,前端 lyrics_view 已会解析。
        const lyricURL = buildLyricURL(registry, item.song);
        return {
          title: item.song.name,
          artist: item.song.singer,
          album: item.song.album || '',
          cover_url: item.song.img || '',
          duration: item.song.duration || 0,
          plugin_entry_path: 'mylxmusic',
          source_data: JSON.stringify(item.sourceData),
          dedup_key: buildDedupKey(item.song),
          lyric_source: lyricURL ? 'url' : '',
          lyric: lyricURL,
        };
      });

      try {
        songloft.log.info(`批量调用主程序 API 添加歌曲: count=${batch.length}`);
        const addResp = await callHostAPI<{ songs: Array<{ id: number }> }>('POST', '/api/v1/songs/remote', batchBody);

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          results.push({ name: item.song.name, success: true });
          successCount++;
          if (addResp.songs && i < addResp.songs.length) {
            const songID = addResp.songs[i].id;
            if (songID > 0) importedSongIDs.push(songID);
          }
        }
      } catch (e: any) {
        const errMsg = '调用主程序 API 失败: ' + (e.message || String(e));
        songloft.log.error(`${errMsg}, count=${batch.length}`);
        for (const item of batch) {
          results.push({ name: item.song.name, success: false, error: errMsg });
          failedCount++;
        }
      }
    }

    // 歌单处理(新建/添加)— 区分主程序返回的同名冲突错误,前端据此提示用户改名而非静默失败
    let playlistID = request.playlist_id || 0;
    let playlistName = '';
    let playlistError: { code: string; message: string } | null = null;
    if (request.new_playlist_name) {
      try {
        const plResp = await callHostAPI<{ id: number; name: string }>('POST', '/api/v1/playlists', {
          name: request.new_playlist_name,
          type: 'normal',
        });
        playlistID = plResp.id;
        playlistName = plResp.name;
      } catch (e: any) {
        const msg = e?.message || String(e);
        // callHostAPI 在 4xx 时抛出 `Host API error 409 ...` 的错误,这里按 HTTP 状态分类
        const isConflict = / 409 /.test(msg);
        playlistError = {
          code: isConflict ? 'name_conflict' : 'unknown',
          message: isConflict ? '已存在同名歌单,请改名或选择已有歌单' : msg,
        };
        songloft.log.error(`新建歌单失败: ${msg}`);
      }
    }
    if (playlistID > 0 && importedSongIDs.length > 0) {
      try {
        await callHostAPI('POST', `/api/v1/playlists/${playlistID}/songs`, { song_ids: importedSongIDs });
        await setPlaylistCoverIfEmpty(playlistID, request.songs);
      } catch (e: any) {
        songloft.log.error(`添加歌曲到歌单失败: ${e.message || e}`);
      }
    }

    const responseData: Record<string, unknown> = {
      total: request.songs.length,
      success: successCount,
      failed: failedCount,
      results,
      playlist_id: playlistID,
      playlist_name: playlistName,
    };
    if (playlistError) {
      responseData.playlist_error = playlistError;
    }
    if (runtimeManager.count() === 0) {
      responseData.warning = '注意:当前未配置有效的洛雪音源,导入的歌曲暂时无法播放。请在「音源管理」中导入音源脚本。';
    }
    return successResponse(responseData);
  });

  // ===== TopOne 外部搜索接口（MIoT 兼容） =====
  // POST /api/search/topone — 一次返回搜索结果 + 播放 URL
  // body: { keyword, hint?: {title, artist, duration}, quality?, source?, page_size? }
  // 单结果模式（page_size 缺失或 =1）：返回 { code, msg, data: { ... } }
  // 多结果模式（page_size > 1）：返回 { code, msg, data: [ ... ] }

  router.post('/api/search/topone', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const keyword = String(body.keyword || '').trim();
    if (!keyword) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 400, msg: 'keyword is required', data: null }),
      };
    }

    // 读取插件配置：音质始终使用默认值（忽略 MIoT 调用方传入的 quality）
    const config = await getConfig();
    const quality = config.defaultQuality;
    const sourceFilter = String(body.source || '').trim();
    const pageSize = typeof body.page_size === 'number' && body.page_size > 0 ? body.page_size : 1;
    const multiMode = pageSize > 1;

    // 确定要搜索的平台列表：请求中指定了 source 则尊重，否则使用配置的默认平台
    let platforms: string[];
    if (sourceFilter) {
      platforms = [sourceFilter];
    } else {
      platforms = config.defaultPlatforms.length > 0
        ? config.defaultPlatforms
        : registry.all().map(p => p.id);
    }

    songloft.log.info(`[TopOne] keyword="${keyword}", quality=${quality}, platforms=[${platforms.join(',')}], pageSize=${pageSize}`);

    // 收集所有候选：跨平台搜索，解析 URL
    interface TopOneCandidate {
      title: string;
      artist: string;
      album: string;
      duration: number;
      cover_url: string;
      url: string;
      music_source: string;
      lyric: string;
      lyric_source: string;
      plugin_entry_path: string;
      dedup_key: string;
      source_data: Record<string, unknown>;
    }

    const candidates: TopOneCandidate[] = [];

    // 多结果模式下按 page_size 决定 URL 解析数量（每条 ~200ms），上限 10 条。
    // MIoT 两阶段搜索的阶段2有独立 10 秒超时，10 条约 2 秒完全可接受。
    const maxUrlResolves = multiMode ? Math.min(pageSize, 10) : 1;

    for (const platform of platforms) {
      const searcher = registry.get(platform);
      if (!searcher) continue;

      // 每平台搜索条数：多结果模式多取几条（有些 URL 解析会失败），单结果模式取 5 条
      const perPlatformLimit = multiMode ? Math.max(5, Math.ceil(maxUrlResolves / platforms.length) + 2) : 5;

      try {
        const result = await searcher.search(keyword, 1, perPlatformLimit);
        const items: Record<string, unknown>[] =
          ((result as any)?.list || (result as any)?.songs || []) as Record<string, unknown>[];

        for (const item of items) {
          // 已收集足够候选，停止解析
          if (candidates.length >= maxUrlResolves) break;

          const sr = toSearchResultItem(item, platform, quality);
          if (!sr) continue;

          const sd = sr.source_data as unknown as LxSourceData;
          try {
            const url = await runtimeManager.getMusicUrl(platform, quality, sd.songInfo);
            if (!url) continue;

            // 构造 ImportSongItem 用于生成 dedup_key 和 lyric URL
            const importItem = rawToImportSongItem(item, sr, platform);
            const dedupKey = buildDedupKey(importItem);
            const lyricURL = buildLyricURL(registry, importItem);

            candidates.push({
              title: sr.title,
              artist: sr.artist,
              album: sr.album,
              duration: sr.duration,
              cover_url: sr.cover_url,
              url,
              music_source: platform,
              lyric: lyricURL,
              lyric_source: lyricURL ? 'url' : '',
              plugin_entry_path: 'mylxmusic',
              dedup_key: dedupKey,
              source_data: sr.source_data as Record<string, unknown>,
            });

            songloft.log.info(`[TopOne] "${keyword}" → ${sr.title} - ${sr.artist} (${platform})`);

            // 单结果模式：找到第一个就返回（向后兼容）
            if (!multiMode) {
              return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  code: 0,
                  msg: 'success',
                  data: candidates[0],
                }),
              };
            }
          } catch {
            // 单条失败，继续尝试下一条
          }
        }
      } catch (e: any) {
        songloft.log.warn(`[TopOne] platform ${platform} search failed: ${e.message || e}`);
      }
    }

    // 多结果模式：返回数组
    if (multiMode) {
      if (candidates.length === 0) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 404, msg: 'No results with playable URL', data: null }),
        };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 0, msg: 'success', data: candidates }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 404, msg: 'No results with playable URL', data: null }),
    };
  });

  // ===== Direct 接口:供 lxmusic-api 等使用 platform 原始字段的插件调用 =====
  // 不接受 source_data,直接用 songInfo+quality 调底层 musicsdk。
  // 这些接口形态保持不变,跟 source_data 重构正交。

  router.post('/api/direct/music/url', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const source = body?.songInfo?.source;
    const songmid = body?.songInfo?.songmid;

    if (!source || !songmid) {
      return errorResponse(400, 'songInfo.source 和 songInfo.songmid 不能为空');
    }

    const quality = body?.quality || '320k';
    const songInfo = { source, songmid };

    let musicUrl: string | null;
    try {
      musicUrl = await runtimeManager.getMusicUrl(source, quality, songInfo as Record<string, unknown>);
    } catch (e: any) {
      songloft.log.error(`Direct 获取播放 URL 失败: ${e.message || e}`);
      if (runtimeManager.count() === 0) {
        return errorResponse(503, '尚未配置有效的洛雪音源');
      }
      return errorResponse(502, '获取播放 URL 失败: ' + (e.message || String(e)));
    }

    if (!musicUrl) return errorResponse(502, '获取到的播放 URL 为空');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: musicUrl, type: quality, source }),
    };
  });

  router.get('/api/direct/lyric', async (req: HTTPRequest) => {
    const query: Record<string, string> = {};
    if (req.query) {
      for (const pair of req.query.split('&')) {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    const source = query.source;
    if (!source) return errorResponse(400, 'source 不能为空');

    const fetcher = registry.getLyricFetcher(source);
    if (!fetcher) return errorResponse(400, '平台不支持歌词获取: ' + source);

    // 构造 songInfo:把所有 fetcher 可能用到的字段透传过去。
    // 各平台依赖的字段不同(kg:hash+name+singer+duration / kw:musicId / tx:songmid /
    // wy:musicId / mg:copyrightId 或 lrcUrl/mrcUrl/trcUrl),由 fetcher 自行取用。
    // duration 必须是 number 类型(kg getDuration 走 typeof number 分支),所以特殊解析。
    const songInfo: Record<string, unknown> = { source };
    const stringFields = [
      'songmid',
      'musicId',
      'hash',
      'copyrightId',
      'name',
      'singer',
      'album',
      'strMediaMid',
      'albumMid',
      'albumId',
      'lrcUrl',
      'mrcUrl',
      'trcUrl',
    ];
    for (const k of stringFields) {
      if (query[k]) songInfo[k] = query[k];
    }
    if (query.duration) {
      const d = parseFloat(query.duration);
      if (!isNaN(d)) songInfo.duration = d;
    }

    try {
      const result = await fetcher.getLyric(songInfo);
      return lyricResponse(result.lyric);
    } catch (e: any) {
      songloft.log.error(`Direct 获取歌词失败: ${e.message || e}`);
      return errorResponse(500, '获取歌词失败: ' + (e.message || String(e)));
    }
  });
}
