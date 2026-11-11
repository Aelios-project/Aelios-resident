# 停下住户正在回的话

住户在聊天里正回着话（包括正在调工具）时，网页和手机的输入框旁边有一个方形的停下按钮。刷新页面后，按钮从服务器读当前这一轮，所以还在。它只停住户这一轮，跟停机器上的线程是两回事。

## 接口

**`POST /web/stop`**。桌面端插件有一份能调的住户接口清单，要把它加进去；这个改动本身不动 Aelios-desktop。

认证跟别的网页接口一样（比如 `x-web-key`），Telegram Mini App 的登录也认。别的住户照常加 `/r/<住户 id>` 前缀，也就是 `/r/<住户 id>/web/stop`。

正文是一个 JSON 对象。停当前这一轮：

```json
{}
```

只停这个页面看到的那一轮：

```json
{ "requestId": "GET /web/messages 给的 requestId" }
```

手机页面总是带上它看到的 id，这样点晚了也不会停掉后面新开的一轮。`GET /web/messages` 不管是整份还是 `same: true`，都带 `turn`：

```json
{ "turn": { "requestId": "当前这一轮的 id", "stopping": false } }
```

没在回话时是 `turn: null`。

回什么：

- `200 { "status": "stopping", "requestId": "当前这一轮的 id" }`：已经叫它停了。接着轮询消息，等 `turn` 变成 null；这个回答不代表收尾已经做完。
- `200 { "status": "idle" }`：现在没在回话。重复点停没关系。
- `409 { "error": "..." }`：正在跑的是另一轮，没停它。
- `400 { "error": "..." }`：JSON 坏了、正文不是对象，或者 `requestId` 不对。
- `401`：没带或带错了网页认证。

## 收尾

停下用的是 Think SDK 公开的 `cancelChat(requestId)`。流被打断时 Think 会把回到一半的话存下来；回复的钩子再用公开的 session 接口删掉这一条没回完的，清掉草稿和这一轮的状态，也不往外发这条回复。她说的那句和之前回完的话都留着。停下那一轮的钩子来晚了，也清不掉新的一轮。

页面上被停下的 `/web/say` 或「重新回答」算主动停下，不算发送失败、不让她重发。排着队的话、机器上各自在跑的活、已经做完的工具动作，都不在这一停的范围里。停下的标记只在当前进程里；停的那一下 Worker 恰好重启的话，这个改动不负责补停。

SDK 文档：

- [取消请求](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/chat-agents/)
- [Think 的回复钩子](https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/)

## 怎么验

```sh
npm run typecheck
node test/chat-stop.mjs
node test/web-ui.mjs
```

对着本地 Worker 的检查：先起这个分支的假上游（`node test/mock-server.mjs`），再用 `wrangler.test.jsonc` 在 18811 端口起一个新 Worker，然后：

```sh
NO_PROXY=127.0.0.1,localhost WORKER_URL=http://127.0.0.1:18811 node test/chat-stop-worker.mjs
```

它测认证和正文检查、回到一半时停下、过期的 id、停下后不留半截话也不留待发状态、停下后下一轮照常回完，以及在一个故意放慢的记忆工具调用中途停下。都是假数据，不调付费模型，也不碰线上。
