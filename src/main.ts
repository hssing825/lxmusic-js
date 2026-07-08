/// <reference types="@songloft/plugin-sdk" />
import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';

// 导入服务
import { SourceManager } from './source/manager';
import { RuntimeManager } from './engine';
// urlmap 已废弃:新架构把音源元数据 source_data 直接存到主程序 song 表,
// 插件不再需要维护 hash → songInfo 的映射。残留的 songloft.storage 'urlmap_data' 自然过期。

// 导入 handler 注册函数
import { registerSearchHandlers } from './handlers/search';
import { registerSourceHandlers } from './handlers/source';
import { registerSonglistHandlers } from './handlers/songlist';
import { registerLeaderboardHandlers } from './handlers/leaderboard';
import { registerSettingsHandlers } from './handlers/settings';
import { registerDownloadHandlers } from './handlers/download';

// 导入 musicsdk
import {
  Registry,
  KgSearcher,
  KwSearcher,
  TxSearcher,
  WySearcher,
  MgSearcher,
  KgLyricFetcher,
  KwLyricFetcher,
  TxLyricFetcher,
  WyLyricFetcher,
  MgLyricFetcher,
  KgSongListProvider,
  KwSongListProvider,
  TxSongListProvider,
  WySongListProvider,
  MgSongListProvider,
  KgLeaderboardProvider,
  KwLeaderboardProvider,
  TxLeaderboardProvider,
  WyLeaderboardProvider,
  MgLeaderboardProvider,
} from '@songloft/musicsdk/dist/index.js';

const router = createRouter();

// 全局服务实例
let sourceManager: SourceManager;
let runtimeManager: RuntimeManager;
let registry: Registry;

// JS 插件无 pluginID 概念，使用 0 作为默认值
const pluginID = 0;

async function onInit(): Promise<void> {
  songloft.log.info('洛雪音源插件初始化...');

  // 1. 创建核心服务（构造器只初始化空状态，存储读取通过 init() 异步加载）
  sourceManager = new SourceManager();
  runtimeManager = new RuntimeManager();
  registry = new Registry();

  // 1b. 异步加载持久化数据
  await sourceManager.init();

  // 2. 注册 5 平台搜索器
  registry.register(new KgSearcher());
  registry.register(new KwSearcher());
  registry.register(new TxSearcher());
  registry.register(new WySearcher());
  registry.register(new MgSearcher());

  // 3. 注册 5 平台歌词获取器
  registry.registerLyricFetcher(new KgLyricFetcher());
  registry.registerLyricFetcher(new KwLyricFetcher());
  registry.registerLyricFetcher(new TxLyricFetcher());
  registry.registerLyricFetcher(new WyLyricFetcher());
  registry.registerLyricFetcher(new MgLyricFetcher());

  // 4. 注册 5 平台歌单提供者
  registry.registerSongListProvider(new KgSongListProvider());
  registry.registerSongListProvider(new KwSongListProvider());
  registry.registerSongListProvider(new TxSongListProvider());
  registry.registerSongListProvider(new WySongListProvider());
  registry.registerSongListProvider(new MgSongListProvider());

  // 5. 注册 5 平台排行榜提供者
  registry.registerLeaderboardProvider(new KgLeaderboardProvider());
  registry.registerLeaderboardProvider(new KwLeaderboardProvider());
  registry.registerLeaderboardProvider(new TxLeaderboardProvider());
  registry.registerLeaderboardProvider(new WyLeaderboardProvider());
  registry.registerLeaderboardProvider(new MgLeaderboardProvider());

  // 6. 注册 HTTP 路由
  registerSearchHandlers(router, registry, runtimeManager);
  registerSourceHandlers(router, sourceManager, runtimeManager, pluginID);
  registerSonglistHandlers(router, registry);
  registerLeaderboardHandlers(router, registry);
  registerSettingsHandlers(router);
  registerDownloadHandlers(router, runtimeManager);

  // 7. 异步加载已启用的音源
  const enabledSources = sourceManager.getEnabledSources();
  for (const source of enabledSources) {
    const script = await sourceManager.getSourceScript(source.id);
    if (script) {
      const success = await runtimeManager.loadSource(source.id, script, pluginID);
      if (success) {
        songloft.log.info(`音源已加载: ${source.name}`);
      } else {
        songloft.log.warn(`音源加载失败: ${source.name}`);
      }
    }
  }

  songloft.log.info('洛雪音源插件初始化完成');
}

async function onDeinit(): Promise<void> {
  songloft.log.info('洛雪音源插件停止...');
  // 清理运行时（如有需要）
  songloft.log.info('洛雪音源插件已停止');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  // 兜底:保证永远返回 HTTPResponse,避免上游 jsplugin 层拿到 undefined 后退化成
  // 200 + 空 body,让 source.fetcher 报 "unexpected end of JSON input"。
  try {
    const resp = await router.handle(req);
    if (!resp || typeof resp !== 'object') {
      songloft.log.error(
        `onHTTPRequest: handler returned non-object for ${req.method} ${req.path}: ${typeof resp}`
      );
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'handler returned undefined' }),
      };
    }
    return resp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    songloft.log.error(
      `onHTTPRequest: handler threw for ${req.method} ${req.path}: ${msg}${stack ? '\n' + stack : ''}`
    );
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'handler threw', message: msg }),
    };
  }
}

// 暴露为全局（QuickJS 需要显式声明）。
// SDK 0.8+ 的 onInit/onDeinit/onHTTPRequest 已声明为 `void | Promise<void>`
// 等异步友好签名，async function 直接赋值即可。
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;