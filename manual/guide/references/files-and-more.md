# 文件、知识库、思维导图、流程图、OCR、剪藏与本机文件导入

## 文件（manage 类目）

| 目的 | 操作 | 说明 |
|---|---|---|
| 搜索 | `manage.search_file` | 按关键字 |
| 最近文件 | `manage.recent_online_file` | 支持分页 |
| 浏览文件夹 | `manage.folder_list`、`manage.query_folder_meta` | |
| 文档信息与类型 | `manage.query_file_info` | 判断用哪一类操作前先查它 |
| 新建 | `manage.create_file` | `title` + `doc_type`；带 `space_id` 和 `parent_id` 可直接建在知识库的某个目录下。也是收集表和"其它方式都失败时"的建法 |
| 改名、复制 | `manage.rename_file_title`、`manage.copy_file` | |
| 移动 | `manage.move_file`（移到文件夹）、`manage.move_file_to_space`（移进知识库） | |
| 删除 | `manage.delete_file` | 进回收站；先和用户确认 |
| 分享权限 | `manage.get_privilege`、`manage.set_privilege` | 扩大分享范围前先确认 |
| 导出 | `manage.export_file` → `manage.export_progress` | 异步，按任务 ID 查进度 |
| 读全文 | `get_content` | 只用于阅读、总结 |

`doc_type` 的可选值不同操作可能不一样，按 schema 里的枚举或说明填写。

## 知识库空间（space 类目）

- `query_space_list`：列出空间。`num` 页码从 0 开始（每页最多 100），`order_by` 1 最近浏览 / 2 最近编辑 / 3 创建时间，
  `query_by` 0 全部 / 1 我创建的 / 2 我加入的。看 `has_next` 决定要不要翻页。
- `create_space`：`title` 必填，返回 `space_id`。
- `query_space_node`：`space_id` 必填；`parent_id` 不传就是根目录；每页 20 个节点，`num` 从 0 开始。
- `create_space_node`：`space_id`、`title`、`node_type` 必填。`node_type` 取 `wiki_folder`（文件夹）、`wiki_tdoc`（在线文档）、`link`（链接），
  并配上对应的 `wiki_folder_node` / `wiki_tdoc_node` / `link_node` 对象。父节点参数在这里叫 `parent_node_id`（查询时叫 `parent_id`）。
  返回结果里在线文档的类型显示为 `wiki_file`。
- `delete_space_node`：`remove_type` 默认 `current`（只删本节点，子节点上移）；`all` 会**连同所有子节点一起删除**，必须先确认。
- 节点的 `node_id` 就是 `file_id`，可以直接拿去读写内容。

常见流程：把文档放进某个知识库目录 → `query_space_list` 找空间 → `query_space_node` 逐层找到目录 →
`create_space_node` 新建，或 `manage.create_file` 带 `space_id` + `parent_id`；已存在的文档用 `manage.move_file_to_space`。

## 思维导图与流程图

- `create_mind_by_markdown`：`title` + `markdown`。用标题层级和嵌套列表（每级缩进 4 格）表示树形结构。
- `create_flowchart_by_mermaid`：`title` + `mermaid`（例如 `graph TD` 开头的 Mermaid 文本）。
- 两者都可选 `parent_id` 指定文件夹，返回 `file_id` 和链接。

## 图片文字识别（OCR，个人版）

- 本机图片：用 `local_files`，`action` 取 `ocr_extract`（识别一张）、`ocr_to_word` / `ocr_to_excel`（1–9 张转成文档或表格，`paths` 按页面顺序）。
  支持 PNG、JPG、JPEG、BMP、WEBP，单张不超过 10MB，总共不超过 50MB。**不要自己把图片转成 base64 塞进参数。**
- 公网图片：可以直接 `call_tool` 调 `ocr.extract` / `ocr.toword` / `ocr.toexcel`，传 `image_url`（后端要能直接下载，内网或需要登录的链接不行）。
  `image_url` 和 `image_base64` 只能二选一。下载失败时把图片存到本机再走 `local_files`。
- `ocr_extract` 的 `extract_type`：`basic` 通用、`accurate` 小字或模糊图、`efficient` 快速；`with_positions` 要位置信息时开。
- 只有一张图时识别会做校正增强，效果最好；对质量要求高时不要把多张凑一起。识别比较慢，不要重复触发。
- 把识别结果写回已有文档：智能文档用 `smartcanvas.edit`，Word 用 `doc.insert_markdown`，在线表格用 `sheet.set_range_value`，智能表格用 `smartsheet.add_records`。

## 网页剪藏

- 个人版：`scrape_url` 发起 → `scrape_progress` 查进度，完成后会自动生成一篇文档。企业版对应 `manage.scrape_url` / `manage.scrape_progress`。
- 只在用户明确说要保存、剪藏网页时使用；用户只是贴个链接聊天时不要自动剪藏。

## 本机文件导入（local_files）

- 普通文件：`action: "import_file"`，`path` 填完整路径。会原样上传并由腾讯文档转换，保留原有格式，
  不要改成"读出内容再新建一篇"。适合 Word、Excel、PPT、PDF、Markdown 等腾讯文档能导入的格式。
- 网页：`action: "import_html"`（个人版），`path` 填 HTML 文件（同目录下的 `assets/` 会一起打包）或 HTML 所在目录
  （目录里要有 `index.html` 或唯一一个 `.html`）。插件会按腾讯文档要求的格式自动打包，不需要自己压缩。
- 结果 `status`：`done` 表示完成，结果里有文档链接；`pending` 表示还在导入，按 `next` 的提示继续查进度；
  失败时把错误和 `trace_id` 告诉用户。
- 上传图片拿图片 ID（智能文档头图、智能表格图片字段等）：`action: "upload_image"`。图片 ID 一天内有效。
- `local_files` 会读取用户电脑上的这些文件并上传到腾讯文档，只在用户要求处理这些文件时调用。
