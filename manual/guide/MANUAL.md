# 腾讯文档插件使用手册

本手册说明怎样组合 `list_tools`、`call_tool`、`local_files` 三个工具完成常见任务。具体某个操作的参数，
永远以 `list_tools({ category })` 实时返回的 schema 为准；手册里的操作名是写作时的快照，服务端可能已更新。

## 一、先选版本：个人版还是企业版

- 个人版（`edition: "personal"`）：QQ / 微信登录的腾讯文档，域名 docs.qq.com。
- 企业版（`edition: "enterprise"`）：企业的腾讯文档，域名 saas.docs.qq.com。
- 用户只连了一个版本时三个工具都可以省略 `edition`。两个都连了，工具会返回 `EDITION_REQUIRED`，
  这时先问用户这次要操作哪一个，再带上 `edition` 重新调用。
- 链接能帮你判断：`docs.qq.com/...` 是个人版，`saas.docs.qq.com/...` 是企业版。
- 两个版本的操作名有少量差别（例如企业版的读正文、上传图片带 `manage.` 前缀），能力也不完全一样，
  见 `ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/enterprise.md" })`。

## 二、目录怎么来的

每个版本背后有 4 个腾讯文档服务，插件已合并成一份目录：

| 类目 | 内容 | 说明 |
|---|---|---|
| `doc` | Word 类在线文档的精细编辑 | 来自 Word 专用服务，名字统一显示为 `doc.xxx` |
| `sheet` | Excel 类在线表格的精细编辑 | 来自表格专用服务，名字统一显示为 `sheet.xxx` |
| `slide` | 幻灯片的精细编辑 | 来自幻灯片专用服务，名字是 `slide_xxx` |
| 其余类目 | 文件管理、知识库、智能文档、智能表格、思维导图、流程图、OCR、剪藏等 | 来自主服务 |

主服务也有一些 Word / 表格 / 幻灯片的"转发版"操作，能力比专用服务少。目录里这类操作带
`forwarded: true`；同一件事两边都有时用不带标记的那个。专用服务暂时不可用时，概览的 `services`
会写明原因，这时只能用转发版。

## 三、通用做法

1. **先定位文档**：一切内容操作都要 `file_id`。来源有三种：用户给的链接（按参数说明传链接或取出 ID）、
   搜索与列表操作（`manage` 类目）、知识库节点（`node_id` 就是 `file_id`）。不要猜 ID。
2. **再判断类型**：不确定是哪类文档时用 `manage.query_file_info` 查，然后只用那一类的操作。
   拿别的类型的操作去改会失败（个人版错误码 400016）。
3. **读之前想清楚用途**：只是阅读、总结、问答时用 `get_content`（企业版 `manage.get_content`）
   一次拿全文；要编辑时改用该类型自己的结构查询操作拿到位置或块 ID，`get_content` 不给位置信息。
4. **批量写**：对同一份文档要写 3 次以上，改用一次提交多条的操作
   （Word 用 `doc.insert_markdown`，表格用 `sheet.set_range_value` / `sheet.set_range_value_by_csv`，
   智能表格用 `smartsheet.add_records`，幻灯片用 `slide_add_shapes` / `slide_add_texts` 等）。
5. **写入要有授权**：新建、修改、删除、移动、改分享只在用户明确要求时做；
   删除、整篇覆盖、递归删目录、扩大分享范围之前，先把影响说清楚再动手。
   一键登录只有读写权限；需要管理权限的操作（个人版）由插件自动改用用户的个人 Token 执行，
   第一次会弹出安全输入框请用户粘贴。不要让用户把 Token 发在对话里。
6. **异步任务**：导入、导出、网页剪藏都是"发起 + 查进度"。查进度间隔 3 秒左右，最多等 1–2 分钟；
   还没好就告诉用户任务仍在进行，并把任务 ID 留下以便之后继续查。失败时把结果里的 `trace_id` 告诉用户。
7. **交付**：完成后把结果里的文档链接原样给用户；没有链接时给出文档标题和所在位置。

## 四、按用户想做的事选入口

| 用户想要 | 推荐做法 | 参考 |
|---|---|---|
| 把对话、笔记、报告、纪要、Markdown 存进腾讯文档 | 新建智能文档 `create_smartcanvas_by_mdx` | `guide/references/smartcanvas.md` |
| 论文、公文、合同等正式 Word | `doc.create_with_markdown`；要标准公文/论文版式时用排版流程 | `guide/references/word.md` |
| 数据表、计算、统计 | `manage.create_file` 建空表，再用 `sheet` 类目写数据 | `guide/references/excel.md` |
| 多视图、结构化记录（类似多维表） | 智能表格 `smartsheet` 类目 | `guide/references/smartsheet.md` |
| 编辑已有幻灯片 | `slide` 类目 | `guide/references/slides.md` |
| 思维导图 / 流程图 | `create_mind_by_markdown` / `create_flowchart_by_mermaid` | `guide/references/files-and-more.md` |
| 收集表、空白文件，或以上方式失败 | `manage.create_file` | `guide/references/files-and-more.md` |
| 找文件、整理文件夹、知识库、改分享 | `manage` 与 `space` 类目 | `guide/references/files-and-more.md` |
| 把电脑上的文件、HTML 页面导入腾讯文档 | `local_files`（`import_file` / `import_html`） | `guide/references/files-and-more.md` |
| 识别图片文字、图片转文档或表格 | 本机图片用 `local_files`（`ocr_*`）；公网图片可直接调 `ocr` 类目 | `guide/references/files-and-more.md` |
| 保存一个网页 | 网页剪藏（`scrape` 类目） | `guide/references/files-and-more.md` |

用户只是贴了一个链接、没说要做什么时，先读内容再问，不要自动剪藏或修改。

## 五、出错时

| 现象 | 处理 |
|---|---|
| `AUTH_REQUIRED`、HTTP 401、错误码 400006 | 登录过期：请用户到 Cindy 侧边栏「插件」→「腾讯文档」详情页重新连接对应版本的账号 |
| `EDITION_REQUIRED` | 问用户要操作个人版还是企业版，再带 `edition` 重试 |
| `INVALID_ARGS` / -32602 / -32603 / 11607 / 400001 | 参数不对：按返回里附带的 schema 修正后重试 |
| 400016 | 文档类型和操作不匹配：先 `manage.query_file_info` 再换对应类型的操作 |
| 个人版 400007 / 400008 | 需要腾讯文档会员 / AI 积分不足：如实告诉用户，可前往 https://docs.qq.com/vip 处理 |
| 企业版 400007 / 400014 | 调用次数用完 / 需要企业专业版：请用户联系企业管理员 |
| 权限不足（insufficient_scope）、`SCOPE_REQUIRED` | 删除、移动、改分享等需要管理权限。个人版会自动改用用户填写的个人 Token 重做一次（没填时 Cindy 会弹安全输入框）；用户不愿提供或企业版时，请用户在腾讯文档网页里手动操作 |
| `TOKEN_INVALID` | 个人 Token 无效或过期：请用户到 https://docs.qq.com/open/auth/mcp.html 重新获取，在插件详情页更新 |
| `RESULT_UNKNOWN` | 写入结果不确定：先查一下文档是否已经改了，确认后再决定是否重做，不要直接重试 |
| `UNKNOWN_TOOL` | 操作名不对或已下线：重新 `list_tools({ category })` 核对 |

确实没有对应能力时，直接告诉用户腾讯文档目前不支持，不要拼凑不存在的操作。

## 六、分类参考

- 智能文档与 MDX 写法：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/smartcanvas.md" })`
- Word 文档（含公文、论文排版流程）：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/word.md" })`
- 在线表格：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/excel.md" })`
- 智能表格：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/smartsheet.md" })`
- 幻灯片：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/slides.md" })`
- 文件、知识库、思维导图、流程图、OCR、剪藏、本机文件导入：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/files-and-more.md" })`
- 企业版差异：`ghost_manual({ ghost_id: "tencent-docs", path: "guide/references/enterprise.md" })`
- 实时操作目录：`ghost_call({ ghost_id: "tencent-docs", tool: "list_tools", args: {} })`
