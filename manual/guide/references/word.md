# Word 类在线文档（doc 类目）

`doc` 类目里的操作来自腾讯文档的 Word 专用服务，插件把它们统一显示为 `doc.操作名`。
参数名以 `list_tools({ category: "doc" })` 为准（位置参数在不同操作里可能叫 `idx` 或 `index`）。

## 新建

- 一步建好带内容的文档：`doc.create_with_markdown`（`title` + `markdown`）。
- 先建空文档再写：`manage.create_file`（`doc_type` 用 schema 允许的 Word 类型值）→ `doc.insert_markdown`。
- 标准公文、合同、论文、作文版式：见下文"专业排版流程"（仅个人版）。

## 编辑的基本套路

1. 拿 `file_id`，必要时 `manage.query_file_info` 确认是 Word 类文档。
2. 了解结构：`doc.get_outline`（标题树）、`doc.resolve_document_structure`（结构树）、`doc.find`（按文字找位置）。
   往末尾追加时先用 `doc.get_last_operable_pos` 拿最后一个可写位置。
3. **写大段内容一次用 `doc.insert_markdown` 插入**，再用细粒度操作微调；不要反复调用逐段插入，
   往返多还容易冲突。
4. 改完可用 `get_content` 读回核对。

## 常用操作速查

| 目的 | 操作 |
|---|---|
| 插入富内容 | `doc.insert_markdown`、`doc.insert_html_content` |
| 插入文字 / 段落 | `doc.insert_text`；`doc.insert_paragraph_with_text`（`doc.insert_paragraph` 只插一个空段落分隔） |
| 表格 | `doc.insert_table`（需要行数列数）、`doc.insert_rows` / `doc.insert_cols`、`doc.set_table_layout`、`doc.set_table_properties`、`doc.delete_table`、`doc.get_table_info` |
| 图片与附件 | `doc.insert_image`、`doc.replace_image`、`doc.get_images`；附件先 `doc.pre_insert_attachment` 再 `doc.insert_attachment` |
| 其它元素 | `doc.insert_code_block`、`doc.insert_math`（LaTeX）、`doc.insert_normal_link`、`doc.insert_numbering`、`doc.insert_task`、`doc.insert_page_break`、`doc.insert_border`、`doc.insert_footnote` |
| 页眉页脚页码 | `doc.insert_header`、`doc.insert_footer`、`doc.set_page_number` |
| 替换文字 | `doc.replace_text`（指定范围）、`doc.find_and_replace`（全部匹配） |
| 格式 | `doc.modify_paragraph`、`doc.update_text_property`（只改样式）、`doc.copy_format`（格式刷）、`doc.get_paragraph_property`、`doc.get_text_property` |
| 批注与修订 | `doc.insert_comment`、`doc.get_comments`、`doc.accept_all_revisions` |
| 比较 | `doc.compare_documents` |
| 书签 | `doc.replace_bookmarks` |

实际可用的操作以目录为准，上表只是常用部分。

## 专业排版流程（仅个人版）

用户给一段纯文本，要排成规范的公文、合同、论文、作文或通用文档时使用。最后一步调用主服务的
`doc.ai_format_pure_text`（它不在 Word 专用服务里，目录中可能带 `forwarded` 标记，这里照用）。

1. **判断场景、起标题**：`scenario` 只能是 `paper`（论文）、`contract`（合同）、`essay`（作文）、
   `government`（公文）、`general`（通用）之一；文字太短或看不出类型时用 `general`。
   `title` 2–25 个字，不带特殊符号或表情。
2. **整理样式（可选，只有用户提出样式要求时才做）**：生成一个数组，每项针对一个结构名，可含
   - `structureName`：该场景里的结构名（见下表的叶子结构）；
   - `fontSize`：磅值。中文字号对照：初号 42、小初 36、一号 26、小一 24、二号 22、小二 18、三号 16、
     小三 15、四号 14、小四 12、五号 10.5、小五 9；
   - `fontFamily`：字体名；
   - `fontColor`：只能是 `FFFFFF` 白、`000000` 黑、`AE2E19` 红、`F4C243` 橙、`FEFB54` 黄、`53AD5B` 绿、
     `326FBA` 蓝、`0A205C` 紫，不在其中就不写；
   - `alignment`：1 左、2 居中、3 右、4 两端、6 分散；
   - `lineSpacing`：1、1.5、2 或 3。
   用户没提的字段不要写（也不要写 null）。
3. **把原文转成 XML**：根节点 `<root>`，按场景结构把原文逐段放进对应标签，保留原文和顺序；
   缺少必需部分时补上合理内容；不要生成空标签。
4. **调用** `doc.ai_format_pure_text`：`title`、`xml`、`scenario`，有样式时再加 `customStyles`
   （**把第 2 步的数组转成 JSON 字符串**再传）。结果里有在线文档链接。

各场景的结构名：

| 场景 | 结构 |
|---|---|
| `general` | `Title`、`Subtitle`、`Heading1`–`Heading9`、`Text`（都可选） |
| `essay` | `Title`（必需）、`Text` |
| `contract` | `Title`、`EmphasizedTitle`（最高一级条款标题）、`Text`（都必需） |
| `government` | `Content` 容器，内含 `Title`、`Addressee`（主送机关）、`SignOff`（落款单位）三项必需，`Text`、`Heading2` 可选 |
| `paper` | 必需：`Abstract`（`AbstractTitle`、`AbstractContent`、`Keywords`）、`Reference`（`ReferenceTitle`、`ReferenceContent`）；可选：`EnAbstract`（`EnAbstractTitle`、`EnAbstractContent`、`EnKeywords`）、`Toc`（`TocTitle`）、`Content`（`Heading1`–`Heading9`、`Text`）、`Acknowledgement`（`AcknowledgementTitle`、`AcknowledgementContent`） |

论文里的"摘要""参考文献""致谢"等标题要用标准写法，关键词一行以"关键词："开头。
JSON 字符串里的双引号要转义。
