# ChatGPT 模型路由检测器

当前版本：`1.0.1`

这是一个可直接“加载已解压的扩展”的 Chrome / Edge Manifest V3 扩展。它只在 `https://chatgpt.com/*` 工作，每次发送消息或重新生成回答时，核对：

- 浏览器请求中的 `request.model`；
- 服务端响应公开的 `server_ste_metadata.model_slug`；
- 辅助证据：`metadata.model_slug`、`resolved_model_slug`、`requested_model_experience` 和 assistant DOM 的 `data-message-model-slug`。

扩展在 ChatGPT 页面右下角显示一个小状态卡。点击卡片可以查看原始模型字段和判定理由，也可以复制本轮检测结果。

## 安装

1. 下载或解压本目录，不要只选择其中的 `content` 文件夹。
2. 在 Chrome 打开 `chrome://extensions/`，或在 Edge 打开 `edge://extensions/`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展”，选择本目录。
5. 打开或刷新 `https://chatgpt.com/`，正常发送一条消息。

扩展没有单独的登录流程。ChatGPT 页面是否要求登录由 ChatGPT 本身决定；未登录时通常没有可供检测的对话请求，状态会保持等待或显示“无法检测”。

## 状态含义

| 页面状态 | 含义 |
| --- | --- |
| 检测中 | 已观察到本轮请求，正在等待响应中的服务端模型字段。 |
| 模型对应 | 两个主字段完全相等，或命中明确配置的合法映射。 |
| 模型不对应 | 仅在明确配置的不兼容模型对上显示；初始规则为空，避免凭名称误报。 |
| 待确认 | 主字段不同，但没有经过确认的映射关系；即使名称看起来属于同一系列，也不会自动判为对应。辅助字段冲突也会落在此状态。 |
| 无法检测 | 本轮结束但关键字段缺失，或 ChatGPT 接口格式暂不支持。字段缺失不会被当成“不对应”。 |

`assistant metadata.model_slug`、`resolved_model_slug`、DOM slug、`requested_model_experience` 和 `thinking_effort` 是辅助/可选证据，ChatGPT 不一定在每轮提供；详情中显示“未提供（可选）”并不代表本轮失败。响应结束后扩展会短暂等待可能晚到的 telemetry 元数据，再将缺少关键字段的轮次标记为“无法检测”。

响应解析兼容常见的 SSE/JSON 数组、多行 JSON、`event:` 字段以及不同换行符。telemetry 只会在能唯一对应到一轮对话时使用；快速并发多轮造成歧义时会丢弃这条辅助证据，避免把它显示到错误轮次。正在进行的长响应会保留在有限时间窗口内等待晚到元数据。

初始的 `content/model-rules.js` 不包含任何模型映射。确认某组真实请求/响应后，才应在其中加入精确的 `equivalent` 或 `incompatible` 规则；不要仅凭 slug 的相似度填写规则。

## 隐私与能力边界

- 扩展没有后台服务器，不上传检测记录。
- MAIN-world 桥只转发经过长度限制的模型相关标量字段，不转发聊天正文、附件、请求 URL、请求头或账号信息。
- 判定和显示都在本地浏览器完成；结果只保存在当前页面内存，刷新页面即清除。
- 检测的是“浏览器请求写了什么模型”与“服务端返回给浏览器的公开路由元数据是什么”是否一致。
- 它不能证明 OpenAI GPU 实际加载的模型权重，也不能根据回答质量判断“降智”。
- ChatGPT 的内部接口不是稳定公开 API。接口改版时扩展会安全降级为“无法检测”，而不是据此报红。

## 项目结构

```text
chatgpt-model-route-checker/
├── manifest.json
├── README.md
├── content/
│   ├── content.js       # 隔离环境：判定、DOM 证据、状态卡
│   ├── detector.js      # MAIN world：fetch / XHR / Beacon 采集桥
│   ├── model-rules.js   # 保守的本地映射规则（初始为空）
│   ├── style.css
│   └── verdict.js       # 可测试的纯判定引擎
└── test/
    ├── detector.test.js
    ├── static-check.js
    └── verdict.test.js
```

## 本地测试

需要 Node.js 18 或更高版本：

```bash
npm test
npm run check
```

测试覆盖完全相等、明确合法映射、未知映射、字段缺失、辅助字段冲突和明确不兼容规则。

## 版本记录

### 1.0.1

- 增强多种 `server_ste_metadata` 嵌套结构和流式分片格式的解析。
- 等待可能延迟到达的 telemetry，减少短暂显示“无法检测”。
- 在并发轮次下拒绝关联不明确的元数据，避免串轮误判。
- 忽略回答正文中的 JSON 形式模型字段，防止正文被误当成路由证据。
- 将缺失的辅助字段标记为“未提供（可选）”。

### 1.0.0

- 首个可安装版本。
