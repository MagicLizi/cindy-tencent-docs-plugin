# 幻灯片（slide 类目）

`slide` 类目里的操作来自腾讯文档的幻灯片专用服务，名字形如 `slide_xxx`。编辑已有幻灯片一律用这一类，
其它类目的操作不认识幻灯片的页面、形状和母版结构。

## 坐标与编号

- 位置和尺寸单位是**磅（pt）**；页码 `page_index` **从 0 开始**。
- 先用 `slide_get_info` 拿到页数、各页 ID 和页面尺寸，再决定放在哪里。
- 插入形状时**同时设好填充色和边框色**，否则可能看不见或很难看。

## 新建

腾讯文档目前没有"一句话生成整份幻灯片"的公开操作。可行做法：
`manage.create_file` 建一份空幻灯片（`doc_type` 用 schema 允许的幻灯片类型值）→ `slide_add_slides`
批量加页 → 用批量操作填内容。若 `slide_add_page_with_jsx` 可用，也可以用 JSX 一次生成一整页。

## 常用操作

| 目的 | 操作 |
|---|---|
| 读 | `slide_get_info`、`slide_get_page_info`（某页的形状和动画）、`slide_get_shape_info`、`slide_get_text`、`slide_get_table_info`、`slide_get_chart_info`、`slide_get_group_info`、`slide_get_master_info`、`slide_get_themes`、`slide_get_sections`、`slide_get_comments`、`slide_get_notes_text`、`slide_find_text` |
| 页面 | `slide_add_slide`、`slide_add_slides`（多页共用一个版式）、`slide_add_page_with_jsx`、`slide_duplicate_slide`、`slide_move_slide`、`slide_remove_slide`、`slide_set_page_properties`（背景、隐藏）、`slide_set_slide_size` |
| 形状与文字（尽量用批量版） | `slide_add_shapes`、`slide_add_texts`、`slide_add_line_shapes`、`slide_add_image`、`slide_add_table`、`slide_add_chart`、`slide_remove_shapes`、`slide_reorder_shape`、`slide_set_shape_properties` |
| 组合 | `slide_group_shapes`、`slide_ungroup_shapes`、`slide_reorder_shapes_in_group`、`slide_update_group_shape_properties` |
| 文字内容 | `slide_set_text`（整体替换）、`slide_insert_text`、`slide_append_text`、`slide_delete_text`、`slide_set_text_property`（只改样式）、`slide_find_replace_text` |
| 表格 | `slide_set_cell_text`、`slide_insert_table_rows` / `slide_insert_table_cols`、`slide_delete_table_rows` / `slide_delete_table_cols`、`slide_merge_table_cells`、`slide_unmerge_table_cells` |
| 图表 | `slide_change_chart_type`、`slide_update_chart_data`、`slide_update_chart_title`、`slide_update_chart_legend`、`slide_update_chart_axis`（一次一根轴）、`slide_update_chart_gridlines`、`slide_update_chart_data_labels`、`slide_update_chart_series_style` |
| 动画 | 先 `slide_list_anim_types` 查类型，再 `slide_add_anim`、`slide_set_anim_properties`、`slide_set_anim_trigger`、`slide_move_anim`、`slide_remove_anim` |
| 节 | `slide_add_section`、`slide_rename_section`、`slide_move_section`、`slide_remove_sections`（保留页面） |
| 主题字体 | `slide_list_builtin_themes` → `slide_set_theme`；`slide_set_default_font` |
| 页脚页码日期 | `slide_add_footer`、`slide_add_page_number`、`slide_add_datetime` |
| 备注 | `slide_add_notes`、`slide_set_notes_text`、`slide_append_notes_text` |
| 批注 | `slide_add_comment`、`slide_reply_comment`、`slide_modify_comment`、`slide_remove_comment` |
| 设计说明 | `slide_set_design` 把一份设计说明存进文档（保留 24 小时），`slide_get_design` 读回 |

## 注意

- `slide_remove_section_with_slides` 会连节里的页面一起删除且**无法恢复**，删除页面、形状之前都先和用户确认。
- 做一整套幻灯片时：先定主题和版式 → 批量加页 → 每页用批量形状、文字操作一次填完 → 最后统一加页码和动画。
