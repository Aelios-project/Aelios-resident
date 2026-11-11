# 聊天里的「等你批准」

机器扣住、等你点头的权限请求，会以小卡片出现在主聊天里：线程标题、请求标题、遮掉敏感内容后的命令，以及允许和拒绝两个按钮。卡片是「等你」列表的一个投影，不是存进对话的消息。

`GET /web/messages` 不管是整份还是增量，都带一个 `permissions` 数组。每一项就是 `/web/waiting` 给的那种 `WaitingItem`，`kind: "permission"`，带 `perm` 编号。回答里还带一份完整的 `waiting`，所以批完一个权限后，同一条线程上还没答的问题不会丢。对话本身没变时，轮询也会更新这两份。换住户或退出登录时页面会清掉它们。

回执里 `askKind: "permission"` 的 ask 也会出现在聊天里。它没有活着的权限编号，所以允许和拒绝走 `/web/task/choose`，带原来那张单子的 id，文字是「允许」或「拒绝」。

活着的权限请求，两边都用现有的、要认证的接口回答：

```http
POST /web/waiting/permission
Content-Type: application/json

{"id":"p_0123456789","allow":true}
```

拒绝就是 `allow: false`。答完后两边的卡片都消失，runner 在下一次 poll 时拿到答案。桌面上关掉了这个请求、这一轮结束了或者过期了，聊天里的卡片在下一次轮询时消失。模型不能替你批准。

机器报上来一个权限请求后，会走「等你」原有的推送：开了通知的话，每个请求只推一次，标签是 `permission`。推不推得到，照旧取决于订阅、推送服务和通知设置。推送不需要住户先开口说话。

## 怎么验

```sh
npm run typecheck
node test/chat-permissions.mjs
node test/machine-perms.mjs
node test/waiting.mjs
node test/web-ui.mjs
```

`chat-permissions.mjs` 用 SQLite 存储跑真正的权限上报流程，检查推送、重复上报不重复推、两边共用一个答案、桌面上关掉、页面增量轮询，以及聊天里的两个按钮。

对着本地 Worker：先起 `test/mock-server.mjs`，再用 `wrangler.test.jsonc` 起一个新 Worker，然后：

```sh
NO_PROXY=127.0.0.1,localhost WORKER_URL=http://127.0.0.1:18813 node test/chat-permissions-worker.mjs
```

它配对一个假 runner，检查扣住的请求、允许和拒绝、runner 轮询拿到答案、桌面上关掉。不测浏览器推送，也不测真手机。
