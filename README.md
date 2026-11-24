# douyinIM_for_dsh

> 让**抖音私信**接上 **DSH** 代聊。
>
> 装在 DSH 上的插件，配合手机上的 [抖IM App](https://github.com/xqe-bkflda/douim) 使用。

| | |
|---|---|
| 插件名 | `local-douyin-im` |
| 版本 | 1.0.0 |
| 依赖 | DSH `>=0.2.1-rc.2 <0.3.0-0` |
| 配套 App | **[xqe-bkflda/douim](https://github.com/xqe-bkflda/douim)** |

---

## ⚠️ 必须先装 App

**这个插件自己不能收发抖音消息。** 它只负责把「DSH 的 AI」和「抖音私信」接起来：

```
抖音 App ←→ 抖IM App（手机，跑 IM 协议）←→ 本机 127.0.0.1:8791 ←→ 本插件 ←→ DSH
```

没有抖IM App，插件连不上任何东西。

**App 下载**：<https://github.com/xqe-bkflda/douim/releases>

> 如果你只装了插件、没装 App，插件会自动在后台把 APK 下到
> `/sdcard/Download/DSH-Go/douim-v2.0.0.apk`，并在面板上提示你去点安装。
> 网不通的时候会退回到「给个仓库地址，你自己下」。

---

## 安装

```bash
# 1. 把插件目录放到 dsh-go 的插件目录
cp -r douyinIM_for_dsh ~/.dsh/dsh-go/plugins/local-douyin-im

# 2. 装进 web profile
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-douyin-im

# 3. 重启引擎（App 的「引擎」页），或者重启 dsh
```

装好之后，App 的「插件」页会出现一张 **抖音IM 代聊** 的卡片，对话详情页的「插件」页签里也有它的面板。

---

## 它做什么

- **一人一会话**：每个抖音会话固定映射一条 DSH 会话，记忆不串
- **触发判定**：群里只接被 @ 的消息，单聊默认都接；白名单 / 黑名单可配
- **上下文注入**：拉最近 60 条带原始 JSON 的消息拼成上下文
- **自动分段**：回复太长按抖音的字数上限切开
- **模型可钉**：`/douim` 把当前对话的模型钉给代聊，`/douim clear` 改回默认
- **图片能看**：抖音的图片是 AES-256-GCM 密文，App 里解密后经 attachments 入库成 ImageBlock 交给模型
- **工具收干净**：代聊会话里 `restrict({ allow: [] })`，模型连 bash / write 的工具名都看不到

---

## 面板

面板上能看到这些实时状态：

| 字段 | 说明 |
|---|---|
| App / App 安装 | 连没连上、装没装 |
| 代聊 | 开 / 暂停 |
| 账号 | 昵称或 uid |
| 会话 / 已回 | 代聊处理了多少 |
| 当前对话模型 / 代聊用模型 | 钉住的是哪个 |
| 端口 | 本机接口端口 |
| App 引擎 | App 那边轮询到第几轮 |
| 收件箱 | 待处理条数 |
| 代聊工具 | 应该显示「已锁死（0 个）」 |
| 提示词 / 管理员 / 最近错误 | — |

---

## 自动下载 App 的逻辑

插件每轮探测 `127.0.0.1:8791/ping`。**连续 6 次失败**才判定为「没装」——单次失败可能只是 App 被系统回收，立刻报「你没装」是误报。

判定后：

1. 后台拉 APK 到 `/sdcard/Download/DSH-Go/douim-v2.0.0.apk`
2. 校验前四字节是不是 `PK\x03\x04`（防止把 HTML 错误页当 APK 存下来）
3. 面板显示「已下载到 …，去文件管理器点开安装」

下载源实测过：`github.com` 和 `raw.githubusercontent.com` 在部分网络下连不上，
但 `api.github.com` 通。所以主力走 **GitHub API**：

```
GET /repos/xqe-bkflda/douim/contents/douim-v2.0.0.apk   → 拿 sha
GET /repos/xqe-bkflda/douim/git/blobs/<sha>             → base64 内容
```

`contents` API 对 >1MB 的文件不给内联内容（只给 `download_url`，指向 raw，还是不通），
必须再查一次 `git/blobs` —— 那条对大文件没有上限。

---

## 配置

App 端改（设置页），插件会自动同步：

- 代聊提示词（`GET /config`）
- 白名单 / 黑名单
- 智能限速 / 分段回复 / 自动引用 / 蓝字回复
- 管理员 uid

插件端常量（改完重启引擎）：

```js
const APP_VERSION = '2.0.0'          // App 版本，发新版改这里
const MISS_LIMIT = 6                  // 探测失败几次算「没装」
const PROBE_PORTS = [8791, 8792, ...] // 端口探测清单
```

---

## 排查

| 现象 | 原因 |
|---|---|
| 面板一直「没连上」 | App 没开，或没登录，或端口被改了 |
| 显示「未检测到」+ 下载失败 | 网络不通，手动去 Releases 下 |
| 代聊工具显示「还剩 N 个」 | 工具没收干净，这是个 bug，报告它 |
| 群里不回复 | 默认只接 @ 你的消息；单聊不受限 |

日志在 App 的「日志」页，插件自己干的事会以 `DSH(版本):` 前缀写进去。

---

## 相关仓库

- **抖IM App**：<https://github.com/xqe-bkflda/douim> —— 抖音私信第三方 Android 客户端
- 逆向报告：App 仓库的 `docs/` 目录

---

## License

MIT。仅供学习研究，使用后果自负。
