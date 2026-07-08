// 洛雪音源插件 — 歌曲下载处理器

import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import type { RuntimeManager } from '../engine/manager';
import { successResponse, errorResponse } from './response';

/** 解析请求体 */
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

export function registerDownloadHandlers(
  router: Router,
  runtimeManager: RuntimeManager,
): void {

  // POST /api/direct/download — 下载歌曲（含元数据嵌入）
  router.post('/api/direct/download', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const name = String(body.name || '').trim();
    const singer = String(body.singer || '').trim();
    const album = String(body.album || '').trim();
    const source = String(body.source || '').trim();
    const quality = String(body.quality || '320k').trim();
    const musicId = String(body.musicId || '');
    const songmid = String(body.songmid || '');
    const hash = String(body.hash || '');
    const duration = Number(body.duration || 0);
    const img = String(body.img || '').trim();

    if (!name) return errorResponse(400, '缺少歌曲名称');
    if (!source) return errorResponse(400, '缺少音源平台');

    try {
      // 1. 构建 songInfo 解析播放 URL
      const songInfo: Record<string, unknown> = {
        source,
        name,
        singer,
        album,
        duration,
        musicId: musicId || songmid,
        songmid: songmid || musicId,
      };
      if (hash) songInfo['hash'] = hash;
      if (body.albumId) songInfo['albumId'] = body.albumId;
      if (body.strMediaMid) songInfo['strMediaMid'] = body.strMediaMid;
      if (body.albumMid) songInfo['albumMid'] = body.albumMid;
      if (body.copyrightId) songInfo['copyrightId'] = body.copyrightId;

      // 2. 解析歌曲 URL
      songloft.log.info(`[download] 正在解析歌曲URL: ${name} - ${singer} (${source})`);
      const url = await runtimeManager.getMusicUrl(source, quality, songInfo);
      if (!url) {
        return errorResponse(500, '无法获取歌曲播放链接，请检查音源配置');
      }

      // 3. 构建 dedupKey
      const idForDedup = musicId || songmid || hash || '';
      const dedupKey = idForDedup ? `${source}:${idForDedup}` : '';

      // 4. 创建歌曲到数据库
      songloft.log.info(`[download] 正在创建歌曲记录: ${name}`);
      const createResult = await songloft.songs.create([{
        url,
        title: name,
        artist: singer,
        album: album || undefined,
        coverUrl: img || undefined,
        duration: duration || undefined,
        dedupKey: dedupKey || undefined,
      }]);

      if (!createResult || createResult.length === 0) {
        return errorResponse(500, '创建歌曲记录失败');
      }

      const songId = createResult[0].id;
      songloft.log.info(`[download] 歌曲已创建: id=${songId}, 开始下载...`);

      // 5. 下载歌曲（嵌入元数据）
      const downloadResult = await songloft.songs.download(songId, {
        embed_metadata: true,
      });

      songloft.log.info(`[download] 下载完成: id=${songId}, path=${downloadResult.path}, status=${downloadResult.status}`);

      return successResponse({
        id: songId,
        path: downloadResult.path,
        status: downloadResult.status,
        name,
        singer,
      });
    } catch (e: any) {
      songloft.log.error(`[download] 下载失败: ${name}, error=${e.message || e}`);
      return errorResponse(500, '下载失败: ' + (e.message || String(e)));
    }
  });
}