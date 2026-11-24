// 抖IM ⇄ DSH 代聊桥（重写版）
//
// 抖IM 是手机上的 Android App（com.mira.im），在本机 127.0.0.1:8791 开了一个
// 只认 loopback 的接口。这个插件跑在 DSH 引擎（proot 里的 Node）里，两边共
// 用同一个 127.0.0.1，所以能直接对话。
//
// 工作方式（AstrBot 那套「一人一会话 + 触发判定 + 上下文注入」）：
//   1. 每 2 秒轮询 GET /inbox，拿别人发进来的消息；
//   2. 判断要不要接（群里只有被 @ 我 才接，单聊默认都接）；
//   3. 用 GET /history?n=60 拉最近 60 条（带原始 JSON）拼成上下文；
//   4. 每个抖音会话固定映射一条真 DSH 会话，把上下文 followup 进去；
//   5. 收 assistant 文本 → POST /send 发回原会话（长了自动分段）。
//
// 你在 dsh-go 里直接跟那条会话说话，也走同一份记忆。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'local-douyin-im'
// attachments 必须一起注入：图片要经它入库成 ImageBlock 才能交给模型看。
// 以前没列进来，ctx.get('attachments') 拿到 undefined，图片就静默丢了。
export const inject = ['agents', 'commands', 'attachments']

// ------------------------------------------------------------------ 持久化
//
// 以前 pinned 模型只存在内存里，一重启引擎就变回默认模型；/new 生成的新会话
// 也没记下来，重启后又会 resume 回老会话。所以这里把三样东西落盘：
//   pinned   代聊用哪个模型
//   gen      每个抖音会话的「第几代」DSH 会话（/new 时 +1）
//   reset    每个抖音会话的重置时间（这之前的历史不再喂给模型）
const STATE_FILE = process.env.DOUIM_STATE_FILE
  || path.join(os.homedir(), '.dsh', 'douim-state.json')

let stateCache = null

/**
 * 单实例锁。
 *
 * 实测踩到过：同一个 dsh 进程里插件被灌了两份，于是两个 tick 循环同时抢
 * 同一个收件箱 —— 一边把消息拿走回了、另一边 cursor 还停在原地，表现就是
 * 「有的消息回了、有的完全没反应」，双方还互相把 cursor 写乱。
 * 这里用心跳租约：谁最近 15 秒内刷新过 owner.at，谁就是唯一在跑的那份。
 */
const MY_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const LEADER_TTL_MS = 15000

function claimLeader(force) {
  try {
    const st = loadState()
    const o = st.owner && typeof st.owner === 'object' ? st.owner : null
    const now = Date.now()
    if (!force && o && o.id && o.id !== MY_ID && now - Number(o.at || 0) < LEADER_TTL_MS) {
      return false
    }
    st.owner = { id: MY_ID, at: now }
    saveState()
    return true
  } catch {
    return true
  }
}

function loadState() {
  if (stateCache) return stateCache
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch { /* 第一次跑没有文件，正常 */ }
  stateCache = raw && typeof raw === 'object' ? raw : {}
  if (!('pinned' in stateCache)) stateCache.pinned = null
  if (!stateCache.gen || typeof stateCache.gen !== 'object') stateCache.gen = {}
  if (!stateCache.reset || typeof stateCache.reset !== 'object') stateCache.reset = {}
  return stateCache
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(loadState(), null, 2), 'utf8')
  } catch (e) {
    // 落盘失败不能影响代聊，但要在日志里留一句
    try { console.log(`[douim] 状态保存失败：${e?.message ?? e}`) } catch { }
  }
}

function genOf(convId) {
  const n = Number(loadState().gen[String(convId)] ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function bumpGen(convId) {
  const st = loadState()
  const k = String(convId)
  st.gen[k] = genOf(convId) + 1
  saveState()
  return st.gen[k]
}

function resetAtOf(convId) {
  const n = Number(loadState().reset[String(convId)] ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function setResetAt(convId, ms) {
  const st = loadState()
  st.reset[String(convId)] = Math.floor(ms)
  saveState()
}

/** 端口可以在 App 设置里改，这里跟着探一遍 */
let PORT = 8791
/** 插件版本，写进 App 日志时带上，方便确认跑的是哪一版 */
const PLUGIN_VER = '0.9.2'

const PROBE_PORTS = [8791, 8792, 8793, 18791, 28791]

/**
 * 接口密钥。
 *
 * 以前是写死的 'douim-local-1'，App 和插件各存一份，改起来要同时改两边。
 * 现在 App 每次装好后随机生成一份（32 位十六进制），插件不知道密钥时
 * 敲 /handshake 拿一次，之后就用它。换手机、换 App、重置密钥都不用改代码。
 *
 * 拿到后落盘到 state 文件，重启 dsh 不用重新握手。
 */
let KEY = String(process.env.DOUIM_KEY ?? '').trim()

function setKey(k) {
  const v = String(k ?? '').trim()
  if (!v || v === KEY) return v === KEY
  KEY = v
  try {
    const st = loadState()
    st.key = v
    saveState()
  } catch { /* 存不进去也不影响本次会话 */ }
  log('info', `拿到新的接口密钥（${v.slice(0, 6)}…）`)
  return true
}

/** 从 state 文件里恢复上次握手拿到的密钥 */
function loadKey() {
  if (KEY) return KEY
  try {
    const k = String(loadState().key ?? '').trim()
    if (k) { KEY = k; return KEY }
  } catch { /* ignore */ }
  return KEY
}

const base = () => `http://127.0.0.1:${PORT}`
const POLL_MS = 2000          // 长轮询断开时的兜底间隔
const LONG_POLL_MS = 25000    // /inbox?wait=1 最长阻塞
const TURN_TIMEOUT_MS = 180_000
const CALL_TIMEOUT_MS = 30_000
/**
 * 单条消息的字数上限（超过才切）。
 *
 * 原来是 1800 —— 一段稍微长点的回复就会被切成两三条发出去，
 * 加上 [fd] 分段，用户看到的就是「刷屏」。抖音 IM 单条能装 5000+，
 * 这里放到 4000：正常回复永远是一整条，只有真的超长才切。
 */
const MAX_REPLY = 4000
/**
 * 一轮回复最多发几条（用户 m02557-1：机器人像话唠一样刷屏）。
 *
 * 以前模型写几段 [fd]、再被 split() 按 1800 字切几块，全部逐条发出去，
 * 对方只说了 4 句，机器人回了 7 条。这里硬性封顶：多出来的文字并进最后一条。
 */
const MAX_MSG_PER_REPLY = 3
const MAX_JSON = 160

/** App 拉不到配置时的兜底提示词 */
const DEFAULT_HEAD = [
  '抖音聊天记录 {{count}} 条（是条数，不是人数），按时间正序，最后一条最新。',
  '现在是 {{now}}。',
  '会话：{{group}}{{kind}}。我的 uid 是 {{uid}}。',
  '"我:"开头是我本人说的；"我(这是你之前替我发出去的话)"是我之前回出去的话，不是你新说的话。',
  '其他前缀都是别人说的，每行都写清了「名字(uid 数字) 时间」。',
  '别人分享的卡片/视频/动态提示卡只会写成「（对方发来一个X：标题。这是分享内容，不是他说的话）」。别把那张卡当成跟你说话的人发的，也别对着卡片标题接话。',
  '谁 @ 你、你要回谁，看最后一条和 {{at}}，别回给上一条不相干的人。',
  '{{at}}',
].join('\n')

const DEFAULT_TAIL = [
  '——',
  '你就在这个抖音会话里，直接回复，只输出要发出去的那段话。',
  '不加"回复："、不解释、不用代码块、不加引号。像人打字，短句。',
  '看上面记录再答：记录里没提过的事别编。记录很少（刚加好友、刚开新对话）就先接住对方这句，别假装很熟、别猜之前聊过什么。',
  '只回一次，别连着发好几条。真要分几段说，就每段前面加 [fd]，写成 [fd]第一句 换行 [fd]第二句，会按顺序一条条发出去。',
  '要发卡片就单起一行：[[card:类型]]{单行JSON}（常用 25 名片 / 26 网页卡 / 8 视频 / 77 图集 / 5 表情）。',
].join('\n')

// ------------------------------------------------------------------ 运行状态

/** uid -> 昵称。App 的 /history 回来时会带 members，这里只是兜底展示用 */
const promptNames = new Map()
// buildContext 顺手记下「这轮上下文里最后一张图」：群里常见「先发图、再 @ 我说话」，
// 图片那条没 @ 就不会单独进收件箱，只能从历史里捞
let lastHistoryImg = ''

/*
 * 「只给增量上下文」的游标：每个抖音会话记住「上次已经喂进模型的是哪一条消息」。
 *
 * 参考 AstrBot 的 group_chat_context.py —— on_req_llm 里只把上次注入之后的新消息
 * 贴进去，注入完 records.clear()，队列是消费式的。这样模型不会被同一批老消息
 * 反复喂，token 省下来，也不容易把上一轮已经回过的内容再回一遍。
 *
 * 这里存 serverMsgId（单调递增，比时间戳可靠 —— createTime 秒/毫秒混着来）。
 * 没有记录 = 该会话第一次说话，要全量给一遍，否则模型眼里一片空白。
 */
const lastSeenMsgId = new Map()



/** 抖音会话 id -> chat */
/*
 * 当前活着的 scoped ctx。
 *
 * dsh 热重载插件时，旧的 apply 闭包不会被立刻掐死 —— 一次 25 秒的长轮询可能
 * 还挂在 /inbox 上，醒来后继续用旧 ctx 去取 agents，就会抛
 *   cannot get required service "agents" in inactive context
 * 表现就是「插件的定时器还在跑，但每次都失败」，管理员发什么都进不去。
 * 这里记录最新的 ctx，旧的闭包发现自己的 ctx 不是当前这个就直接退出。
 */
let liveCtx = null

const chats = new Map()
/** 抖音会话 id -> 重置时间（重置后不再拉历史上下文） */
const resetAt = {
  get: (convId) => resetAtOf(convId),
  set: (convId, ms) => setResetAt(convId, ms),
}
/**
 * 插件自己发出去的话（比如 /new 的那句回执）。
 * 这些会落到抖音聊天记录里，下一轮拉历史又会被读回来，模型看见就以为自己说过 ——
 * 所以按「会话 + 原文 + 时间窗」把它们过滤掉。
 */
const selfSent = new Map()

function markSelfSent(convId, text) {
  const k = String(convId)
  const arr = selfSent.get(k) ?? []
  arr.push({ text: String(text ?? ''), at: Date.now() })
  if (arr.length > 30) arr.splice(0, arr.length - 30)
  selfSent.set(k, arr)
}

function isSelfSent(convId, text, t) {
  const arr = selfSent.get(String(convId))
  if (!arr || !arr.length) return false
  const s = String(text ?? '').trim()
  const tm = Number(t ?? 0) * (Number(t ?? 0) > 0 && Number(t) < 1e11 ? 1000 : 1)
  for (const it of arr) {
    if (it.text.trim() === s && Math.abs(tm - it.at) < 120000) return true
  }
  return false
}
/** DSH 会话 id -> chat */
const bySession = new Map()
/** 已经处理过的 inbox seq */
const handled = new Set()
/** 最近的活动（面板要显示） */
const feed = []

/**
 * 收件箱光标必须落盘。
 * 以前它只活在内存里：进程一重启就从 0 重新数，而 App 那边的收件箱序号
 * 也随重启从 0 重数 —— 两边各自的计数器一旦错开（App 重置了、插件还记着 200），
 * /inbox?since=200 就永远返回空。表面现象正是「日志能扫到新消息，但根本没交给 dsh」。
 */
function getCursor() {
  const n = Number(loadState().cursor ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function setCursor(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return
  const st = loadState()
  if (Number(st.cursor ?? 0) === Math.floor(n)) return
  st.cursor = Math.floor(n)
  saveState()
}

let cursor = getCursor()
let running = true
let lastError = ''
let lastTickAt = 0
/** 连续多少轮探不到 App。只用来控制日志频率，不影响逻辑。 */
let failStreak = 0
let replied = 0
let skipped = 0
/** 手动指定的模型（/douim 钉住），持久化在 STATE_FILE.pinned，null = 用引擎默认 */
function getPinned() {
  const p = loadState().pinned
  return p && p.provider && p.model ? p : null
}

function setPinnedValue(v) {
  const st = loadState()
  st.pinned = v && v.provider && v.model ? { provider: String(v.provider), model: String(v.model) } : null
  saveState()
  return st.pinned
}

let pinned = getPinned()
/** 会话模型读写（agents + sessionController 注入后填） */
let modelApi = null

const cfg = {
  /** 群里要不要 @ 才说话 */
  groupAtOnly: true,
  /** 单聊是不是每条都接（用户要求：私聊不用 @ 就响应） */
  directAlways: true,
  /** 上下文条数 */
  contextSize: 60,
  /** 只回这些会话（空 = 全部） */
  whitelist: [],
  /** 管理员 uid：除我自己以外，只有这些人能发 /new */
  admins: [],
  /** 永不回这些会话 */
  blacklist: [],
  /** 回复前面加不加标记，空 = 不加 */
  prefix: '',
  /** 每次回复之间至少隔多久，防刷屏 */
  cooldownMs: 600,
  /** 同一个会话两次回复之间至少隔多久（防连珠炮） */
  minGapMs: 900,
  /**
   * 回复改成蓝字卡（aweType=700）发出，气泡里是蓝字。
   *
   * 默认关（用户 m05903-3）：蓝字卡是 richTextInfos 富文本，每条多几百字节、
   * 还多一层服务端校验（con_id 留空直接被 checkCode=2 整条拒收）。
   * 用户原话「关闭后有可能会减少抖音风控概率」，所以风控期默认用普通白字。
   * 真正的开关在 App 设置页，通过 /config 的 blueText 字段下发。
   */
  blueText: false,
  /**
   * 分段回复开关（用户 m01864 第 4 条）。
   *
   * 关掉 = 模型写了 [fd] 也不切开，整段当一条发；提示词那边 App 已经
   * 换了规则告诉模型「[fd] 不能用」。这里是双保险 —— 模型不听话也不会刷屏。
   *
   * 默认关（用户 m02557-1）：他根本没开分段回复，却收到一连串气泡，
   * 一查是这个默认值写成了 true，模型爱用 [fd]，于是每条回复都被拆成 5~7 条。
   */
  fdSplit: false,
  /**
   * 机器人回话时自动引用「提问的那条」（用户 m02102-3，默认关）。
   *
   * 开关值只存在 App 一处（AppState.aiQuote），插件只管把触发回话的
   * msgId 当 ref 带回 /send —— App 关着就丢掉，开着才挂 ref_msg_info。
   * 这样不会出现「插件以为开着、App 以为关着」的不一致。
   */
  aiQuote: false,
  /**
   * 只给增量上下文：只把「上次之后新增的」消息贴给模型。
   *
   * 关掉（设成 false）就退回老行为 —— 每轮把整个上下文窗口重发一遍。
   * 关掉的好处是模型每次都能看到完整对话（不容易丢线索），代价是 token
   * 消耗大好几倍，且同一段话被反复喂容易让它把回过的东西再回一次。
   */
  incremental: true,
}

/**
 * 把一段纯文字包成「蓝字字体卡」（aweType=700）。
 *
 * richTextInfos[0] 的 infoType=1 是「跳转用户主页」，uid 留空就只是蓝色文字，
 * 不指向任何人；infoType=2 + font_weight=2 才是把整段标成粗蓝字。
 * con_id 必须填当前会话 id，否则客户端不认这张卡。
 */
/**
 * 样式段长度用 **UTF-16 字节数**（JS 字符串长度 × 2）。
 *
 * 依据：用户给的可工作样例里 text 是「文字」两个字，length 写的是 4。
 *   UTF-8 是 6 字节、GBK 是 4 字节、UTF-16 是 4 字节 —— 只有 UTF-16 同时
 *   满足「两个汉字 = 4」。按这个算，「文字」算出来正好 4，跟样例一字不差。
 */
function utf16len(str) {
  return String(str ?? '').length * 2
}

function blueTextCard(text, convId) {
  const body = String(text ?? '')
  /*
   * 严格照抄用户给的样例 —— 这是唯一能出蓝字的形状：
   *   第 1 条 infoType=1（跳转用户），uid/con_id 都留空，length: 9999（覆盖整段，表示「一直有效」）
   *   第 2 条 infoType=2（文字样式），font_weight:"2" 才是蓝字，length: 4
   * 「文字」两个字 length 是 4 = UTF-8 字节数。
   *
   * 之前我把两条的 length 都写成 nbytes(body)，语义变了，客户端解析不出样式段，
   * 整条退化成白字 —— 就是这个「有时候蓝有时候不蓝」。
   * 现在第一条固定 9999，第二条才是真实字节数。
   *
   * ⚠ con_id 必须填真实会话 id，不能留空。
   * 用户 m03299 给的样例里 `"con_id":"6672657342376444429"` 是有值的；
   * 留空的时候服务端 checkCode=2 直接拒收（连引用都不给挂）——
   * 用户 m03262 那条整段丢掉的回复就是这么来的。
   * 客户端靠 con_id 定位「跳转哪个人 / 哪个群」，空值等于坐标缺失。
   */
  return JSON.stringify({
    type: 0,
    instruction_type: 0,
    item_type_local: -1,
    richTextInfos: [
      { info: { uid: '', con_id: String(convId ?? '') }, infoType: 1, length: 9999, location: 0 },
      { info: { font_weight: '2' }, infoType: 2, length: utf16len(body), location: 0 },
    ],
    text: body,
    createdAt: 0,
    is_card: false,
    msgHint: '',
    aweType: 700,
  })
}

function note(kind, text) {
  feed.unshift({ t: Date.now(), kind, text: String(text).slice(0, 120) })
  if (feed.length > 40) feed.length = 40
}

/**
 * 插件日志落一份到文件。
 *
 * 以前只写内存 feed + console.log —— dsh 是图形界面进程，它的 stdout 谁也没接管，
 * 出了问题完全无从查起（日志文件里 grep douim 一条都没有）。落盘之后
 * 「连不上」「没 @ 我」「拉历史失败」这些都能事后核对。
 */
const LOG_FILE = path.join(os.homedir(), '.dsh', 'douim.log')

function writeLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
    const st = fs.statSync(LOG_FILE)
    if (st.size > 2 * 1024 * 1024) {
      // 超过 2MB 只留最后四分之一，避免无限膨胀
      const buf = fs.readFileSync(LOG_FILE, 'utf8')
      fs.writeFileSync(LOG_FILE, buf.slice(-(512 * 1024)))
    }
  } catch { /* 写不了日志不影响主流程 */ }
}

function log(level, msg) {
  note(level, msg)
  writeLog(`[${level}] ${msg}`)
  try {
    if (typeof console !== 'undefined') console.log(`[douim] ${msg}`)
  } catch { /* 日志不影响主流程 */ }
}

// ------------------------------------------------------------- 图片（让模型能看图）

/**
 * 把抖音的图片消息变成模型能看的图片。
 *
 * 流程：/inbox 里 item.img 是 CDN 直链 → 这里下载 → 存进 dsh 的附件库
 * → 拿到 durable ref → 作为 { type:'image', attachment } 塞进 followup 的 content。
 * 下载失败/超大/非图片就返回 null，退化成纯文字（不让整条消息丢）。
 */
const IMG_MAX_BYTES = 8 * 1024 * 1024

function guessMediaType(buf, url) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp'
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  const u = String(url || '').toLowerCase()
  if (u.includes('.png')) return 'image/png'
  if (u.includes('.webp')) return 'image/webp'
  if (u.includes('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/*
 * 图片有两种来源：
 *   1) http(s) 直链 —— 抖音 CDN，要带 UA/Referer 才不 403；
 *   2) data:image/xxx;base64,.... —— App 侧从「故事图片」消息的 inline_pic
 *      字段里解出来的整张图（抖音把图直接塞进消息 JSON 里，没有 URL）。
 * 以前只认 http，所以 type=27 的图全被跳过，模型一直看不到图。
 */
async function fetchImage(url) {
  if (!url) return null
  const dm = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url)
  if (dm) {
    try {
      const buf = Buffer.from(dm[2].replace(/\s+/g, ''), 'base64')
      if (!buf.length || buf.length > IMG_MAX_BYTES) return null
      return { data: buf, mediaType: dm[1] || guessMediaType(buf, '') }
    } catch {
      return null
    }
  }
  if (!/^https?:/i.test(url)) return null
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15000)
    timer.unref?.()
    let res
    try {
      res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          // 抖音 CDN 对 UA/Referer 敏感，不带会 403
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.douyin.com/',
        },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res?.ok) return null
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > IMG_MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > IMG_MAX_BYTES) return null
    return { data: buf, mediaType: guessMediaType(buf, url) }
  } catch {
    return null
  }
}

/** 下载 + 入库，返回 ImageBlock 或 null */
async function toImageBlock(ctx, url) {
  const got = await fetchImage(url)
  if (!got) {
    log('warn', `图片没下下来（${clip(url, 90)}）`)
    return null
  }
  const store = ctx.get('attachments')
  if (!store?.saveImages) {
    log('warn', '附件服务没就绪（attachments 未注入），这张图只能按文字处理')
    return null
  }
  try {
    const refs = await store.saveImages([{ data: got.data, mediaType: got.mediaType }])
    const ref = refs?.[0]
    if (!ref) {
      log('warn', '图片入库没拿到 ref')
      return null
    }
    log('info', `图片已入库 ${got.mediaType} ${Math.round((got.data?.length ?? 0) / 1024)}KB`)
    return { type: 'image', attachment: ref }
  } catch (e) {
    log('warn', `图片入库失败：${e?.message ?? e}`)
    return null
  }
}

// ------------------------------------------------------------------ HTTP

async function call(path, opts = {}) {
  const ctl = new AbortController()
  // 长轮询要能等满 25 秒，所以按需给超时；普通请求还是 10 秒
  const ms = Number(opts.timeoutMs ?? (path.includes('wait=1') ? CALL_TIMEOUT_MS : 10000))
  const timer = setTimeout(() => ctl.abort(), ms)
  timer.unref?.()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${base()}${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'X-DouIM-Key': loadKey(), 'Content-Type': 'application/json' },
        body: opts.body,
        signal: ctl.signal,
      })
      if (res.status === 401 && attempt === 0) {
        // 密钥对不上（App 换过密钥 / 换了手机）→ 握一次手，这一轮重试
        if (await handshake()) continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }
    throw new Error('HTTP 401')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 敲一次 /handshake 拿密钥。
 *
 * 这条路由 App 侧不校验 key（socket 只绑 127.0.0.1，能连上的必然是同一台机器
 * 上的进程），拿到后落盘，后续所有请求都用它。
 */
async function handshake(port = PORT) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2000)
  timer.unref?.()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/handshake?pa=${encodeURIComponent(String(PORT))}`, {
      signal: ctl.signal,
    })
    if (!res.ok) return false
    const j = await res.json()
    if (j?.ok !== true || typeof j.key !== 'string' || j.key.length < 16) return false
    setKey(j.key)
    if (Number(j.port) > 0 && Number(j.port) !== PORT) PORT = Number(j.port)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 依次探端口，第一个 /ping 通的就用它 */
async function discoverPort() {
  const ping = async (port, key) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 1200)
    timer.unref?.()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`, {
        headers: key ? { 'X-DouIM-Key': key } : {},
        signal: ctl.signal,
      })
      if (res.status === 401) return 401
      if (!res.ok) return false
      const j = await res.json()
      return j?.ok === true ? port : false
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
  const tryOne = async (port) => {
    const withKey = await ping(port, loadKey())
    if (withKey === 401) {
      // 端口有人在听，只是密钥对不上 —— 握一次手再来
      const ok = await handshake(port)
      if (!ok) return false
      const again = await ping(port, KEY)
      return again === port ? port : false
    }
    return withKey
  }
  // 先试当前端口，再试清单里的
  const order = [PORT, ...PROBE_PORTS.filter((p) => p !== PORT)]
  for (const p of order) {
    const hit = await tryOne(p)
    if (hit) { PORT = hit; return hit }
  }
  return false
}

/** 提示词（从 App 的 /config 拉，改了会自动更新） */
let prompt = { head: '', tail: '', at: 0 }
const PROMPT_TTL = 30_000

async function loadPrompt(force = false) {
  if (!force && prompt.at && Date.now() - prompt.at < PROMPT_TTL) return prompt
  try {
    const r = await call('/config')
    if (r?.ok) {
      prompt = {
        // App 侧已经把「开头/结尾」合并成一个 promptAll，这里统一当 head 用，
        // tail 留空（旧版两个框的值也能被 promptHead 兼容读到）。
        head: String(r.promptAll ?? r.promptHead ?? ''),
        // 取不到就按「关」处理 —— 与 App 侧 AppState.fdSplit() 的默认值保持一致
        fdSplit: r.fdSplit === undefined ? false : !!r.fdSplit,
        tail: String(r.promptAll ? '' : (r.promptTail ?? '')),
        selfUid: String(r.uid ?? ''),
        useDsh: r.useDsh === undefined ? true : Boolean(r.useDsh),
        at: Date.now(),
      }
      // 白名单 / 兜底模型也一起同步
      cfg.whitelist = String(r.whitelist ?? '')
        .split(/[,，\n\r\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      // 黑名单：命中的会话一律不回（App 侧 /blackadd 写进来）
      cfg.blacklist = String(r.blacklist ?? '')
        .split(/[,，\n\r\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      // 管理员：只有「我」和名单里的人能发 /new
      cfg.admins = String(r.admins ?? '')
        .split(/[,，\n\r\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      const bad = cfg.admins.filter((x) => !/^\d{5,25}$/.test(x))
      if (bad.length) {
        prompt.adminWarn = true
        log('warn', `管理员名单里有不像 uid 的项：${bad.slice(0, 3).join(' ')}（要填对方的纯数字 uid，不是 conversation_id）`)
      } else {
        prompt.adminWarn = false
      }
      // 分段回复开关：App 设置页改了就跟着变
      cfg.fdSplit = prompt.fdSplit
      // 蓝字回复开关（用户 m05903-3）：App 设置页是唯一开关，没传就保持关闭
      if (r.blueText !== undefined) cfg.blueText = !!r.blueText
      const cs = Number(r.contextSize)
      if (Number.isFinite(cs) && cs >= 4 && cs <= 200) cfg.contextSize = Math.floor(cs)
      fallbackApi.base = String(r.apiBase ?? '')
      fallbackApi.key = String(r.apiKey ?? '')
      fallbackApi.model = String(r.apiModel ?? '')
    }
  } catch { /* 拉不到就沿用上一次 */ }
  return prompt
}

/** dsh 连不上时用的兜底模型 */
const fallbackApi = { base: '', key: '', model: '' }

async function online() {
  try {
    const r = await call('/ping')
    const ok = r?.ok === true
    /*
     * 接入「App 是否安装了」的判定。
     *
     * 连上 → miss 归零；连不上 → miss++，累计到阈值就自动下载 APK。
     * 放在这里而不是 tick 里，是因为面板的 data() 也会调它 ——
     * 用户一打开面板就会触发探测，不用等代聊那一轮。
     */
    if (ok) noteHit()
    else noteMiss()
    return ok
  } catch {
    noteMiss()
    return false
  }
}

// ------------------------------------------------------------ App 缺失处理
//
// 用户只装了插件、没装抖IM App 的情况很常见（在 dsh 里装插件比装 APK 容易）。
// 以前的表现就是面板一直显示「没连上抖IM（先在手机上打开它）」，
// 用户不知道该去干什么 —— 甚至不知道需要装一个 App。
//
// 这里做三件事：
//   ① 连续探测失败 N 次后，判定为「未安装」，进入下载流程；
//   ② 后台把 APK 从 GitHub Releases 拉到手机上（走本机已有网络）；
//   ③ 面板上把状态改成「已下载，去点安装」，并给出文件路径。
//
// 下载目标：/sdcard/Download/DSH-Go/douim-v{version}.apk
// （一加/小米这类机器上 Download 目录是用户能直接点开的，
//   比丢在 proot 内部让用户找不到强得多）

/** App 的版本与下载地址（发新版改这里） */
const APP_VERSION = '2.0.0'
const APP_REPO = 'https://github.com/xqe-bkflda/douim'
const APP_APK_NAME = `douim-v${APP_VERSION}.apk`

/*
 * 下载源的选择很关键 —— 实测过：
 *   github.com            → 连不上
 *   raw.githubusercontent → 连不上
 *   api.github.com        → 通
 *
 * 所以自动下载不能走 release 资产的直链，必须走 API。
 * 而且 contents API 对 >1MB 的文件只给 download_url（指向 raw，还是不通），
 * 必须再查一次 git/blobs/<sha> 拿 base64 —— 那条对大文件没有上限。
 *
 * 两个源都留着：直链留着给网络通畅的环境，API 是主力。
 */
const APP_DL_SOURCES = [
  {
    name: 'api-blob',
    // 先 contents 查 sha，再 blobs 取 base64
    async fetch() {
      const api = `https://api.github.com/repos/xqe-bkflda/douim`
      const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'douyinIM_for_dsh' }
      const r1 = await fetch(`${api}/contents/${APP_APK_NAME}`, { headers: h })
      if (!r1.ok) throw new Error(`contents HTTP ${r1.status}`)
      const j1 = await r1.json()
      // 小文件直接带 content；大文件要再查一次 blobs
      if (j1.content && j1.encoding === 'base64') {
        return Buffer.from(j1.content, 'base64')
      }
      const r2 = await fetch(`${api}/git/blobs/${j1.sha}`, { headers: h })
      if (!r2.ok) throw new Error(`blobs HTTP ${r2.status}`)
      const j2 = await r2.json()
      if (j2.encoding !== 'base64' || !j2.content) throw new Error('blob 没有 base64 内容')
      return Buffer.from(j2.content, 'base64')
    },
  },
  {
    name: 'raw',
    async fetch() {
      const url = `https://github.com/xqe-bkflda/douim/raw/main/${APP_APK_NAME}`
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
  },
]
const APP_APK_URLS = APP_DL_SOURCES.map((x) => x.name)

/** 探测失败多少次才认为「没装」 */
const MISS_LIMIT = 6

const appState = {
  miss: 0,           // 连续探测失败次数
  missing: false,    // 判定为未安装
  downloading: false,
  done: false,       // 已经下载完
  path: '',          // 下载到的路径
  err: '',
  at: 0,
}

/** 手机上下载目录（优先外部存储，退而求其次用 proot 内的路径） */
function downloadDir() {
  const cands = [
    '/sdcard/Download/DSH-Go',
    '/storage/emulated/0/Download/DSH-Go',
    path.join(os.homedir(), 'Download'),
  ]
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true })
      // 能写才算数
      fs.accessSync(d, fs.constants.W_OK)
      return d
    } catch { /* 试下一个 */ }
  }
  return null
}

async function downloadApp() {
  if (appState.downloading || appState.done) return
  const dir = downloadDir()
  if (!dir) {
    appState.err = '找不到可写的下载目录'
    return
  }
  appState.downloading = true
  appState.err = ''
  const dest = path.join(dir, APP_APK_NAME)
  log('info', `开始下载抖IM App → ${dest}`)

  for (const src of APP_DL_SOURCES) {
    try {
      const buf = await src.fetch()
      // APK 是 zip，头四字节 PK —— 下到的不是 HTML 错误页才算成功
      if (buf.length < 100_000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error(`内容不像 APK（${buf.length} 字节）`)
      }
      fs.writeFileSync(dest, buf)
      appState.done = true
      appState.path = dest
      appState.downloading = false
      log('info', `抖IM App 已下载：${dest}（${(buf.length / 1048576).toFixed(1)} MB）`)
      return
    } catch (e) {
      appState.err = String(e?.message ?? e)
      log('warn', `下载失败（源 ${src.name}）：${appState.err}`)
    }
  }
  appState.downloading = false
}

/**
 * 每次探测失败调一次。
 *
 * 连续 MISS_LIMIT 次才判定未安装 —— 单次失败可能只是没启动、
 * 或 App 正在被系统回收，立刻弹「你没装」是误报。
 */
function noteMiss() {
  appState.miss++
  if (appState.miss >= MISS_LIMIT && !appState.missing) {
    appState.missing = true
    appState.at = Date.now()
    log('warn', `连续 ${appState.miss} 次连不上抖IM，判定为未安装，开始后台下载`)
    // 不 await：面板那边立刻能看到 downloading 状态
    downloadApp()
  }
}

function noteHit() {
  appState.miss = 0
  appState.missing = false
}

/**
 * 把插件自己干的事写进 App 的「输出」页。
 *
 * App 侧路由是 /dshlog?text=...，LogStore 收到会加前缀 "DSH(版本):"。
 * 失败就算了 —— 这只是给人看的，不能因为它把主流程带崩。
 */
async function dshLog(ctx, text, ver) {
  const t = String(text ?? '').trim()
  if (!t) return
  try {
    const v = ver === false ? '' : (ver ? String(ver) : '')
    const q = `/dshlog?text=${encodeURIComponent(t)}` + (v ? `&ver=${encodeURIComponent(v)}` : '')
    await call(q, { timeoutMs: 5000 })
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ 小工具

const clip = (s, n = 30) => {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const out = []
  for (const b of message.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n').trim()
}

/** 长回复按句子切开，别把一大段糊在一条消息里 */
function split(text, limit = MAX_REPLY) {
  const t = String(text ?? '').trim()
  if (!t) return []
  if (t.length <= limit) return [t]
  const parts = []
  let rest = t
  while (rest.length > limit) {
    let cut = -1
    for (const mark of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', ';']) {
      const i = rest.lastIndexOf(mark, limit)
      if (i > cut) cut = i + mark.length
    }
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/**
 * 从一段回复里切出「文字段」和「卡片段」。
 *
 * 约定语法（写进提示词里教模型用）：
 *   [[card:26]]{"link_url":"...","title":"..."}
 * 冒号后面是 msg_type，花括号是完整 content。大括号用配对计数找结尾，
 * 所以 content 里带嵌套对象也不会切错。
 */
/**
 * 一轮回复最多发几条（用户 m02557-1）。
 *
 * 模型爱写 [fd] 分段，每段又可能被 split() 按 1800 字切块，全部发出去就是刷屏：
 * 对方说 4 句，机器人回 7 条。这里把超出的「文字段」合并成一条（卡片照发），
 * 再多的卡片也只保留 MAX_MSG_PER_REPLY - 1 张。
 */
function capParts(parts) {
  const list = (parts || []).filter(Boolean)
  if (list.length <= MAX_MSG_PER_REPLY) return list
  const texts = []
  const cards = []
  for (const p of list) {
    if (p.kind === 'card') cards.push(p)
    else {
      const t = String(p.text ?? '').trim()
      if (t) texts.push(t)
    }
  }
  const merged = texts.join('\n\n').trim()
  const out = []
  if (merged) out.push({ kind: 'text', text: merged })
  for (const c of cards.slice(0, MAX_MSG_PER_REPLY - 1)) out.push(c)
  return out.length ? out : list.slice(0, 1)
}

function parseReply(text, convId) {
  let raw = String(text ?? '')
  /*
   * [fd] 分段发送：模型想连发好几条，就写成
   *   [fd]第一条
   *   [fd]第二条
   * 先按 [fd] 切开，每段各自走后面的卡片解析，最后按顺序一条条发出去。
   * 这样模型不用猜「一条消息最长多少字」，也不会被 split() 的标点规则打乱。
   */
  const fdSeg = []
  if (/\[fd\]/i.test(raw)) {
    if (!cfg.fdSplit) {
      // 分段功能关了：把 [fd] 抹掉，整段当一条发
      raw = raw.replace(/\[fd\]/gi, '').trim()
    }
  }
  if (/\[fd\]/i.test(raw)) {
    for (const one of raw.split(/\[fd\]/i)) {
      const t = String(one ?? '').trim()
      if (t) fdSeg.push(t)
    }
    if (fdSeg.length > 1) {
      const all = []
      for (const seg of fdSeg) {
        for (const part of parseReply(seg, convId)) all.push(part)
      }
      return all
    }
    raw = fdSeg.length ? fdSeg[0] : raw
  }
  const out = []
  const re = /\[\[card:([a-z]{1,6}|\d{1,6})\]\]/g
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(last, m.index).trim()
    if (before) out.push({ kind: 'text', text: before })
    const start = raw.indexOf('{', m.index + m[0].length)
    if (start < 0) { last = m.index + m[0].length; continue }
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) { last = m.index + m[0].length; continue }
    const json = raw.slice(start, end + 1)
    try {
      const obj = JSON.parse(json)
      const kindName = String(m[1]).toLowerCase()
      if (kindName === 'at') {
        /*
         * [[card:at]]{"uid":"123","text":"你好"}
         * 拼成蓝字艾特卡：richTextInfos[0] 是跳转用户（infoType=1，客户端画成蓝色），
         * con_id 交给 App 侧补（模型不该知道会话 id 长什么样）。
         */
        const uid = String(obj.uid ?? obj.user_id ?? '').trim()
        const body = String(obj.text ?? obj.msg ?? '').trim()
        if (!uid) throw new Error('at 卡缺 uid')
        const content = JSON.stringify({
          type: 0,
          instruction_type: 0,
          item_type_local: -1,
          richTextInfos: [
            { info: { uid, con_id: String(convId ?? '') }, infoType: 1, length: 9999, location: 0 },
            { info: { font_weight: '2' }, infoType: 2, length: 4, location: 0 },
          ],
          text: body,
          createdAt: 0,
          is_card: false,
          msgHint: '',
          aweType: 700,
        })
        out.push({ kind: 'card', type: 7, content })
        last = end + 1
        re.lastIndex = last
        return out
      }
      /*
       * [[card:web]]{...} —— 网页分享卡（用户 m06177-4 指定的新样例）。
       *
       * 本质是富文本卡（aweType=700），URL 直接放在 text 里，抖音客户端自己
       * 抓标题和封面。原来那个 [[card:26]] 是官方 web_page 四字段结构，
       * 模型老编不准 title/cover，换成这个之后只要给一个网址就行。
       * 模型偷懒只写 "这里填url" 就当没写，回一句提示别把占位符发出去。
       */
      if (kindName === 'web' || kindName === 'url' || kindName === 'link') {
        const u = String(obj.text ?? obj.url ?? obj.link_url ?? '').trim()
        if (!/^https?:\/\//i.test(u)) {
          out.push({ kind: 'text', text: `（网页卡里没有网址：${clip(u || json, 60)}）` })
          last = end + 1
          re.lastIndex = last
          continue
        }
        const content = JSON.stringify({
          type: 0,
          instruction_type: 0,
          item_type_local: -1,
          text: u,
          createdAt: 0,
          is_card: false,
          msgHint: '',
          aweType: 700,
          updateConversationTime: true,
        })
        out.push({ kind: 'card', type: 7, content })
        last = end + 1
        re.lastIndex = last
        continue
      }
      const content = JSON.stringify(obj)
      out.push({ kind: 'card', type: Number(m[1]), content })
      last = end + 1
      re.lastIndex = last
    } catch {
      out.push({ kind: 'text', text: `（卡片 JSON 写错了：${clip(json, 80)}）` })
      last = end + 1
      re.lastIndex = last
    }
  }
  const tail = raw.slice(last).trim()
  if (tail) out.push({ kind: 'text', text: tail })
  return out
}

/** 该不该接这句话 */
/**
 * 谁能发 /new —— 只有我本人，加上管理员名单里的人。
 * 别人发 /new 一律不认（也不回话，免得被当成可用指令）。
 */
function canReset(item) {
  // 我自己发的：App 侧已经标了 mine，直接放行
  if (item.mine) return true
  // App 侧 isAdmin() 才是权威判定（它拿 sender 和名单逐个比数字），插件不再自己瞎猜
  if (item.admin) return true
  const uid = String(item.from ?? '').trim()
  if (!uid) return false
  const self = String(prompt.selfUid ?? '').trim()
  if (self && uid === self) return true
  // 兜底：名单里直接写了这个 uid
  return cfg.admins.includes(uid)
}

/**
 * 名单匹配：会话 id 和 uid 都认。
 *
 * 以前只比 convId，用户在设置里填的是对方的 uid，结果一条都匹配不上，
 * 表现就是「黑白名单根本没用」。私聊的 convId 形如
 * `0:1:<我>:<对方>`，本身就把 uid 包在里面了，所以两个方向都判一次。
 */
function listHas(list, convId, uid) {
  if (!Array.isArray(list) || list.length === 0) return false
  const c = String(convId ?? '')
  const u = String(uid ?? '')
  return list.some((x) => {
    const v = String(x ?? '').trim()
    if (!v) return false
    if (v === c || (u && v === u)) return true
    if (c && c.includes(v)) return true
    if (u && v.includes(u)) return true
    return false
  })
}

function shouldAnswer(item) {
  const convId = String(item.conv ?? '')
  if (!convId) return { ok: false, why: '没有会话 id' }
  const uid = String(item.from ?? '')
  const text = String(item.text ?? '').trim()

  /*
   * 我本人和管理员排在最前面：他们发的 /new、/reset、指令、以及要用工具的
   * 话，不该被群聊「没 @ 我」或白名单挡掉。黑白名单对这两种身份也不生效 ——
   * 名单是用来挡外人的。
   */
  /*
   * 我自己说的话：只有「指令」（斜杠开头）才交给我处理，普通闲聊一律不回。
   *
   * 以前这里 `item.mine` 直接放行，于是形成自问自答死循环：我回一句 → 那句
   * 被当成别人说的话又喂回来 → 再回一句 → …… 用户看到的就是机器人对着
   * 自己的回复一直接话（「胡言乱语」）。
   */
  if (item.mine) {
    if (!text) return { ok: false, why: '没有文字' }
    /*
     * 我自己发的：
     *   · /xxx      → 指令，要处理
     *   · cai_xxx   → 我在直接问 AI，要处理（内容去掉 cai_ 前缀后交给模型）
     *   · 其它      → 我随口说的话，不用回（否则会自问自答）
     */
    if (text.startsWith('/')) return { ok: true }
    if (/^cai_/i.test(text)) return { ok: true }
    return { ok: false, why: '我自己说的话，不用回' }
  }
  // 管理员是另一个人，他说的要回（他只在自己写指令时才走上面那条逻辑）
  if (item.admin) {
    if (!text) return { ok: false, why: '没有文字' }
    return { ok: true }
  }

  if (listHas(cfg.blacklist, convId, uid)) return { ok: false, why: '在黑名单里' }

  if (!text) return { ok: false, why: '没有文字' }

  /*
   * 白名单一旦填了，就只回名单里的会话 —— 单聊也不例外。
   * 以前单聊走 `if (!group) return { ok: true }` 直接放行，白名单等于只
   * 管群，20 个单聊照聊，用户看到的就是「白名单没用」。
   */
  if (cfg.whitelist.length > 0 && !listHas(cfg.whitelist, convId, uid)) {
    return { ok: false, why: '不在白名单' }
  }

  const group = Number(item.type) === 2
  if (!group) return { ok: true }
  if (item.at) return { ok: true }
  return { ok: false, why: '群里没 @ 我' }
}

// ------------------------------------------------------------------ 上下文

/**
 * 拼这一轮喂给模型的上下文。
 *
 * 为什么带 JSON：卡片、表情、引用、@ 这些在纯文本里全丢了，模型看不出
 * 「他发的是个视频还是句话」。纯文本给一份读起来顺，JSON 兜细节。
 */
async function buildContext(convId, item) {
  // fromName 现在是干净的会话名（不带未读数）；兜底用 uid
  const who = String(item.fromName || item.from || '').trim() || '对方'
  const lines = []
  // 每轮重新记，避免上一轮的图串到这一轮
  lastHistoryImg = ''
  let groupName = ''
  let isGroup = Number(item.type) === 2
  // /new 之后只丢掉「重置那一刻之前」的旧消息，之后说的话照样要带上。
  // 以前是只要重置过就整段跳过历史，导致重置一次以后再也读不到对方和我说的话。
  const cut = resetAt.get(convId) ?? 0
  /*
   * 增量游标：这一轮只贴「上次之后新增的」消息。
   * 第一次（lastSeenMsgId 里没有这个会话）全贴一遍 —— 否则模型对这段对话一无所知。
   * 之后每次只贴新增部分，DSH 会话自己的历史里已经有前面那些了。
   */
  const seenBefore = lastSeenMsgId.has(convId) ? Number(lastSeenMsgId.get(convId)) : 0
  const incremental = seenBefore > 0 && cfg.incremental !== false
  let maxSeenId = seenBefore
  let droppedByIncrement = 0
  try {
    const h = await call(`/history?conv=${encodeURIComponent(convId)}&n=${cfg.contextSize}`)
    if (h && typeof h.group === 'boolean') isGroup = h.group
    if (h && h.name) groupName = String(h.name)
    // App 在 /history 里带了 uid -> 昵称表，先灌进 promptNames，
    // 下面拼每一行就能显示名字而不是光秃秃一串数字
    if (h && h.names && typeof h.names === 'object') {
      for (const [u, nm] of Object.entries(h.names)) {
        if (u && nm) promptNames.set(String(u), String(nm))
      }
    }
    for (const m of h?.items ?? []) {
      if (cut && Number(m.t ?? 0) > 0 && Number(m.t) < cut) continue
      // 撤回的消息不进上下文 —— 它既不是新说的话，也不该让模型去接。
      // App 侧已经拦了一道，这里再兜一次（老 App 没有 revoked 字段就跳过）。
      if (m.revoked) continue
      // 插件自己发出去的回执 / 提示语，不当成聊天内容喂给模型
      // （但要区分「主人自己打的」和「我替他发出去的」—— 见下面的 mineTag）
      const mineTag = isSelfSent(convId, m.text, m.t)
        ? '我(这是你之前替我发出去的话)'
        : (m.mine ? '我' : '')
      /*
       * 增量过滤：已经喂过的（id <= seenBefore）直接跳过，只贴新的。
       *
       * 注意别把「这一轮的触发消息」也滤掉 —— 万一服务端 id 比游标小
       * （同一毫秒发的、或者本地补发），至少保证最后那条一定在里面。
       */
      const mid = Number(m.id ?? 0)
      if (incremental && mid > 0 && mid <= seenBefore) { droppedByIncrement++; continue }
      // 只按 uid 判断是谁；名字只作展示，避免同名/精度问题串人
      // 名字 + uid + 时间：模型以前只看到「谁: 内容」，既不知道是谁（同名/精度）、
      // 也不知道是什么时候说的，回起来就很容易岔。
      const nm = mineTag
        || (String(m.name ?? '').trim()
          || promptNames.get(String(m.from))
          || (String(m.from) === String(item.from) ? who : '')
          || `uid ${m.from}`)
      const speaker = `${nm}(uid ${m.from}) ${clockOf(m.t)}`
      let body = String(m.text ?? '').trim() || '(空)'
      /*
       * 主人的 /cai 直问：前缀只在 App 侧用来区分「这是命令」，
       * 传给模型的时候必须剥掉，否则模型会去解释「你说了 /cai xxx」。
       * 老写法 cai_ 也一起剥。
       */
      if (mineTag === '我') {
        if (/^\/cai\s+/i.test(body)) body = body.replace(/^\/cai\s+/i, '').trim() || body
        else if (/^cai_/i.test(body)) body = body.replace(/^cai_/i, '').trim() || body
      }
      const json = String(m.json ?? '').trim()
      /*
       * 省 token：普通文字消息（type=7）的 JSON 和正文几乎一样，一律不再附。
       * 只有卡片/表情/引用这类「纯文字读不出是什么」的才附一小段 JSON。
       */
      const plain = Number(m.type ?? 0) === 7
      /*
       * 别人的卡片一律降噪。
       *
       * 用户的原话：A 连发三张 json 卡、B @ 我「你好啊」，结果模型回
       * 「你刚刚发的卡片我很喜欢」—— 它把 A 的卡片当成了跟我说话的人发的。
       * 卡片 JSON 对理解上下文没用，只让人（模型）认错人，所以：
       *   - 我/管理员发的卡片：留一小段，方便它知道自己在发什么
       *   - 别人的卡片：只留一句「（发了一张卡片：类型 N）」，不带 JSON
       * 群聊在聊什么仍然看得到（每行的名字+时间+正文都还在），
       * 但不会再被别人的卡片内容带跑。
       */
      const mineOrAdmin = Boolean(m.mine)
      let extra = ''
      if (!plain && json && json !== body) {
        if (mineOrAdmin) {
          extra = `\n  <json>${clip(json, MAX_JSON)}</json>`
        } else {
          extra = `（发了一张卡片：类型 ${Number(m.type ?? 0)}）`
        }
      }
      /*
       * 引用回复：`/history` 里带 quote {id,status,why,uid,name,text}。
       *
       * 模型以前完全看不到「这句是在回谁」—— 群里两个人前后各说一句，它就挑
       * 最近那条接，接得驴唇不对马嘴。这里把被引用的那句原样贴回去，并且
       * 明确写成「回的是 <谁> 说的 <内容>」，它就不会再串人。
       * 被引用那条已撤回/删除时 App 给的是空 text + why，那就只写状态。
       */
      if (m.quote && Number(m.quote.id ?? 0) > 0) {
        const q = m.quote
        const qWho = String(q.name ?? '').trim()
          || promptNames.get(String(q.uid ?? ''))
          || (q.uid ? `uid ${q.uid}` : '')
          || '某人'
        const qText = String(q.text ?? '').trim()
        if (qText) {
          extra += `\n  （这条是在引用回复 ${qWho} 说的：「${clip(qText, 200)}」）`
        } else {
          extra += `\n  （这条是在引用一条${q.why ? `（${q.why}）` : ''}的消息，内容已经拿不到了）`
        }
      }
      lines.push(`${speaker}: ${body}${extra}`)
      // 取上下文窗口里「对方发的、最新的一条」图；mine 发的图不算
      if (m.img && !m.mine) lastHistoryImg = String(m.img)
      if (Number(m.id ?? 0) > maxSeenId) maxSeenId = Number(m.id)

    }
  } catch (e) {
    log('warn', `拉历史失败：${e?.message ?? e}`)
  }
  /*
   * 增量过滤之后一条都不剩（常见于：对方隔很久才来一句，而上下文窗口里
   * 全是早就喂过的旧消息）→ 至少把窗口里最后几条带上，不然模型手上什么都没有，
   * 只能瞎猜。这里不把游标往前推，下一轮该补的还会补。
   */
  if (!lines.length && incremental && droppedByIncrement > 0) {
    try {
      const h2 = await call(`/history?conv=${encodeURIComponent(convId)}&n=6`)
      for (const m of h2?.items ?? []) {
        if (cut && Number(m.t ?? 0) > 0 && Number(m.t) < cut) continue
        if (m.revoked) continue
        if (isSelfSent(convId, m.text, m.t)) continue
        const nm = m.mine ? '我'
          : (String(m.name ?? '').trim() || promptNames.get(String(m.from)) || `uid ${m.from}`)
        const body = String(m.text ?? '').trim() || '(空)'
        lines.push(`${nm}(uid ${m.from}) ${clockOf(m.t)}: ${body}`)
        if (Number(m.id ?? 0) > maxSeenId) maxSeenId = Number(m.id)
      }
      log('info', `${who} 这轮没有新消息，兜底带了最近 ${lines.length} 条`)
    } catch (e) {
      log('warn', `兜底拉历史失败：${e?.message ?? e}`)
    }
  }
  // 这一轮喂到哪儿了，记下来（下一轮只贴比它新的）
  if (maxSeenId > 0) lastSeenMsgId.set(convId, maxSeenId)

  // 这一轮里同一个人连发的另外几条（已合并处理，不再各自触发一轮模型）
  if (Array.isArray(item.extraLines) && item.extraLines.length) {
    for (const one of item.extraLines) {
      const t = String(one ?? '').trim()
      if (t) lines.push(`${who}: ${t}`)
    }
  }
  /*
   * 触发这轮的那条消息，必须出现在上下文里（用户 m02557-13）。
   *
   * 上下文是从 /history 拉的，而 App 那边消息落缓存比收件箱入队晚一点点，
   * 于是经常出现：收件箱说「对方刚发了最后一条」，可 /history 里最后一行
   * 还是机器人自己刚才那句 —— 模型（图七）就抱怨「记录里只有我自己的消息，
   * 没什么可回的」，然后什么也不做。
   *
   * 这里兜一道：触发消息的正文不在 lines 里，就手动补成最后一行。
   */
  const trigger = String(item.text ?? '').trim()
  if (trigger && !lines.some((ln) => ln.endsWith(`: ${trigger}`))) {
    lines.push(`${who}: ${trigger}`)
  }

  const p = await loadPrompt()
  const fill = (tpl) => String(tpl ?? '')
    .replaceAll('{{count}}', String(lines.length))
    .replaceAll('{{who}}', who)
    .replaceAll('{{group}}', groupName || who)
    .replaceAll('{{kind}}', isGroup ? '（群聊）' : '（单聊）')
    .replaceAll('{{at}}', item.at ? `${who} 刚刚 @ 了我，正文在最后一条。` : `${who} 刚刚发来最后一条。`)
    .replaceAll('{{name}}', who)
    .replaceAll('{{uid}}', String(prompt.selfUid || ''))
    .replaceAll('{{now}}', nowText())

  let head = fill(p.head || DEFAULT_HEAD)
  /*
   * 分段回复关着的时候，把提示词里教模型用 [fd] 的句子也一起抹掉。
   *
   * 光在 parseReply 里不切还不够 —— 模型看到「每段前面加 [fd]」就会
   * 真的写成 [fd]第一条 [fd]第二条，抹掉标记之后还是变成一整段，
   * 读起来前言不搭后语。所以关掉时提示词里就不该出现这条规则。
   */
  if (!cfg.fdSplit) {
    head = head
      .split(/\n/)
      .filter((ln) => !/\[fd\]/i.test(ln))
      .join('\n')
  }
  if (item.mine || item.admin) {
    // 告诉模型「这次说话的是谁」—— 只有本人/管理员这条链才有工具，得让它知道
    head += `\n[身份] 这次说话的是我的主人${item.mine ? '本人' : '授权的管理员'}（uid ${item.from}）。`
      + `你有本机的工具权限，需要时可以真的动手做事（跑命令、读写文件、查资料），不用只回文字。`
  }
  const tail = fill(p.tail || DEFAULT_TAIL)

  return head + '\n' + (lines.length ? lines.join('\n') + '\n' : '') + tail
}

/** 当前时间（给提示词里的 {{now}} 用） */
/** 毫秒/秒两套都吃，输出 HH:mm */
function clockOf(t) {
  const n = Number(t ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '--:--'
  const ms = n > 100000000000 ? n : n * 1000
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function nowText() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${wd}`
}

// ------------------------------------------------------------------ 主体

export function apply(ctx) {
  // ------------------------------------------------------------ 模型读写

  // 读一个会话当前用哪个模型 / 给它钉一个模型。优先走 sessionController，
  // 退而求其次直接读 Session 的 requestHeader。
  ctx.inject(['agents'], (ctx) => {
    async function readModel(sessionId) {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return null
      try {
        const proj = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
        const pick = proj?.pending ?? proj?.lastUsed
        if (pick?.provider) return { provider: pick.provider, model: pick.model, effort: pick.reasoningEffort ?? null, from: 'projection' }
      } catch { /* 投影没注册就换别的路 */ }
      try {
        const cfg = agent.session.requestHeader()?.config
        if (cfg?.provider) return { provider: cfg.provider, model: cfg.model, effort: cfg.reasoningEffort ?? null, from: 'header' }
      } catch { /* 没历史就返回 null */ }
      try {
        const d = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (d?.provider) return { provider: d.provider, model: d.model, effort: d.reasoningEffort ?? null, from: 'default' }
      } catch { /* 没有默认模型服务就算了 */ }
      return null
    }

    async function pinModel(sessionId, provider, model) {
      const agent = ctx.agents.get(sessionId)

      // ① 最稳的一条：直接往这条 session 追加 model/selection 事件。
      //    这条事件是持久的，重启后 modelSelection 投影会把它读成 pending，
      //    selectionFor() 的 picked 就非空，请求一定按它走。
      if (agent !== undefined) {
        try {
          agent.session.append('model/selection', { provider, model })
          return true
        } catch { /* 没权限就走下面 */ }
      }

      // ② 内存里的选择（不改全局默认）
      const ctl = ctx.get('sessionController')
      if (agent !== undefined) {
        const sel = ctl?.agents?.selectForNextRequest
        if (typeof sel === 'function') {
          sel.call(ctl.agents, agent, { provider, model })
          return true
        }
      }

      // ③ 最后才动全局默认
      if (typeof ctl?.commands?.selectModel === 'function') {
        await ctl.commands.selectModel({ sessionId, provider, model })
        return true
      }
      return false
    }

    /** 把当前 pinned 应用到所有已经建好的代聊会话上 */
    async function applyPinned() {
      if (!pinned) return 0
      let n = 0
      for (const chat of chats.values()) {
        try {
          if (await pinModel(chat.sessionId, pinned.provider, pinned.model)) n++
        } catch { /* 单条失败不影响别的 */ }
      }
      return n
    }

    modelApi = { read: readModel, pin: pinModel, applyPinned }
    return () => { modelApi = null }
  })

  ctx.inject(['agents'], (ctx) => {
    // 这个 ctx 就是 tick / open / ask 实际用的那个，记下来给旧闭包判活
    liveCtx = ctx
    ctx.effect?.(() => () => { if (liveCtx === ctx) liveCtx = null })

    // -------------------------------------------------------------- 会话映射

    /**
     * 把一条代聊会话的工具面收干净。
     *
     * 为什么必须做：代聊是「陌生人发消息 → 我这边一个完整 dsh agent 跑一轮」，
     * 那个 agent 默认带着 bash / write / MCP，等于把手机交出去了。
     * restrict({ allow: [] }) 会把所有全局工具从这条会话可见的 schema 里摘掉，
     * 模型连工具名都看不到，只能回文字。
     */
    /**
     * 给可信会话装一个「自己压缩上下文」的工具。
     *
     * 背景：dsh 的 compaction-basic 默认 auto=true，靠 agent/pre-step 钩子
     * 在快爆窗口时自动压，压完调用的模型看到的是摘要而不是原话 —— 表现就是
     * 「聊到一半它忘了前面」。
     *
     * 这里不动那个开关（改 preset 的配置树要重启宿主，而且 compaction 服务被
     * preset 的 isolate 隔在组内），而是反过来：给模型一个 compact_context
     * 工具，让它在「感觉自己记不住前面」时自己压一次。
     *
     * compaction 服务在 preset 的隔离域里，host 层 ctx.get('compaction') 拿不到，
     * 必须走 agentPresets.serviceFor(agent, 'compaction')。
     */
    function registerCompactTool(agentCtx, agent) {
      const tools = agentCtx?.tools
      if (!tools || typeof tools.register !== 'function') return false
      tools.register({
        name: 'compact_context',
        description:
          '把这段对话的早期内容压缩成摘要，腾出上下文空间。'
          + '当你觉得上下文快满了、或者记不清前面聊过什么时调用。'
          + '压缩后最近几轮对话会保留原文，更早的内容变成摘要。',
        parameters: {
          reason: { type: 'string', description: '为什么现在要压缩（一句话，会写进日志）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args, exec) {
          const a = exec?.agent ?? agent
          const pv = agentCtx.get('agentPresets') ?? ctx.get('agentPresets')
          let comp
          try {
            comp = pv?.serviceFor?.(a, 'compaction')
          } catch (e) {
            return { ok: false, message: `拿不到压缩服务：${e?.message ?? e}` }
          }
          if (!comp || typeof comp.compactIfNeeded !== 'function') {
            return { ok: false, message: '这个会话没有压缩服务，压不了。' }
          }
          const why = String(args?.reason ?? '').trim() || '模型自己判断需要压缩'
          try {
            const r = await comp.compactIfNeeded(a, 'pressure', exec?.signal)
            if (r === null || r === undefined) {
              return { ok: true, message: '现在还不到需要压缩的程度，上下文空间还够。' }
            }
            log('info', `模型自己压了一次上下文：${why}`)
            return { ok: true, message: `压好了。理由：${why}` }
          } catch (e) {
            log('warn', `模型自己压缩失败：${e?.message ?? e}`)
            return { ok: false, message: `压缩失败：${e?.message ?? e}` }
          }
        },
      })
      return true
    }

    /**
     * 把派头像（模型）也交给模型自己挑。
     *
     * 原来只有斜杠指令 /douim、/douim clear，但用户碰到过一次：
     * 他压根没配模型，代聊一路报「没有可用模型」，而他不会去敲 /douim
     * —— 那条指令本身也得有模型才跑得起来，死循环。
     *
     * 现在给它一个工具：能列出宿主里注册过的 provider 和 model，
     * 能读当前这条会话用的是什么，也能把某个模型钉给代聊、或改回默认。
     * 用户在聊天里说一句「帮我配一下模型」就够了。
     */
    function registerModelTool(agentCtx, agent) {
      const tools = agentCtx?.tools
      if (!tools || typeof tools.register !== 'function') return false
      tools.register({
        name: 'douim_model',
        description:
          '管理抖IM代聊使用的模型。'
          + 'action=list 列出这台机器上可用的 provider 和 model；'
          + 'action=read 看当前这条对话用的是哪个模型；'
          + 'action=pin 把某个模型钉给代聊（需要 provider 和 model 两个参数）；'
          + 'action=clear 让代聊改回引擎默认模型。'
          + '用户说「代聊没配模型」「帮我配个模型」「换个模型」时用这个工具，'
          + '不要让他自己去敲斜杠指令。',
        parameters: {
          action: {
            type: 'string',
            description: 'list / read / pin / clear，默认 list',
            enum: ['list', 'read', 'pin', 'clear'],
          },
          provider: { type: 'string', description: 'action=pin 时要用的 provider，例如 deepseek' },
          model: { type: 'string', description: 'action=pin 时要用的 model id，例如 deepseek-chat' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              providers: { type: 'array', items: { type: 'string' } },
              models: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (_a, v) => [{ type: 'text', text: String(v?.message ?? '') }],
        },
        async execute(args, exec) {
          const act = String(args?.action ?? 'list').toLowerCase()
          const b = apply.__bridge
          // setup 阶段 agent 还没建好，真正的 agent 从 exec 里拿
          const me = exec?.agent ?? agent

          if (act === 'clear') {
            b?.setPinned?.(null)
            log('info', '模型让代聊改回了引擎默认模型')
            return { ok: true, message: '代聊已经改回引擎默认模型。' }
          }

          if (act === 'read') {
            const sid = me?.session?.id ?? me?.id
            const got = sid ? await b?.readModel?.(sid) : null
            const pin = b?.pinned?.()
            const lines = []
            lines.push(got ? `这条对话当前用：${got.provider}/${got.model}` : '这条对话还没跑过，读不到模型')
            lines.push(pin ? `代聊现在钉的是：${pin.provider}/${pin.model}` : '代聊现在用引擎默认模型')
            return { ok: true, message: lines.join('\n') }
          }

          if (act === 'pin') {
            const prov = String(args?.provider ?? '').trim()
            const mod = String(args?.model ?? '').trim()
            if (!prov || !mod) {
              return { ok: false, message: 'pin 需要同时给 provider 和 model；要不知道有哪些就先 action=list。' }
            }
            b?.setPinned?.({ provider: prov, model: mod })
            const n = (await b?.applyPinned?.()) ?? 0
            log('info', `模型把代聊改成了 ${prov}/${mod}`)
            return { ok: true, message: `代聊改用 ${prov}/${mod}${n ? `（已套到 ${n} 条会话）` : ''}。` }
          }

          // list
          const providers = []
          try {
            const llm = ctx.get('llm')
            const list = llm?.listProviders?.() ?? []
            for (const p of list) if (p?.id) providers.push(String(p.id))
          } catch { /* 没有 llm 服务就退到默认模型 */ }

          const all = []
          const detail = []
          try {
            const llm = ctx.get('llm')
            for (const p of providers) {
              let ms = []
              try { ms = await llm.listModels(p) } catch { ms = [] }
              for (const m of ms) {
                all.push(`${p}/${m.id}`)
                detail.push(`${p}/${m.id}${m.name && m.name !== m.id ? `  （${m.name}）` : ''}`)
              }
            }
          } catch { /* ignore */ }

          const def = ctx.get('agentDefaultModel')?.currentSelection?.()
          const pin = b?.pinned?.()
          const head = []
          head.push(def ? `引擎默认模型：${def.provider}/${def.model}` : '引擎没有配默认模型')
          head.push(pin ? `代聊当前钉住：${pin.provider}/${pin.model}` : '代聊当前用引擎默认模型')
          if (!detail.length) {
            head.push('没列到任何模型。宿主可能还没配 provider，或者 provider 没有返回模型目录。')
            return { ok: true, message: head.join('\n'), providers }
          }
          head.push('', '可用模型：', ...detail.map((s) => `· ${s}`))
          head.push('', '要用哪个就说「用 xxx 那个」，我会用 action=pin 帮你钉上。')
          return { ok: true, message: head.join('\n'), providers, models: all }
        },
      })
      return true
    }

    function lockTools(agent) {      if (!agent) return false
      try {
        agent.ctx.tools.restrict({ allow: [] })
      } catch (e) {
        // 拿不到 scoped tools 服务就退回 guard，至少挡住执行
        try {
          agent.ctx.tools.guard(() => '这个会话不允许调用工具')
        } catch {
          log('warn', `工具锁没挂上：${e?.message ?? e}`)
          return false
        }
      }
      return true
    }

    /**
     * 抖音会话 -> 固定的 DSH 会话；同一个会话串行，不抢同一轮。
     *
     * trusted = true 表示说话的是「我本人或管理员」：
     * 这种会话单独用 `-adm` 后缀的 session，**不挂工具锁**，可以正常用 bash/write 等工具；
     * 陌生人进来的那条照旧锁死。两条链完全隔离，不会互相污染。
     */
    /**
     * 会话里的身份不能混用同一条 DSH 会话。
     *
     * 同一条抖音群既会收到主人/管理员的消息，也会收到陌生人的消息。以前
     * chats 只按 convId 存，两种身份交替进来就会不停命中「身份变化，重建会话」，
     * 每条消息都在 dispose + resume，工具权限跟着来回翻 —— 表现就是
     * 「管理员明明在名单里，却还是用不了指令和工具」。
     * 现在按 convId + 身份分两条完全独立的链，各自稳定。
     */
    function chatKey(convId, trusted) {
      return String(convId) + (trusted ? '|trusted' : '|public')
    }

    async function open(convId, name, trusted) {
      const key = chatKey(convId, trusted)
      const known = chats.get(key)
      if (known?.handle) {
        // 复用的会话也补一次锁（restrict 是 scope effect，幂等且便宜）
        if (!trusted && !lockTools(known.handle.agent)) {
          try { known.handle.dispose() } catch { /* ignore */ }
          chats.delete(key)
          bySession.delete(known.sessionId)
          throw new Error('代聊会话的工具锁没挂上，为安全起见这条不代聊')
        }
        return known
      }

      // 会话 id 带「第几代」：/new 时把代数 +1，就真的换了一条 DSH 会话，
      // 而不是 resume 回那条带着旧记忆的会话。代数落盘，重启后也不会退回去。
      const gen = genOf(convId)
      const suffix = gen > 0 ? `-g${gen}` : ''
      const stable = 'douim-' + convId.replace(/[^0-9a-zA-Z]/g, '').slice(-14) + suffix
          + (trusted ? '-adm' : '')
      const opt = pinned ? { agentOptions: { provider: pinned.provider, model: pinned.model } } : {}
      // 可信会话（我 / 管理员）要能正常用工具：给这条会话挂上 agent preset。
      // 为什么必须挂：dsh-web-app 的 host 层把 tool-bash / tool-fs / tool-fs-search /
      // tool-jobs / skill 全部 disabled 了，改由每个 preset 自己挂一份。
      // agents.create/resume 不带 setup 就不会挂 preset，于是这类会话只有 host 层的
      // 68 个工具 —— 里面根本没有 bash/write/read，表现就是「管理员用不了工具」。
      // 陌生人的会话不挂 preset（挂上去的工具是 scoped registration，工具锁 restrict
      // 只约束 global 工具，拦不住它），保持锁死。
      let presetId = null
      if (trusted) {
        try {
          const pv = ctx.get('agentPresets')
          if (pv) presetId = (await pv.resolve(undefined))?.id ?? null
        } catch { /* 没有 preset 服务就按老样子跑 */ }
      }
      const presetSetup = presetId ? async (agentCtx) => {
        try {
          const pv = agentCtx.get('agentPresets') ?? ctx.get('agentPresets')
          if (pv) await pv.mount(agentCtx, presetId)
          log('info', `可信会话 ${stable} 已挂上工具集 ${presetId}`)
          // 挂完 preset 再装自己的工具：压缩服务在 preset 的隔离域里，
          // 只有这一步之后 agentPresets.serviceFor()` 才取得到。
          try {
            if (registerCompactTool(agentCtx)) {
              log('info', `可信会话 ${stable} 已装上 compact_context（模型可以自己压上下文）`)
            }
          } catch (e) {
            log('warn', `装 compact_context 失败：${e?.message ?? e}`)
          }
          // 模型自己配模型 —— 用户没配模型时代聊一路报错，他也想不起来敲 /douim
          try {
            if (registerModelTool(agentCtx, agentCtx.agent)) {
              log('info', `可信会话 ${stable} 已装上 douim_model（模型可以自己配模型）`)
            }
          } catch (e) {
            log('warn', `装 douim_model 失败：${e?.message ?? e}`)
          }
        } catch (e) {
          log('warn', `挂工具集失败（${presetId}）：${e?.message ?? e}`)
        }
      } : undefined
      const withPreset = presetSetup ? { setup: presetSetup } : {}
      let handle = null
      try {
        handle = await ctx.agents.resume({ resumeSessionId: stable, ...opt, ...withPreset })
        log('info', `续上会话 ${stable}`)
      } catch {
        try {
          handle = await ctx.agents.create({ sessionId: stable, meta: { cwd: process.cwd() }, ...opt, ...withPreset })
          log('info', `新建会话 ${stable}`)
        } catch {
          const alt = `${stable}-${Math.random().toString(36).slice(2, 6)}`
          handle = await ctx.agents.create({ sessionId: alt, meta: { cwd: process.cwd() }, ...opt, ...withPreset })
          log('warn', `会话 id 撞了，改用 ${alt}（上下文会断）`)
        }
      }
      if (pinned && modelApi) {
        try {
          await modelApi.pin(handle.agent.id, pinned.provider, pinned.model)
        } catch { /* 钉不住就按引擎默认跑 */ }
      }

      // 安全：陌生人来的那条一律不给工具（不能让他碰到 bash / write / MCP）；
      // 「我」和管理员来的那条不锁，正常用工具。锁不上就宁可这条不代聊。
      if (!trusted && !lockTools(handle.agent)) {
        try { handle.dispose() } catch { /* 已经废了就随它 */ }
        throw new Error('代聊会话的工具锁没挂上，为安全起见这条不代聊')
      }

      const chat = {
        convId,
        name: name ?? '',
        sessionId: handle.agent.id,
        handle,
        buffer: [],
        waiter: null,
        chain: Promise.resolve(),
        lastReplyAt: 0,
        trusted: Boolean(trusted),
      }
      chats.set(key, chat)
      bySession.set(chat.sessionId, chat)
      return chat
    }

    function settle(chat, reason) {
      const w = chat.waiter
      if (!w) return
      chat.waiter = null
      clearTimeout(w.timer)
      const reply = chat.buffer.join('\n').trim()
      chat.buffer = []
      if (reason && reason.kind === 'error') {
        w.reject(new Error(`回合出错：${reason.error?.message ?? reason.kind}`))
        return
      }
      if (!reply) {
        w.reject(new Error(`这一轮没产出文字（${reason?.kind ?? '?'}）`))
        return
      }
      w.resolve(reply)
    }

    ctx.on('session/event', (session, event) => {
      const chat = bySession.get(session?.id)
      if (!chat) return
      if (event.type === 'assistant/message') {
        const t = textOf(event.data?.message)
        if (t) chat.buffer.push(t)
        return
      }
      if (event.type === 'turn/end') settle(chat, event.data?.reason)
    }, { global: true })

    /** dsh 这边起不来时，直接拿 App 里填的 API 跑一轮 */
    async function askFallback(text) {
      const { base, key, model } = fallbackApi
      if (!base || !key || !model) return null
      const url = base.replace(/\/+$/, '') + '/chat/completions'
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TURN_TIMEOUT_MS)
      timer.unref?.()
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: text }],
            temperature: 0.8,
          }),
          signal: ctl.signal,
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          log('warn', `兜底接口 HTTP ${res.status}：${clip(t, 120)}`)
          return null
        }
        const j = await res.json()
        const out = j?.choices?.[0]?.message?.content
        return typeof out === 'string' && out.trim() ? out.trim() : null
      } catch (e) {
        log('warn', `兜底接口失败：${e?.message ?? e}`)
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    function ask(convId, name, text, imgBlock, trusted) {
      return open(convId, name, Boolean(trusted)).then((chat) => {
        const run = chat.chain.then(() => new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (chat.waiter?.timer === timer) {
              chat.waiter = null
              reject(new Error(`等回复超时（${Math.round(TURN_TIMEOUT_MS / 1000)} 秒）`))
            }
          }, TURN_TIMEOUT_MS)
          timer.unref?.()
          chat.waiter = { resolve, reject, timer }
          chat.buffer = []
          try {
            chat.handle.agent.followup(Object.freeze({
              id: `douim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'user',
              // 有图就 [图, 文字]：模型能真的看见对方发的那张图
              content: imgBlock ? [imgBlock, { type: 'text', text }] : [{ type: 'text', text }],
              source: { kind: 'douim:private', plugin: 'local-douim', key: convId },
            }))
          } catch (e) {
            clearTimeout(timer)
            chat.waiter = null
            reject(e)
          }
        }))
        chat.chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 60)))
        return run
      })
    }

    /**
     * /new：把这条抖音会话的 DSH 会话丢掉重建。
     * 重建后 buildContext 会因为 resetAt 跳过历史拉取，模型从空开始。
     */
    async function resetChat(convId, name, trusted) {
      // 身份两条链（trusted / public）都要丢掉，不然 /new 只重置了一半
      for (const k of [chatKey(convId, true), chatKey(convId, false)]) {
        const old = chats.get(k)
        if (!old) continue
        try { old.handle.dispose?.() } catch { /* 已经没了 */ }
        chats.delete(k)
        bySession.delete(old.sessionId)
      }
      // 关掉旧会话还不够：以前 /new 之后 open() 会 resume 回同一条 sessionId，
      // 那条会话的记忆原封不动带回来，所以模型看起来「根本没忘」。
      // 现在把代数 +1，sessionId 变成 douim-xxx-g1，等于换了一条全新的会话。
      const gen = bumpGen(convId)
      resetAt.set(convId, Date.now())
      const chat = await open(convId, name, trusted)
      log('info', `已为 ${name} 开第 ${gen} 代新对话（旧上下文已丢弃）`)
      return gen
    }

    /** 先走 dsh；dsh 这条链挂了就换成 App 里配的 API */
    async function askOrFallback(convId, name, text, imgBlock, trusted) {
      // 设置里选了「只用外部 API」就完全不碰 dsh，省得又要开端口、又会串上下文
      if (prompt.useDsh === false) {
        return await askFallback(text)
      }
      try {
        return await ask(convId, name, text, imgBlock, trusted)
      } catch (e) {
        const why = e?.message ?? String(e)
        /*
         * 只有「dsh 根本不可用」才该让兜底模型上场。
         *
         * 以前这里什么都兜：agent 忙、压缩中、这一轮超时、工具报错……
         * 全都被当成「dsh 挂了」→ 用户会莫名其妙收到一条兜底模型的回复，
         * 而且那条回复没有身份、没有上下文，看起来像野生的。
         * 现在只在这几种才算真挂：连不上端口 / 服务没了 / 上下文失效。
         */
        const reallyDown = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|inactive context|cannot get required service|no such|没连上/i.test(why)
        if (!reallyDown) {
          log('warn', `dsh 这一轮没成（${why}），但 dsh 还活着，不走兜底模型`)
          throw e
        }
        log('warn', `dsh 连不上（${why}），试兜底模型`)
        const got = await askFallback(text)
        if (got) return got
        throw e
      }
    }

    // -------------------------------------------------------------- 轮询

    let timer = null
    let busy = false

    let tickCount = 0

    /**
     * 每天让 AI 读一遍群聊节律数据，写一句人话结论回来。
     *
     * 用户 m05903-1：「让ai分析全天群里消息比较多的时段」。
     *
     * 做法：从 App 的 /heat 拿到 168 个「星期几×小时」的计数，
     * 拼成一张紧凑的表喂给模型，只要它回一句话（不超过 80 字），
     * 直接 POST 回 /heat 让 App 存进 SharedPreferences，设置页就能看到。
     *
     * 一天只跑一次（结论写在 state 里记日期），失败就明天再说 ——
     * 这个分析纯锦上添花，绝不能因为模型报错影响代聊。
     */
    /**
     * 群聊节律 → 24 个倍率（用户 m08057）。
     *
     * App 侧现在把「每收到一条群消息」按天写进 heat-YYYY-MM-DD.log，
     * 并且自己知道什么时候该总结：
     *   · 周六/周日打开 App → pending = "workday"（总结周一到周四那批）
     *   · 周一打开 App     → pending = "weekend"（总结周五到周日那批）
     *
     * 所以这里不再按日期判重，而是问 App「现在有没有该总结的」。
     * 有就把 24 个小时的条数丢给模型，要 24 个倍率回来：
     *   0.5 = 这个点很热闹，探得勤（间隔减半）
     *   2.0 = 这个点很冷清，省着探（间隔翻倍）
     * 模型没给 / 给的不是 24 个数 → 放弃，下一轮再试（不写脏数据）。
     */
    /** 上次问 App「有没有该总结的」的时间。analyzeHeat 每轮都会调，必须节流。 */
    let heatCheckedAt = 0
    const HEAT_CHECK_GAP = 10 * 60 * 1000

    async function analyzeHeat() {
      /*
       * 节流：tick 每 2 秒跑一轮，而 /heat 是一次真实 HTTP 请求。
       * 不节流的话光是问「要不要总结」一天就要打四万多次 ——
       * 这正是我们要躲的那种「不像真人」的流量。
       * 十分钟问一次，最坏情况下周六早上多等十分钟才总结，无所谓。
       */
      const now = Date.now()
      if (now - heatCheckedAt < HEAT_CHECK_GAP) return
      heatCheckedAt = now

      let heat = null
      try { heat = await call('/heat') } catch { return }
      const pending = String(heat?.pending ?? '')
      if (pending !== 'workday' && pending !== 'weekend') return

      const hours = Array.isArray(heat?.hours) ? heat.hours : []
      if (!hours.length) return
      let total = 0
      for (const h of hours) total += Number(h?.[1] ?? 0)
      // 太少就别让模型对着 0 编故事；等下一批
      if (total < 20) return

      const label = pending === 'workday' ? '工作日（周一到周四）' : '周末（周五到周日）'
      const rows = hours.map((h) => `${String(h?.[0] ?? '?').padStart(2, '0')}:00 ${Number(h?.[1] ?? 0)}条`)
      const promptText = [
        `下面是我这个抖音号最近收到的群消息，按小时统计的条数（${label}）。`,
        rows.join('\n'),
        '',
        '请输出 24 个数字，用英文逗号分隔，不要任何解释、不要换行、不要序号，',
        '每个数字代表「那个小时应该把轮询间隔乘几倍」：',
        '  · 那个点很热闹（消息多）→ 输出小于 1 的数（比如 0.5、0.7），探得勤一点',
        '  · 那个点很冷清（没消息）→ 输出大于 1 的数（比如 1.5、2.5），省着探',
        '  · 拿不准 → 输出 1',
        '允许 0.3 到 3.0 之间的小数。只要 24 个数字，第一个是 00:00。',
      ].join('\n')

      let reply = null
      try { reply = await askFallback(promptText) } catch { reply = null }
      if (!reply) return
      const mult = parseMultipliers(reply)
      if (!mult) {
        log('warn', `节律分析返回的不是 24 个数字，跳过：${clip(String(reply).replace(/\s+/g, ' '), 80)}`)
        return
      }
      try {
        await call('/heat', {
          method: 'POST',
          body: JSON.stringify({ pending, mult: mult.join(',') }),
        })
      } catch (e) {
        log('warn', `写回倍率失败：${e?.message ?? e}`)
        return
      }
      const brief = mult.map((v) => (v < 0.9 ? '快' : v > 1.1 ? '慢' : '·')).join('')
      log('info', `群聊节律已分析（${pending}）：${brief}`)
    }

    /**
     * 从模型回复里抠出 24 个倍率。
     *
     * 模型经常多嘴（"好的，以下是结果：0.8,1.2,..."），所以不要求整段是纯数字，
     * 只要求「按出现顺序能挑出 24 个 0.1~10 之间的数」。挑不到 24 个就返回 null。
     */
    function parseMultipliers(text) {
      const nums = String(text ?? '').match(/\d+(?:\.\d+)?/g)
      if (!nums || nums.length < 24) return null
      const out = []
      for (let i = 0; i < 24; i++) {
        let v = Number(nums[i])
        if (!Number.isFinite(v) || v <= 0) return null
        if (v < 0.3) v = 0.3
        if (v > 3) v = 3
        out.push(Math.round(v * 100) / 100)
      }
      return out
    }


    async function tick() {
      if (!running) return
      // 插件被热重载后，旧闭包的长轮询回来后 ctx 已经失效，直接收摊，
      // 别再拿 inactive ctx 去取 agents（那会一直报错、什么都不干）
      if (liveCtx !== ctx) { timer = null; return }
      /*
       * 光比 liveCtx 不够：插件被热重载时，旧闭包手里的 ctx 已经失效，
       * 但 liveCtx 还指着它（dispose 回调不一定抢在新一轮之前跑完），
       * 于是每一轮都抛 "cannot get required service agents in inactive context"，
       * 一条消息都处理不了 —— 这正是「/new 和代聊时好时坏」的来源。
       * fiber.assertActive() 是 cordis 自己的权威判据，失效就立刻收摊。
       */
      try { ctx.fiber?.assertActive?.() } catch { timer = null; return }
      // busy 卡死自愈：以前只要有一次 tick 卡在某个 await 里不回来，
      // busy 就永远是 true，循环此后每一次都直接 return ——
      // 表面现象就是「引擎明明在跑，但一条消息都不回」。
      if (busy) {
        if (lastTickAt && Date.now() - lastTickAt < 60000) return
        log('warn', `上一轮 tick 卡了 ${Math.round((Date.now() - lastTickAt) / 1000)} 秒，强制重启这一轮`)
        busy = false
      }
      if (!(await online())) {
        /*
         * 探不到 App 时以前直接 return —— 但 lastTickAt 是在这行之后才写的，
         * 于是每轮都「探不到 → return → lastTickAt 永远停在旧值」，
         * 看门狗每 10 秒判一次「停摆 400 多秒，重新点火」，
         * 日志刷到一万八千行、App 那边永远显示连不上。
         * 现在无论连没连上，这一轮都算跑过；失败只按次数抽样记日志。
         */
        lastTickAt = Date.now()
        const found = await discoverPort()
        if (!found) {
          lastError = `连不上抖IM（端口 ${PORT} 没开）`
          if (++failStreak % 20 === 1) {
            log('warn', `连不上抖IM（试过 ${PROBE_PORTS.join('/')} 都没人应答），第 ${failStreak} 次`)
          }
          return
        }
        lastError = ''
        failStreak = 0
        log('info', `端口自己找到了：${PORT}`)
      }
      failStreak = 0
      busy = true
      lastTickAt = Date.now()
      tickCount++
      /*
       * 每轮都重拉 /config。以前 prompt 有 30 秒 TTL 缓存，用户在设置里
       * 改完黑白名单，这边还是旧的那份，表现就是「名单改了根本没生效」。
       * /config 是本机 127.0.0.1 的小响应，一轮一次不值得省。
       */
      try { await loadPrompt(true) } catch { /* 拉不到就沿用上一次 */ }
      /*
       * 每天让 AI 总结一次群聊节律（用户 m05903-1）。
       *
       * 放在 loadPrompt 之后、长轮询之前：analyzeHeat 自己按日期判重，
       * 一天最多真跑一次，平时这个 await 只是读一下 state 就返回。
       * 用 try 包死 —— 模型报错/没配模型都不许影响代聊主循环。
       */
      try { await analyzeHeat() } catch (e) { log('warn', `节律分析失败：${e?.message ?? e}`) }
      if (tickCount % 20 === 1) {
        log('info', `轮询心跳 第 ${tickCount} 轮｜cursor=${cursor}｜会话 ${chats.size}｜已回 ${replied}`)
      }
      // 连得上就说明端口没问题，把上一次的报错清掉，别一直挂着吓人
      if (lastError.startsWith('连不上抖IM')) lastError = ''
      try {
        // 长轮询：抖IM 那边一有新消息就立刻返回，不再干等 2 秒。
        // 超时（25 秒没消息）也是正常返回空列表，接着等下一轮。
        // ver 带过去：抖IM 那边靠它判断「插件到底活没活」，也是日志里那行
        // `DSH(v0.x.x): 已连上抖IM` 的版本号来源
        const r = await call(`/inbox?since=${cursor}&wait=1&waitMs=${LONG_POLL_MS}&ver=${encodeURIComponent('v' + PLUGIN_VER)}`)
        const items = r?.items ?? []
        // 自愈：App 那边重启过、收件箱序号从 0 重数，我们手里的光标就会永远超前。
        // 只要服务端说「我现在最大才到 last」，而 last 比我们的 cursor 还小，
        // 就说明两边的计数器错开了 —— 直接把光标拉回到 last，别一辈子问空。
        const last = Number(r?.last ?? 0)
        if (Number.isFinite(last) && last >= 0 && last < cursor) {
          log('warn', `收件箱序号对不上（我方 ${cursor}，App 才到 ${last}），光标拉回到 ${last}`)
          setCursor(last)
          cursor = last
          handled.clear()
        }
        // 同会话合并：一个人连着发五条，以前会触发五轮模型、回五条，
        // 表现出来就是「拦都拦不住」「没头没脑」。这里先把这一批按会话归拢，
        // 每个会话只用最后一条当触发器，其余塞进 extraLines 一起喂上下文。
        const merged = []
        const byConv = new Map()
        for (const item of items) {
          if (handled.has(item.seq)) continue
          handled.add(item.seq)
          if (item.seq > cursor) { cursor = item.seq; setCursor(item.seq) }
          // 指令条（/new 等）单独排队，永远优先执行 —— 以前它会被同会话合并
          // 吞掉（pack.last 换成后面那条普通消息），表现就是「管理员也发不了 /new」。
          if (/^\/(new|reset|清空上下文)$/i.test(String(item.text ?? '').trim())) {
            merged.push({ first: item, last: item, at: Boolean(item.at), extraLines: [], cmd: true })
            continue
          }
          const key = String(item.conv)
          const hit = byConv.get(key)
          if (hit) {
            hit.extraLines.push(String(item.text ?? ''))
            if (item.at) hit.at = true
            hit.last = item
            continue
          }
          const pack = { first: item, last: item, at: Boolean(item.at), extraLines: [] }
          byConv.set(key, pack)
          merged.push(pack)
        }
        for (const pack of merged) {
          const item = pack.last
          item.extraLines = pack.extraLines
          if (pack.at) item.at = true

          // /new：开新对话，不回别的。只有我本人和管理员能发 —— 别人发就当没看见。
          if (/^\/(new|reset|清空上下文)$/i.test(String(item.text ?? '').trim())) {
            const cvId = String(item.conv)
            const nm = item.fromName || String(item.from)
            const byMe = Boolean(item.mine)
            if (!canReset(item)) {
              // 把该填的 uid 直接打出来，不然用户永远不知道该往管理员里填什么
              log('info', `/new 被拦：发指令的人 uid=${item.from}，不在管理员名单（现在名单：${cfg.admins.join(',') || '空'}）—— 要放行就把 ${item.from} 填进设置→管理员`)
              skipped++
              continue
            }
            try {
              const gen = await resetChat(cvId, nm, Boolean(item.mine || item.admin))
              /*
               * 回执一律要发 —— 以前 byMe（我自己发的 /new）不发，结果我自己发完
               * 界面上什么都不出现，完全看不出到底生效没有，等于白做。
               * markSelfSent 会把它从下一轮上下文里滤掉，所以不会污染记忆。
               */
              const ack = '好，我们重新开始。'
              markSelfSent(cvId, ack)
              await call('/send', { method: 'POST', body: JSON.stringify({ conv: cvId, text: ack }) })
              replied++
              log('info', `已为 ${nm} 开第 ${gen} 代新对话${byMe ? '（我自己发的）' : ''}`)
              lastError = ''
            } catch (e) {
              lastError = e?.message ?? String(e)
              log('warn', `/new 失败：${lastError}`)
            }
            continue
          }

          const verdict = shouldAnswer(item)
          if (!verdict.ok) {
            skipped++
            if (verdict.why !== '没有文字') log('info', `${item.fromName || item.from}：${verdict.why}，不回`)
            continue
          }

          const convId = String(item.conv)
          const name = item.fromName || String(item.from)
          log('info', `收到 ${name}${item.at ? '（@ 我）' : ''}：${clip(item.text, 28)}`)

          try {
            // 「我本人」或管理员来的消息 = 可信：这条链可以用 dsh 的工具
            const trusted = Boolean(item.mine || item.admin)
            const chat = await open(convId, name, trusted)
            // 同一会话两条回复之间至少隔 minGapMs，别在对方眼里像刷屏机
            const gap = Math.max(cfg.cooldownMs, cfg.minGapMs || 0)
            const wait = (chat.lastReplyAt || 0) + gap - Date.now()
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))

            const context = await buildContext(convId, item)
            // 对方发的是图片 → 先把图下载入库，再连同文字一起交给模型
            let imgBlock = null
            // 本条自己带图就用本条的；没有就用历史里对方发的最后一张
            // （群里常见「先发图、再 @ 我说你看看这个」，图片那条没 @ 不会单独进来）
            const imgSrc = String(item.img || lastHistoryImg || '')
            if (imgSrc) {
              imgBlock = await toImageBlock(ctx, imgSrc)
              if (imgBlock) log('info', item.img ? '这条是图片，已经下载好交给模型看' : '本条没图，带了上文里最后一张图给模型看')
              else log('warn', '图片下载/入库失败，只能按文字处理')
            }
            const reply = await askOrFallback(convId, name, context, imgBlock, trusted)
            const parts = capParts(parseReply(reply, convId))
            /*
             * 自动引用：把「触发这次回话的那条消息 id」带回 /send。
             * App 那边开关关着就会丢掉这个字段，所以这里永远传，
             * 不用先问 App 开没开（少一次往返，也不会不同步）。
             */
            /*
             * 引用要连 hint 一起带（App 侧 buildRefHint 会用 refType / refText 拼），
             * 只给 ref 的话服务端虽然回 status=0，却会把引用静默丢掉
             * —— 用户 m02557-12「日志成功但气泡里没引用」。详见 quote_send.py。
             */
            const refMsg = item.msgId ? String(item.msgId) : ''
            const refType = Number(item.type) > 0 ? Number(item.type) : 7
            const refText = String(item.text ?? '').slice(0, 40)
            let okAll = true
            let cards = 0
            for (const part of parts) {
              let body
              if (part.kind === 'card') {
                cards++
                body = { conv: convId, content: part.content, type: part.type, ref: refMsg, refType, refText }
              } else {
                for (const chunk of split(part.text)) {
                  const body2 = cfg.prefix ? cfg.prefix + chunk : chunk
                  // 纯文字也套成蓝字卡（aweType=700）：气泡里是蓝字，比干白字好看。
                  // 只有「模型自己写的卡片」不套 —— 那些走上面的 part.kind === 'card'。
                  const sent = cfg.blueText
                    ? await call('/send', {
                      method: 'POST',
                      body: JSON.stringify({ conv: convId, content: blueTextCard(body2, convId), type: 7, ref: refMsg, refType, refText }),
                    })
                    : await call('/send', { method: 'POST', body: JSON.stringify({ conv: convId, text: body2, ref: refMsg, refType, refText }) })
                  if (!sent?.ok) { okAll = false; lastError = sent?.error ?? '发送失败' }
                  // 记成「我自己发出去的」：下一轮拉历史时会标成
                  // 「我(这是你之前替我发出去的话)」，模型就不会把
                  // 自己上一句回复当成主人刚说的一句话（/cai 时最常见）。
                  else markSelfSent(convId, body2)
                  if (parts.length > 1) await new Promise((r) => setTimeout(r, 400))
                }
                continue
              }
              const sent = await call('/send', { method: 'POST', body: JSON.stringify(body) })
              if (!sent?.ok) { okAll = false; lastError = sent?.error ?? '卡片发送失败' }
              else markSelfSent(convId, part.content)
              await new Promise((r) => setTimeout(r, 400))
            }
            chat.lastReplyAt = Date.now()
            replied++
            lastError = ''
            log(okAll ? 'info' : 'warn',
              `回给 ${name}：${clip(reply.replace(/\[\[card:\d+\]\]\{[^}]*\}/g, '[卡片]'), 28)}${cards ? `（含 ${cards} 张卡片）` : ''}`)
          } catch (e) {
            lastError = e?.message ?? String(e)
            log('warn', `处理 ${name} 失败：${lastError}`)
          }
        }
        if (items.length) await call(`/take?seq=${cursor}`)
        else if (last > cursor) {
          // 有更小号的条目但都被标成 taken 了（上一轮取走却没来得及更新光标），
          // 直接把光标推到 last，别再反复问同一段空区间。
          log('warn', `收件箱 ${cursor} 之后没有可取的了（App 已到 ${last}），光标跟进到 ${last}`)
          setCursor(last)
          cursor = last
        }
      } catch (e) {
        lastError = e?.message ?? String(e)
      } finally {
        busy = false
      }
    }

    // 长轮询自己就是节奏：一次 tick 阻塞到有新消息或 25 秒超时，
    // 所以这里用「跑完再排下一次」，不用 setInterval（否则会叠出并发 tick）。
    //
    // 另外：先抢单实例租约。插件被装载两次时，只有拿到租约的那份继续轮询，
    // 另一份安静退出，否则两边会抢同一个收件箱、互相把光标写乱。
    /*
     * 启动时强制抢租约。
     *
     * 租约原本是防「同一份插件被装载两次、两个 tick 抢同一个收件箱」。
     * 但刚启动的进程必然是唯一活着的那个 —— 上一个进程要么已经死了、要么就是
     * 它自己重启。以前这里传 false，dsh 快速重启时旧 owner 的 at 还在 15 秒窗口内，
     * 新进程直接把「另一个实例在跑」当成结论退出了：不轮询、也没有「链接完成」那条日志。
     * 现在启动就抢，重复装载靠心跳超时（LEADER_TTL_MS）来判。
     */
    if (!claimLeader(true)) {
      log('warn', '检测到已有另一个抖IM 插件实例在跑，这一份不轮询（避免抢消息）')
      try { dshLog(ctx, 'douim-link 有另一个实例在跑，这份副本已停用', PLUGIN_VER) } catch { /* ignore */ }
      timer = null
      return
    }
    dshLog(ctx, `douim-link(${PLUGIN_VER}) 已就绪，链接完成`, 'v' + PLUGIN_VER)

    /*
     * 起来先握一次手。
     *
     * App 那边的密钥是随机生成、存在它自己 sp 里的，插件没法预先知道
     * （以前写死 'douim-local-1' 所以随便连）。这里启动就去 /handshake 拿一把，
     * 拿不到也没关系 —— discoverPort() 发现 /ping 返 401 时会再握一次。
     *
     * 这个 inject 回调是同步的，所以不 await，直接后台跑。
     */
    handshake()
      .then((ok) => {
        if (ok) log('info', `已从 App 拿到接口密钥，端口 ${PORT}`)
        else log('warn', `还没握手成功（端口 ${PORT} 没开，或者 App 没启动）—— 下一轮自动发现时会再试`)
      })
      .catch(() => { /* 握手失败不影响主循环，tick 里会再试 */ })

    const loop = async () => {
      if (!running) { timer = null; return }
      try { await tick() } catch { /* tick 内部已兜住 */ }
      if (!running) { timer = null; return }
      timer = setTimeout(loop, POLL_MS)
      timer.unref?.()
    }
    loop()

    // 看门狗：插件被热重载、或某个 await 永远不返回时，定时器可能已经死了，
    // 光靠 loop 自己没法复活。每 10 秒看一眼「上次真正跑过一轮」是多久以前，
    // 超过 90 秒就清掉旧定时器重新点火 —— 宁可多踢一脚，也不要静默地不回消息。
    // 注意：连不上 App 的那几轮现在也会更新 lastTickAt，所以这里不会再把
    // 「App 没开」误判成「循环停摆」刷一屏日志。
    const watchdog = setInterval(() => {
      if (!running) return
      const idle = Date.now() - (lastTickAt || 0)
      if (idle < 90000) return
      log('warn', `轮询停摆 ${Math.round(idle / 1000)} 秒，重新点火`)
      busy = false
      try { clearTimeout(timer) } catch { /* ignore */ }
      timer = null
      try { loop() } catch { /* ignore */ }
    }, 10000)
    watchdog.unref?.()

    ctx.effect?.(() => () => {
      try { clearInterval(watchdog) } catch { /* ignore */ }
    })

    ctx.effect?.(() => () => {
      try { clearTimeout(timer); clearInterval(timer) } catch { /* ignore */ }
      for (const c of chats.values()) {
        try { c.handle.dispose?.() } catch { /* ignore */ }
      }
      chats.clear()
      bySession.clear()
    })

    apply.__bridge = {
      ask,
      open,
      cfg,
      feed,
      setRunning: (v) => { running = !!v },
      isRunning: () => running,
      stats: () => ({
        running,
        cursor,
        chats: chats.size,
        replied,
        skipped,
        lastError,
        lastTickAt,
      }),
      pinned: () => pinned,
      readModel: (sid) => modelApi?.read(sid) ?? null,
      pinModel: (sid, provider, model) => modelApi?.pin(sid, provider, model) ?? false,
      setPinned: (v) => { pinned = setPinnedValue(v) },
      applyPinned: () => modelApi?.applyPinned?.() ?? 0,
      toolsLeft: (sid) => {
        const a = ctx.agents.get(sid)
        if (a === undefined) return -1
        try {
          // view(scope) 的 scope 就是 agent 本身（createScope(loopCtx, this)）
          const v = a.ctx.tools.view(a)
          // run_code 是 PTC 传输层，不算真实工具
          if (!v?.visible) return -1
          let n = 0
          for (const k of v.visible.keys()) if (k !== 'run_code') n++
          return n
        } catch {
          return -1
        }
      },
    }
  })

  // ---------------------------------------------------------------- 斜杠指令

  // /douim        —— 把当前这条对话用的模型钉给代聊
  // /douim clear  —— 改回引擎默认
  ctx.inject(['commands'], (ctx) => {
    const handler = async (invocation) => {
      const arg = String(invocation.rawInput ?? '').trim().toLowerCase()
      const agent = invocation.agent
      const sid = agent?.session?.id ?? agent?.id
      const b = apply.__bridge

      if (arg === 'clear' || arg === 'reset' || arg === '默认') {
        b?.setPinned?.(null)
        log('info', '代聊改回引擎默认模型')
        dshLog(ctx, '代聊模型已改回引擎默认', 'v' + PLUGIN_VER)
        return { kind: 'success', text: '代聊已改回引擎默认模型。' }
      }
      if (arg !== '') {
        return { kind: 'error', text: '用法：/douim（钉住当前对话的模型）或 /douim clear（改回默认）。' }
      }
      if (!sid) return { kind: 'error', text: '这条对话拿不到会话 id。' }
      const got = await b?.readModel?.(sid)
      if (!got) return { kind: 'error', text: '这条对话还没跑过，读不到模型。先随便说一句再来。' }
      b.setPinned({ provider: got.provider, model: got.model })
      const n = (await b.applyPinned?.()) ?? 0
      log('info', `代聊改用当前对话的模型：${got.provider}/${got.model}`)
      dshLog(ctx, `代聊模型已改为 ${got.provider}/${got.model}`, 'v' + PLUGIN_VER)
      return {
        kind: 'success',
        text: `代聊改用 ${got.provider}/${got.model}${n ? `（已套到 ${n} 条会话）` : ''}。`,
      }
    }

    ctx.effect(function* () {
      yield ctx.commands.register({
        name: 'douim',
        description: '把当前对话的模型钉给抖IM代聊，/douim clear 改回默认（模型自己也能用 douim_model 工具做同样的事）',
        input: { hint: '留空＝钉住当前对话的模型；clear＝改回默认' },
        handler,
      })
    }, 'local-douim command')
  })

  // ---------------------------------------------------------------- dsh-go 界面

  ctx.inject(['dshGo'], (ctx) => {
    const bridge = () => apply.__bridge
    const en = (locale) => String(locale).startsWith('en')

    // ---- 面板

    ctx.dshGo.panel('douim', {
      view: (scope, caps) => {
        const zh = !en(caps.locale)
        /*
         * App 没装的时候，面板第一屏就要告诉用户「装什么、在哪装」——
         * 而不是只给一句「没连上」让人自己猜。
         * 已下载完的话直接把路径亮出来，用户去文件管理器点一下就能装。
         */
        return {
          type: 'stack',
          title: zh ? '抖IM' : 'DouIM',
          children: [
            { type: 'callout', text: { $: 'data.state' }, tone: { $: 'data.tone' } },
            /*
             * App 缺失时的安装提示。
             *
             * dsh-go 的 callout 只认 text / tone，没有 visible 属性 ——
             * 所以不能「有就显示、没有就藏」，只能让文案随状态变：
             * 一切正常时这一行是空的（渲染成空 callout 也不占多少高度），
             * 缺 App 时它变成红/黄提示 + 下载进度 + 装完的路径。
             */
            {
              type: 'callout',
              text: { $: 'data.install' },
              tone: { $: 'data.installTone' },
            },
            {
              type: 'keyValue',
              items: [
                [zh ? 'App' : 'App', { $: 'data.app' }],
                [zh ? 'App 安装' : 'App install', { $: 'data.appInstall' }],
                [zh ? '代聊' : 'Relay', { $: 'data.relay' }],
                [zh ? '账号' : 'Account', { $: 'data.nick' }],
                [zh ? '会话' : 'Chats', { $: 'data.chats' }],
                [zh ? '已回' : 'Replied', { $: 'data.replied' }],
                [zh ? '当前对话模型' : 'Model here', { $: 'data.here' }],
                [zh ? '代聊用模型' : 'Relay model', { $: 'data.used' }],
                [zh ? '端口' : 'Port', { $: 'data.port' }],
                [zh ? 'App 引擎' : 'App engine', { $: 'data.engine' }],
                [zh ? '收件箱' : 'Inbox', { $: 'data.inbox' }],
                [zh ? '代聊工具' : 'Tools', { $: 'data.tools' }],
                [zh ? '提示词' : 'Prompt', { $: 'data.prompt' }],
                [zh ? '管理员' : 'Admins', { $: 'data.admins' }],
                [zh ? '最近错误' : 'Last error', { $: 'data.err' }],
              ],
            },
            {
              type: 'callout',
              tone: 'info',
              text: zh
                ? '在新对话里发 /douim 就把那条对话的模型钉给代聊；/douim clear 改回默认。'
                : 'Send /douim in a chat to pin its model for relay; /douim clear resets.',
            },
          ],
        }
      },

      data: async (scope, emit) => {
        const b = bridge()
        const up = await online()
        if (up) await loadPrompt()
        const s = up ? await call('/status').catch(() => null) : null
        const st = b?.stats() ?? {}
        const logged = !!s?.logged

        let hereText = '（没拿到会话 id）'
        if (scope?.sessionId) {
          let got = null
          try {
            got = await b?.readModel?.(scope.sessionId)
          } catch { got = null }
          hereText = got ? `${got.provider}/${got.model}` : '还没跑过'
        }
        const pin = b?.pinned?.()
        const usedText = pin ? `${pin.provider}/${pin.model}` : '引擎默认'

        /*
         * App 缺失提示的文案与色调。
         *
         * 四种状态：
         *   ① 连上了          → 空字符串（不打扰）
         *   ② 正在下载        → 蓝色 info，告诉用户在下了
         *   ③ 下载完          → 绿色 good，给出路径 + 「去点安装」
         *   ④ 判定未装且还没下成 → 红色 bad，给仓库地址兜底
         */
        let install = ''
        let installTone = 'info'
        if (up) {
          install = ''
        } else if (appState.downloading) {
          install = '正在后台下载抖IM App…（约 1.4 MB，网慢要等一会儿）'
          installTone = 'info'
        } else if (appState.done) {
          install = `抖IM App 已下载到：\n${appState.path}\n`
            + '去手机的文件管理器点开这个 APK 安装，装完回来这里会自动连上。'
          installTone = 'good'
        } else if (appState.missing) {
          install = `没检测到抖IM App。自动下载失败了${appState.err ? `（${appState.err}）` : ''}。\n`
            + `可以手动下载：${APP_REPO}\n`
            + `再不行就把 ${APP_APK_NAME} 传到手机点安装。`
          installTone = 'bad'
        }

        emit({
          state: !up ? '没连上抖IM（先在手机上打开它）'
            : !logged ? '抖IM 没登录'
              : st.running ? '代聊中' : '已暂停',
          tone: !up ? 'bad' : !logged ? 'warn' : st.running ? 'good' : 'warn',
          install,
          installTone,
          app: up ? `已连上 ${PORT}` : '没连上',
          appInstall: up ? '已安装'
            : appState.downloading ? '未连上 · 正在下载'
              : appState.done ? '已下载待安装'
                : appState.missing ? '未检测到'
                  : `探测中（${appState.miss}/${MISS_LIMIT}）`,
          relay: st.running ? '开' : '暂停',
          nick: s?.nick || (logged ? String(s.uid) : '未登录'),
          chats: st.chats ?? 0,
          replied: st.replied ?? 0,
          here: hereText,
          used: usedText,
          port: String(PORT),
          engine: s?.engine
            ? `运行中 · 监听 ${s.convCount ?? 0} 个会话 · 第 ${s.ticks ?? 0} 轮`
            : (up ? '没在跑（去 App 里登录并让引擎启动）' : '—'),
          inbox: s ? `${s.inbox ?? 0} 条（累计 ${s.inboxLast ?? 0}）` : '—',
          tools: (() => {
            const sid = [...bySession.keys()][0]
            if (!sid) return '还没有代聊会话'
            const n = apply.__bridge?.toolsLeft?.(sid)
            if (n === -1) return '查不到'
            return n === 0 ? '已锁死（0 个）' : `⚠️ 还剩 ${n} 个`
          })(),
          prompt: prompt.at
            ? `已自定义（${String(prompt.head || '').slice(0, 18) || '开头为空'}…）`
            : '默认',
          admins: s?.admins ? String(s.admins) : '未设置',
          err: st.lastError || '无',
        })
        return () => {}
      },

    })
  })
}
