# 角色包

一个角色包就是设置页里的一张角色卡：名字、简短的做事步骤、可选的线程模型（`model`），以及派到机器上时用的模型（`machineModel`）和它的家族（`family`）。派活时指定角色，角色的要求会放在任务正文之前。模型留空就沿用已有的线程模型选择，不替角色指定默认模型。角色卡不选机器、帮手、工作目录和权限。

初次创建角色表时自带 `coder`、`reviewer`、`researcher`。设置页「后台帮忙 → 角色 → 推荐角色包」另有四个可逐个安装的推荐项，来自 [tstack](https://github.com/t3dotgg/tstack)（MIT，见仓库的 `THIRD_PARTY_NOTICES`）：

- `full-stop`：完成实现、验证、审查和 CI 跟进，PR 准备好后交回。
- `council`：用可用的最多三个模型共同审查，修复后复审，直到参与者认可结果；有阻塞时如实报告。
- `babysit-pr`：跟进 CI 和评论，核实并修复真实问题，在 PR 逐点回复对应提交和验证。
- `file-pr`：用 gh 创建或更新 PR，正文依次说明问题、修复和验证，不列文件清单。

推荐项不会自动写入新用户或已有用户的角色表。点击安装才保存该角色，之后与自建角色一样可编辑、删除；同名角色不会被安装按钮覆盖。删掉后可再次手动安装。自带、自建和安装的角色合计最多 12 个，每个模板最多 1500 个字符。

审查者与作者使用不同供应商或模型家族是建议，不是规则。只有一个订阅或模型时，使用现有资源，在报告里说明实际参与的模型和限制；不要求购买额外订阅，也不把同一个模型的多次审查说成多个独立模型。

四个推荐角色都禁止合并、自动合并、加入合并队列、推送默认分支和部署。`full-stop` 在 PR 就绪后停止并报告；缺少批准、检查失败或无法完成审查时，报告实际阻塞，不代替用户放行。

这些角色是给执行环境的简短指令，不会给住户增加模型编排器或常驻 PR 监控器。执行环境用已有工具和 gh 完成工作；无法持续等待或调用其他模型时，需要说明限制。机器上用 Kiro、档位是 `edit` 时，带 push、merge 这类词的命令会先问你，所以这几个角色推送时会停下等你点头。

## 两个模型：线程的和机器上的

在设置页的角色里填，或者走 `POST /web/tasks/roles`（有名字的住户在 `/r/<id>` 下）：

```json
{
  "name": "reviewer",
  "template": "只看不改，写出能复现的问题。",
  "model": "anthropic/claude-sonnet-5.5",
  "machineModel": "claude-sonnet-4-6",
  "family": "anthropic"
}
```

- `model` 是住户自己的线程和 GitHub Actions 上的线程调用的模型，写网关的 id。
- `machineModel` 是派到机器上时要帮手用的模型，写帮手自己认的 id（Claude Code 是 `claude-sonnet-4-6` 或 `sonnet` 这类）。它在线上是 `work.model`。两格互不顶替：网关的 id 永远不会当成机器上的模型发出去，住户也不翻译 id、不猜默认值。`machineModel` 空着时 `work.model` 和 `work.family` 都不发，帮手用它自己选的模型。
- `family` 说的是 `machineModel` 是哪家的，由你填，不从 id 的写法猜。小写字母开头，只用小写字母、数字和 `-`，最多 40 个，比如 `anthropic`、`openai`、`kiro-auto`。

旧的角色卡升级后没有机器上的模型。没有这两格的旧页面保存时，已存的 `machineModel` 和 `family` 原样保留，哪怕改了 `model`。改了 `machineModel` 却没给家族时，旧的家族清掉，因为它说的是另一个模型。

用某个角色派到机器上的活（包括沿用这个角色的接着派），在派出时记下当时的 `machineModel` 和 `family`；之后改角色卡，不影响已经排着的活和重发的认领。线程页在帮手旁边写「要的模型」，这只是请求，不代表帮手真的用了它。

Kiro 一直用 auto，所以机器报的帮手是 Kiro 时，线程页不写要的模型。支持这个字段的 runner 遇到 Kiro 会丢掉模型请求，在回执里带一条 `fyi` 的说明，这条说明会出现在那一轮「顺带说的」里。Kiro 的角色把机器上的模型空着就好。老的 runner 不认这两个字段，直接忽略。

线上字段、能力协商见[住户的协议说明](../PROTOCOL.md#jobmodel)。

## 怎么验

`npm run typecheck`，`node test/machine-job-model.mjs`、`node test/task-roles.mjs`、`node test/machine.mjs`、`node test/web-ui.mjs`、`node test/cloud-tasks.mjs`，以及本地 Worker 上的 `node test/run.mjs tasks-roles`。都用假数据，不调付费的帮手。
