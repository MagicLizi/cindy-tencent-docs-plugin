# 智能文档（smartcanvas）与 MDX 写法

智能文档是腾讯文档里排版最灵活的在线文档，适合报告、笔记、纪要、方案、攻略等。内容用一种受限的 MDX 描述：
Markdown 加上一组固定组件。**写法采用白名单：下面没列出的语法、组件、属性和取值都不要用。**

## 操作

| 目的 | 操作 | 要点 |
|---|---|---|
| 新建 | `create_smartcanvas_by_mdx` | 参数 `title` 与 `mdx`。不能指定文件夹；要放进某个文件夹或知识库，建好后再移动 |
| 看结构 | `smartcanvas.get_top_level_pages` | 列出顶层页面 |
| 通读 | `smartcanvas.read` | 分页读某个页面的 MDX |
| 找位置 | `smartcanvas.find` | 按文字找块，返回块 ID 和它的 MDX |
| 修改 | `smartcanvas.edit` | 先用 `read` 或 `find` 拿到块 ID 再改；可用动作以 schema 为准（例如在某块之后插入） |

头图做法：准备一张图片 → `local_files`（`action: "upload_image"`）或公网图片走 `upload_image` 拿到图片 ID →
填进 frontmatter 的 `cover`。

## 文件开头：frontmatter

- 必须是 `mdx` 的第一行内容，前面连空行都不能有；用 `---` 包起来。
- `title` 必填且不能为空，和工具参数 `title` 保持一致。
- 只允许这 6 个字段：

| 字段 | 取值 | 建议 |
|---|---|---|
| `title` | 文字 | 必填 |
| `cover` | 图片 ID（`upload_image` 的返回） | 内容适合时加 |
| `icon` | 恰好一个 emoji | 可选 |
| `fontFamily` | `simsun` 宋体 / `kaiti` 楷体 / `default` | 没有要求就不写 |
| `fontSize` | `small` / `default` / `large` | 没有要求就不写 |
| `spacing` | `compact` / `default` / `loose` | 没有要求就不写 |

正文第一行不要再写一个和标题相同的一级标题；正文的一级标题只用来分大章节。

## 基本规则

- **能用 Markdown 就用 Markdown**：段落、`#` 标题、列表、`>` 引用、`---` 分隔线、`$...$` / `$$...$$` 公式都直接写。
  只有需要属性（对齐、底色）或 Markdown 表达不了（表格、图片、分栏、高亮块）时才用组件。
- **加粗、斜体、颜色等文字样式只能用 `<Mark>`**，不要用 `**`、`*`、`~~`、`__`。
- **表格只能用 `Table` 组件**，不要用 `|` 管道表格；**图片只能用 `Image` 组件**，不要用 `![]()`。
- **不能有任何花括号表达式**（例如 `level={1}`），不能有 `import` / `export`，不能自造组件。
- **属性值一律双引号**：`level="2"`，不是 `level=2` 或 `level='2'`。
- **布尔属性只写名字**：`<Mark bold>`、`<Todo checked>`；不写 `="true"`，更不能写 `="false"`（不需要就不写这个属性）。
- **颜色只能用下面的颜色名**，不能用 `#ff0000`、`rgb()`。
- **缩进 4 个空格，不用 Tab**。子块比父块多缩进 4 格，同级块缩进相同。
- **块级组件写成三段**：开标签一行，内容另起一行（多缩进 4 格），闭标签再一行。哪怕内容很短也不要写在同一行。
- **`<Mark>` 和 `<Link>` 写在同一行里**，和前后文字连成一行，句子中间不要换行（会变成软换行）。

示例：

```
---
title: 项目周报
icon: 📊
---

本周进展概览。

<Callout blockColor="light_blue" borderColor="blue" icon="💡">
    重点：<Mark bold color="red">发布延期一天</Mark>，原因见下文。
</Callout>

<Table>
    <TableRow>
        <TableCell>
            模块
        </TableCell>
        <TableCell>
            状态
        </TableCell>
    </TableRow>
    <TableRow>
        <TableCell>
            登录
        </TableCell>
        <TableCell>
            <Mark color="green">已完成</Mark>
        </TableCell>
    </TableRow>
</Table>
```

## 块级组件

| 组件 | 属性 | 里面可以放 | 说明 |
|---|---|---|---|
| `Paragraph` | `textAlign`（`left`/`center`/`right`），`blockColor` | 文字、`Mark`、`Link` | 只在要对齐或底色时用；普通段落直接写文字 |
| `Heading` | `level` 必填（`"1"`–`"6"`），`textAlign`，`blockColor` | 文字、`Mark`、`Link` | 只要级别时用 `#`；要对齐或底色才用组件 |
| `BlockQuote` | `textAlign`，`blockColor` | 任意块，可嵌套 | 单段无属性的引用用 `>` |
| `Callout` | `blockColor` 必填，`borderColor` 必填，`icon`（一个 emoji） | 任意块 | 高亮提示块；底色和边框一般选同一色系 |
| `ColumnList` | 无 | 只能放 `Column`（至少一个） | 分栏容器 |
| `Column` | `width`（百分比，如 `"50%"`） | 任意块 | 只能在 `ColumnList` 里；建议每栏都写宽度 |
| `Divider` | `blockColor`（分隔线颜色） | 无，自闭合 `<Divider />` | 不要颜色时用 `---` |
| `Image` | `src` 必填，`alt`，`align`（默认居中），`width` / `height`（像素数字字符串） | 无，自闭合 | 知道比例时宽高都写，否则只写宽度 |
| `Todo` | `checked`（布尔），`blockColor` | 先写本项文字，之后可放子块 | 一个 `Todo` 是一项，连续几个组成清单 |
| `BulletedList` / `NumberedList` | `blockColor` | 先写本项文字，之后可放子块 | **一个元素只写一项**，多项写多个相邻元素；子列表放在本项文字之后 |
| `Table` | 无 | 只能放 `TableRow` | 不支持表头、合并单元格属性 |
| `TableRow` | 无 | 只能放 `TableCell` | |
| `TableCell` | 无 | 除表格以外的任意块 | 不能嵌套表格 |
| `MathBlock` | `width`（像素） | 一个 `$$...$$` 公式 | 不需要宽度时直接写 `$$...$$` |

代码块、视频、附件、提及、嵌入等不在白名单里，不要写成组件。

## 行内组件

| 组件 | 属性 | 说明 |
|---|---|---|
| `Mark` | `bold`、`italic`、`underline`、`strike`（布尔）；`color`；`backgroundColor` | 只包纯文字；开闭标签和文字同一行 |
| `Link` | `href` 必填 | 只包纯文字；同一行写完 |

## 颜色名

| 用在哪里 | 可用颜色 |
|---|---|
| `blockColor`（除 `Divider`）、`Mark` 的 `backgroundColor` | `default` `grey` `light_grey` `dark` `light_blue` `blue` `light_sky_blue` `sky_blue` `light_green` `green` `light_yellow` `yellow` `light_orange` `orange` `light_red` `red` `light_rose_red` `rose_red` `light_purple` `purple` |
| `Callout` 的 `borderColor` | `default` `grey` `blue` `sky_blue` `green` `yellow` `orange` `red` `rose_red` `purple` |
| `Divider` 的 `blockColor` | `default` `black` `light_grey` `grey` `light_blue` `blue` `light_sky_blue` `sky_blue` `light_green` `green` `light_yellow` `yellow` `light_orange` `orange` `light_red` `red` `light_rose_red` `rose_red` `light_purple` `purple` |
| `Mark` 的 `color` | `default` `grey` `blue` `sky_blue` `green` `yellow` `orange` `red` `rose_red` `purple` |

注意：边框色没有 `light_*`；分隔线的深色叫 `black`，其它地方叫 `dark`。

## 写作建议

- 报告类：开头一段摘要，用 `Callout` 标出结论，数据用 `Table`，章节用 `##`。
- 对比类：`ColumnList` 分两到三栏，每栏放一个 `Callout` 或列表。
- 计划、清单类：用 `Todo` 列表，已完成的加 `checked`。
- 不确定某种写法是否被接受时，退回最朴素的 Markdown；建完后用 `smartcanvas.read` 读回来检查渲染结果。
