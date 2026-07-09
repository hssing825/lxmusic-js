# 任务:从零实现 Songloft「洛雪音源」JS 插件 (lxmusic)

为自托管音乐服务器 Songloft 实现一个 JS 插件,把「洛雪音乐 (lx-music)」生态的第三方音源接入 Songloft:提供多平台搜索/歌单/排行榜,并把远程歌曲解析成可播放的 CDN URL 导入音乐库。**不得依赖任何外部音乐 SDK 包**,平台接口自行实现(移植自 lx-music-desktop / lxserver)。

## 运行环境与铁律
- 插件运行在宿主的 **QuickJS 沙箱**里,用 TS 编写,经 `@songloft/plugin-builder` 打包成 `<entryPath>.jsplugin.zip`。
- 沙箱内**只有** `fetch`(真异步)、`setTimeout`、`Buffer`、`crypto`(宿主 polyfill:md5/aesEncrypt/rsaEncrypt/randomBytes)、`zlib`(inflate/deflate)以及 `songloft.*` 宿主桥接。没有 Node.js API、没有 `require`、没有文件系统随意访问。
- **所有 `songloft.*` 接口都返回 Promise,必须 await**(底层用 goroutine 处理,避免阻塞单 VM 锁)。
- 生命周期:导出 `globalThis.onInit / onDeinit / onHTTPRequest` 三个全局函数(QuickJS 需显式挂到 globalThis)。
- 插件通过 HTTP 路由对外服务,路径前缀 `/api/v1/jsplugin/<entryPath>/...`。

## 唯一 SDK 依赖:`@songloft/plugin-sdk`(仅宿主契约,不含音乐能力)
- `createRouter()` → `Router`(`.get/.post/.put/.delete(path, handler)`,`handler(req)=>HTTPResponse|Promise`)。
- `createSearchHandler({search})` 和 `createMusicUrlHandler({resolveUrl, fallbackSearch})` — 生成**主程序约定形态**的 handler(见「主程序集成契约」)。
- `jsonResponse(body, status)`、`parseQuery(q)`。
- 类型:`HTTPRequest{method,path,headers,body:Uint8Array|null,query}`、`HTTPResponse{statusCode,headers,body}`、`SearchResultItem`、`MusicUrlFallbackHint`、`FallbackMatch`。
- 全局 `songloft`:`log.{info,warn,error}`、`storage.{get,set,delete,keys}`(KV 持久化)、`plugin.{getToken,getHostUrl,getFileUrl}`、`songs.*`、`playlists.*`、以及**关键的 `songloft.jsenv`**(见机制 B)。

## 核心:双机制架构(务必理解)
插件里有**两条彼此独立**的能力线,**与 lxserver 的设计完全同构**:

**A. 内置 musicSdk(移植进源码树)** 负责「**元数据**」:搜索、歌词、歌单、排行榜、(可选)热搜/联想/评论/封面。五平台 kw/kg/tx/wy/mg 逻辑全部自带,**不需要**外部音源脚本。

**B. lxmusic 引擎(jsenv 沙箱)** 负责「**播放 URL 解析**」:用户导入外部「洛雪音源」`.js` 脚本(社区脚本,常被 jsjiami 混淆),每个脚本在**独立子 QuickJS VM**里运行,插件调用它把歌曲解析成真实 CDN URL。这是 musicSdk 做不到的(音源脚本含私有签名/防盗链算法)。

> 关键分工(照 lxserver):**musicSdk 只做元数据,永远不解析播放直链;直链一律走机制 B 的自定义源脚本。** 未导入任何音源时,搜索/歌单可正常用,但导入的歌曲无法播放(前端需给出提示横幅)。

### 机制 A:移植 musicSdk(参考 https://github.com/XCQ0607/lxserver)
以 lxserver 的 `src/modules/utils/musicSdk/` 为蓝本移植到本插件 `src/musicSdk/`,而非 npm 依赖。范围:
- 平台目录 `kw/ kg/ tx/ wy/ mg/`,每个含 `index.js` + `musicSearch / lyric / songList / leaderboard / hotSearch / tipSearch / comment / pic`(comment/pic/hotSearch/tipSearch 可按需裁剪,搜索+歌词+歌单+榜单为必需)。
- 共享工具 `src/musicSdk/index.ts`:`sizeFormate / decodeName / formatPlayTime / dateFormat / formatPlayCount` 等(直接从 lxserver `modules/utils/index.js` 搬)。
- 顶层 facade `src/musicSdk/facade.ts`:导出 `{ sources:[{id,name}], kw,kg,tx,wy,mg }`,每平台暴露 `musicSearch.search(str,page,limit)`、`getLyric(songInfo)`、`songList`、`leaderboard` 等方法(接口形态照 lxserver 各 `index.js`)。
- **不要**移植 lxserver 的 `api-source.js` 里 `getMusicUrl→userApi` 那条链:本插件的直链解析由机制 B 的 `RuntimeManager` 提供,musicSdk 侧删掉/不接 getMusicUrl。

**沙箱适配层(移植的重点改造):**
- **HTTP:** lxserver 用 `needle` 实现 `httpFetch(url, options) => { promise, cancelHttp }`(promise resolve `{ statusCode, headers, body }`,body 自动 JSON.parse)。在沙箱里**用 `fetch` 重写 `src/musicSdk/request.ts`**,保持同样的 `httpFetch` 签名与返回结构(各平台代码大量调用 `.promise.then(({body})=>...)`,签名必须一致才能少改)。支持 `options.{method,headers,body,form,formData,timeout}`,form 对象 urlencode,body 对象 JSON;`cancelHttp` 用 AbortController 或忽略实现。默认 headers 照 lxserver `options.js`。
- **crypto:** musicSdk 的 wy/tx/mg 签名用到 node `crypto`(createHash/createCipheriv)、`crypto-js`、及各平台 `utils/crypto.js`(AES/RSA/MD5/base64)。沙箱无 node crypto。适配方案:①能映射到宿主 `crypto.{md5,aesEncrypt,rsaEncrypt,randomBytes}` + `Buffer` 的直接映射;②其余(如 crypto-js 的 HmacSHA / 特定 padding)**打包纯 JS 版 crypto-js 进产物**(QuickJS 可运行)。写一个 `src/musicSdk/crypto-shim.ts` 收敛所有加密调用,平台代码统一 import 它。
- **全局:** 平台代码可能引用 `global`/`window`;在 musicSdk 入口补 `globalThis.window = globalThis`。去掉对 `global.lx.config` 代理设置的依赖(沙箱走宿主统一代理)。

### 机制 B:lxmusic 引擎(`songloft.jsenv`)
`songloft.jsenv` 提供子 VM 管理:`create(name,initCode)` / `execute(name,code,timeoutMs)` / `executeWait(name,code,timeoutMs,waitEvents[])` / `executeParallel(calls[],maxConcurrent)` / `destroy(name)`。子 VM 与父插件全局隔离,`fetch` 真异步;但**没有 timer goroutine**——`setTimeout/Promise` 仅在 `executeWait` 的 polling loop 内被驱动。

为每个子 VM 注入一段 **lx prelude**(作为 `create` 的 initCode),构造洛雪音源脚本期望的全局 `lx`(遵循 lx-music-desktop 自定义源 API):
- `lx.request(url, options, callback)` — 回调风格 HTTP,内部包装 `fetch`;`callback(err, {statusCode,statusMessage,headers,body}, body)`;支持 `options.{method,headers,body,form,formData}`,form 自动 urlencode,body 对象自动 JSON。
- `lx.send(eventName, data)` — 通过宿主注入的 `__go_send(name, JSON.stringify(data))` 抛事件回父侧;特殊处理 `inited`(记录 sources)。
- `lx.on(eventName, handler)` — 脚本注册 `request` 事件处理器。
- `lx._dispatch(reqId, eventName, dataJSON)` — 父侧触发脚本处理请求;handler 可能返回 Promise,settle 后 `__go_send('dispatchResult'|'dispatchError', {id:reqId, result|error})` 回传。**必须加看门狗**(如 18s):Promise 永不 settle 时主动发 dispatchError。
- `lx.utils.{buffer,crypto,zlib}` — 包装宿主 polyfill。
- `globalThis.window = globalThis; globalThis.global = globalThis;`(混淆脚本依赖)。

**SourceRuntime**(单个音源实例)创建:
1. `jsenv.create(envName, LX_PRELUDE_JS)`,envName 用音源 id 生成,须只含安全字符(`:: /` 非法,非 ASCII 编码成 hex)。
2. `jsenv.execute` 注入元数据 `globalThis.lx.currentScriptInfo = {name,version,...,rawScript}`。⚠️ **`rawScript` 必须是真实脚本源码**:部分音源初始化会 `md5(rawScript)` 跟远端校验,空值→校验失败→永不发 inited→30s 超时。
3. `jsenv.executeWait(envName, script, 30000, ['inited'])`,等 `inited` 拿 `{sources:{平台:{name,type,actions,qualitys}}}`。无 sources 视为失败并 destroy。

获取 URL:构造 `lx._dispatch(reqId,"request",{source,action:'musicUrl',info:{musicInfo,type:quality}})`,`executeWait(...,['dispatchResult','dispatchError'])`,按 `data.id===reqId` 提取 `result`(字符串 URL 或 `{url}`)。

**RuntimeManager**:管理多个 SourceRuntime,维护 `平台→runtime[]` 反向索引;取 URL 时对支持该平台的多源用 `jsenv.executeParallel(calls, 3)` **并行竞速**,首个成功者胜出,按成功率(`successCalls/totalCalls`)排序统计。

**SourceManager**:音源导入/删除/启用禁用/持久化。
- 元数据从脚本头 JSDoc(`/** */` 或 `/*! */`)正则解析 `@name/@version/@description/@author/@homepage`,缺 @name 用文件名推断。
- `songloft.storage` 持久化:索引 `source_index`,脚本 `source_script_<id>`。构造器只建空状态,必须 `await init()` 异步加载。
- id 用 name 的 slug(保留中文),重名加 `_2`;导入同名先删旧。

## 主程序集成契约(插件被 Songloft 发现的关键)
用 SDK 工厂函数实现两个约定端点:
- **`POST /api/search`** — `createSearchHandler`。入参 `{keyword, source_id, quality, page, page_size}`,内部调 `musicSdk[source_id].musicSearch.search(...)`,返回 `{results: SearchResultItem[]}`。每条 `{title,artist,album,duration,cover_url, source_data}`。`source_data` 对主程序**不透明**,本插件设计为 `{platform, quality, songInfo}`(songInfo 保留平台特有字段供机制 B 解析)。
- **`POST /api/music/url`** — `createMusicUrlHandler({resolveUrl, fallbackSearch})`。`resolveUrl(source_data)` 调 `RuntimeManager.getMusicUrl` 解析真实 CDN URL(可返回 `{url, headers}`,headers 供主程序代理携带 Referer/UA 防盗链);`fallbackSearch(hint)` 在主源失败且 `hint.enabled` 时用 `hint.title+artist` 跨平台自搜最匹配项返回新 source_data。

**导入歌曲到库**:`POST /api/songs/import` 接受选中歌曲,**批量**调宿主 `POST /api/v1/songs/remote`,每条 `{title,artist,album,cover_url,duration, plugin_entry_path:'lxmusic', source_data:JSON.stringify(...), dedup_key, lyric_source, lyric}`。
- `dedup_key = "<platform>:<稳定id>"`(优先级 songmid→musicId→hash→copyrightId;全缺留空跳过去重)。
- 歌词:调 `musicSdk[platform].getLyric(songInfo)` 能力,或拼 `/api/v1/jsplugin/lxmusic/api/direct/lyric?...` 作为 `lyric` URL、`lyric_source='url'`,客户端拉取时主程序代理回本插件 direct/lyric 端点(返回 `{code:0,data:{lyric}}`)。
- 可选:新建/加入歌单(`/api/v1/playlists`、`/api/v1/playlists/{id}/songs`),歌单无封面时随机取一首导入歌封面。

调宿主 API 辅助:`fetch(await songloft.plugin.getHostUrl()+path, {headers:{Authorization:'Bearer '+await songloft.plugin.getToken()}})`。

## 其余 HTTP 路由(供内置前端 + 其他插件)
- 音源管理:`GET /api/sources`、`POST /api/sources/import`(multipart,.js 和 .zip)、`POST /api/sources/import-url`、`DELETE /api/sources?id=`、`PUT /api/sources/toggle`。
- 歌单浏览(转发 musicSdk):`GET /api/songlist/{tags,list,detail,search,sorts}`,带 `source_id`。
- 排行榜:`GET /api/leaderboard/{boards,list}`。
- Direct:`POST /api/direct/music/url`(`{songInfo:{source,songmid},quality}`)、`GET /api/direct/lyric`。
- 三合一:`POST /api/search/topone`(搜索+匹配+解析 URL,返回最佳可播放项)。
- 静态前端:`static/index.html`+css/js(vanilla JS,搜索/导入/音源管理三 Tab,Material 风格,跟随宿主主题)。

## 已知踩坑(务必实现)
1. **onHTTPRequest 兜底**:必须 try/catch 且永远返回合法 HTTPResponse;返回 undefined 会被上游退化成 200+空 body,调用方报 "unexpected end of JSON input"。
2. **musicSdk 移植的最大工作量在适配层**:`request.ts`(needle→fetch,保持 httpFetch 签名)与 `crypto-shim.ts`(node crypto/crypto-js→宿主 polyfill+打包 crypto-js)。先把这两层跑通,平台业务代码基本可原样保留。逐平台验证 search/lyric。
3. **musicSdk 字段**:返回小写驼峰(`name/singer/musicId/songmid/hash/copyrightId/strMediaMid/albumMid/...`),防御性容忍首字母大写;`musicId` 与 `songmid` 互为 fallback,归一化。
4. **ZIP 解析**:QuickJS 无 zip 库,手写解析 Central Directory(EOCD `PK\x05\x06`),支持 STORE(0)和 DEFLATE(8,用宿主 `__go_raw_inflate(hex)`);跳过目录/`__MACOSX/`/`._*`/`.DS_Store`;带 local-header fallback。
5. **编码**:multipart/ZIP body 按字节读(`String.fromCharCode`→latin1),中文文件名/内容需 `latin1ToUtf8`(TextDecoder)再交解析,ZIP body 本身保持 latin1(按字节匹配 boundary/header)。
6. **ZIP 批量导入异步化**:每源 init 5–10s,串行会阻塞响应。先以 `enabled=false` 持久化并立即返回,后台 `setTimeout` 链逐个 `loadSource`,成功后 `enableSource`;间隔 ~1000ms 让出 env 锁。`GET /api/sources` 暴露 `loading/batch_current_id/batch_pending_ids` 供前端轮询。
7. 统一响应封装(内部 UI 用):`{code:0,msg:'success',data}` / 带 `warning` / 错误 `{code:statusCode,msg,data:null}`。注意跟主程序契约端点(`/api/search`、`/api/music/url` 走 SDK 工厂返回裸 `{results}`/`{url}`)不同,别混。

## 工程结构与产物
```
plugin.json      # name/version/entryPath:"lxmusic"/main:"main.js"/minHostVersion/permissions:["storage","songs.read","songs.write","playlists.read","playlists.write","jsenv"]/download_url/entryHash/zipHash
package.json     # scripts: build/dev/validate/publish 走 songloft-plugin CLI;devDeps: plugin-builder/plugin-sdk/typescript(无 @songloft/musicsdk;可含纯JS crypto-js)
tsconfig.json    # target ES2020, module ESNext, strict, types:["@songloft/plugin-sdk"], noEmit
src/
  main.ts               # onInit: new SourceManager/RuntimeManager → import musicSdk facade → 注册路由 → 加载已启用音源;导出三个全局
  types.ts globals.d.ts  # 内部类型 + 宿主注入函数声明(__go_send/__go_raw_inflate/crypto 等)
  musicSdk/  index.ts facade.ts request.ts crypto-shim.ts  kw/ kg/ tx/ wy/ mg/   # 机制 A(移植自 lxserver)
  engine/    index.ts runtime.ts manager.ts lx_prelude.ts types.ts               # 机制 B
  source/    manager.ts parser.ts storage.ts types.ts                            # 音源管理
  handlers/  index.ts search.ts source.ts songlist.ts leaderboard.ts response.ts # 直接调 musicSdk facade
  utils/http.ts          # callHostAPI 封装
static/  index.html css/style.css js/app.js
.github/workflows/release.yml   # workflow_dispatch:自动日期版本→build→gh release 上传 zip→回写 plugin.json download_url
```
`npx create-songloft-plugin@latest` 脚手架起步;`npm run build` 产 `dist/lxmusic.jsplugin.zip`;`npm run validate` 校验哈希。

## 合规
音源脚本与其数据均为第三方版权内容,插件本身**不附带任何音源**,内置 musicSdk 仅访问各平台公开搜索/歌词接口。README 需含免责声明:仅供个人学习研究、禁止商用、用户须自行清除产生的版权数据。
