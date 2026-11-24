# 企业版（saas.docs.qq.com）与个人版的差异

企业版的 Word、表格、幻灯片专用服务和个人版一样，智能文档、智能表格和 MDX 写法也相同。差异主要在主服务：

## 名字不同的操作

| 个人版 | 企业版 |
|---|---|
| `get_content` | `manage.get_content` |
| `upload_image` | `manage.upload_image` |
| `scrape_url` / `scrape_progress` | `manage.scrape_url` / `manage.scrape_progress` |
| `create_flowchart_by_mermaid` | `flowchart.create_by_mermaid`（以目录为准） |

## 企业版独有

- `manage.list_file`：按类别列出我的文档、最近、收藏、回收站、共享等。
- `manage.ai_search_file`：用自然语言搜索文件。
- `manage.batch_query_permission`：批量查权限。
- `manage.apply_download`：拿临时下载链接，相当于导出。
- 导入与任务：`manage.apply_upload` → 上传 → `manage.complete_upload` → `manage.query_task`。
  `local_files` 的 `import_file` 会按这条流程自动完成。

## 企业版没有

- 图片文字识别（OCR）和 HTML 页面导入。
- Word 专业排版流程（`doc.ai_format_pure_text`）。
- 个人版的最近文件、文件夹浏览、移进知识库、`pre_import` 导入和 `export_file` 导出等操作（以目录为准）。

## 权限与额度

- `manage.get_privilege` / `manage.set_privilege` 只能按文件操作。
- 错误码 400007 在企业版表示调用次数用完，400014 表示需要企业专业版；遇到时请用户联系企业管理员。

企业版目录以 `list_tools({ edition: "enterprise" })` 的实时结果为准。
