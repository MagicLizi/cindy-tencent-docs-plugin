# 智能表格（smartsheet 类目）

智能表格是带字段类型、多视图的结构化表（类似多维表格），和 Excel 式的在线表格不是一类。

## 基本顺序

1. 拿到 `file_id` 后先调 `smartsheet.list_tables`，得到工作表的 `sheet_id`。之后的操作都要同时带 `file_id` 和 `sheet_id`。
2. 写之前先 `smartsheet.list_fields` 看清字段名和类型，按字段类型准备值。
3. 字段、记录、视图的增删改都是批量操作，一次可以处理多条，不要逐条循环：

| 对象 | 操作 |
|---|---|
| 工作表 | `smartsheet.add_table`、`smartsheet.delete_table` |
| 字段 | `smartsheet.list_fields`、`smartsheet.add_fields`、`smartsheet.update_fields`、`smartsheet.delete_fields`（字段类型变更另有专门操作，以目录为准） |
| 记录 | `smartsheet.list_records`（分页读取）、`smartsheet.add_records`、`smartsheet.update_records`、`smartsheet.delete_records` |
| 视图 | `smartsheet.list_views`、`smartsheet.add_view`、`smartsheet.update_view`、`smartsheet.delete_view` |

4. 图片字段的值用上传图片得到的图片 ID：本机图片用 `local_files`（`action: "upload_image"`）。

## 注意

- 字段类型、记录值的具体格式、视图类型以 `list_tools({ category: "smartsheet" })` 返回的 schema 为准。
- 删除字段、记录、视图或工作表前先和用户确认。
- 插件已隐藏腾讯文档 App 内部使用的提交和抓取操作，以及需要腾讯文档界面的展示操作；目录里看不到它们是正常的。
