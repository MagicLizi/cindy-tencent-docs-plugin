# 在线表格（sheet 类目，Excel 类）

`sheet` 类目里的操作来自腾讯文档的表格专用服务，插件统一显示为 `sheet.操作名`。

## 新建并写数据

1. `manage.create_file` 建空表（`doc_type` 用 schema 允许的表格类型值），拿到 `file_id`。
2. 新表默认有一个子表；需要更多用 `sheet.add_sheet`。之后每个操作都用 `sheet_id` 指定子表
   （`sheet.get_sheet_info` 可以查到）。
3. 写数据优先批量：`sheet.set_range_value`（一次写一片区域）或 `sheet.set_range_value_by_csv`（整段 CSV 灌入）。
   `sheet.set_cell_value` 只适合改个别单元格（行列从 0 开始计）。

## 读

- 数据：`sheet.get_cell_data`（可以要 CSV 或结构化结果）；按文字找单元格：`sheet.find`。
- 结构与样式：`sheet.get_sheet_info`、`sheet.get_cell_style`、`sheet.get_merged_cells`、
  `sheet.get_dimension_size`（行高列宽，像素）、`sheet.get_sheet_object_list`、`sheet.get_charts`。
- 只是想看全文时，`get_content` 更省事。

## 改结构与样式

| 目的 | 操作 |
|---|---|
| 行列增删移动 | `sheet.insert_dimension`、`sheet.delete_dimension`、`sheet.move_dimension` |
| 插入/删除单元格并挪动周围 | `sheet.insert_range`、`sheet.delete_range` |
| 行高列宽 | `sheet.set_dimension_size` |
| 合并 | `sheet.merge_cell`、`sheet.unmerge_cell` |
| 冻结 | `sheet.set_freeze`、`sheet.unset_freeze` |
| 子表 | `sheet.add_sheet`、`sheet.delete_sheet`、`sheet.rename_sheet`、`sheet.move_sheet` |
| 样式与边框 | `sheet.set_cell_style`、`sheet.set_border`、`sheet.clear_border` |
| 清除 | `sheet.clear_range_cells`（只清内容）、`sheet.clear_range_style`（只清样式）、`sheet.clear_range_all`（都清） |
| 链接 | `sheet.set_link`、`sheet.clear_link` |
| 筛选排序 | `sheet.set_filter`、`sheet.update_filter`、`sheet.remove_filter`、`sheet.sort_range` |
| 图表 | `sheet.add_chart`、`sheet.update_chart`、`sheet.delete_chart` |
| 透视表 | `sheet.add_pivot_table`、`sheet.update_pivot_table`、`sheet.get_pivot_table_detail`、`sheet.remove_pivot_table` |
| 图片 | `sheet.insert_image`（按单元格行列定位） |

`sheet.validate_file_data` 只用于排查数据问题，平时不用。

## 小贴士

- 清空或删除大片区域、删子表之前先和用户确认范围。
- 做汇总表时：先写原始数据，再加透视表或图表，最后设置冻结首行、列宽和样式。
- 把识别出的图片文字写进表格：整理成二维数据后用 `sheet.set_range_value` 一次写入。
