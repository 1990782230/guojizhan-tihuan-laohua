# 包袋电商图片批处理

## 使用

1. 双击 `start.bat`。
2. 选择本次要执行的独立模式。
3. 选择该模式的输入图片文件夹。
4. 等待当前模式批次完成。

`start.bat` 会启动独立的 `launcher.ps1` 图形窗口，再把所选模式和文件夹传给批处理程序。

## 编辑 Prompt

双击 `编辑Prompt.bat`，直接打开 `prompts` 文件夹。所有Prompt都是UTF-8文本文件，可以用记事本或其他文本编辑器修改：

```text
prompts\01_white.txt
prompts\02_pattern.txt
prompts\03_main.txt
prompts\04_detail_01.txt
prompts\04_detail_02.txt
prompts\04_detail_03.txt
prompts\04_detail_04.txt
prompts\04_detail_05.txt
prompts\05_check.txt
```

程序不会把Prompt写死在代码中，每次启动批处理时都会重新读取这些文件，因此保存修改后直接运行即可生效。

支持产品图格式：PNG、JPG、JPEG、WEBP。程序只扫描所选文件夹的第一层。

## 四个独立模式

三个模式互不串行，每次只执行用户选择的一个步骤。每张输入图片是一个独立任务，最多同时运行5个任务。

```text
模式1：输入产品图 → intermediate\原图名_white.png
模式2：输入待替换图片＋固定元素参考图 → final\原图名_pattern.png
模式3：输入印花成品图 → 03_main.png＋5张详情图并发生成
模式4：输入印花替换成品图＋同名替换前白底图＋固定新元素参考图 → 检测遗漏与错误新增，并定向修复为 checked\原图名_checked.png
```

模式2和模式3既可以读取所选文件夹第一层的普通图片，也可以直接选择此前的日期目录：

```text
模式2会自动查找：intermediate\原图名_white.png
模式3会自动查找：final\原图名_pattern.png
模式4会自动查找：final\原图名_pattern.png
```

印花替换阶段固定按以下顺序向接口发送图片，不需要用户上传参考图：

```text
图1：当前任务的白底包袋图
图2：D:\ai\包包处理\assets\element-reference.png
```

API调用模式：

```text
模式1：Image API / gpt-image-2 / quality=high
模式2：Responses API / gpt-5.6-terra / reasoning=xhigh / image_generation edit high
模式3：Responses API / gpt-5.6-terra / reasoning=xhigh / image_generation edit high
模式4：先用 Responses API / gpt-5.6-terra / reasoning=xhigh 检测，再仅在发现明确遗漏时调用 image_generation edit 修复
```

生图认证配置按顺序复用：

```text
环境变量
C:\Users\当前用户\.img-gen\config.json
D:\ai\中转站\image-gen\config.example.json
```

API调用方式参考 `D:\ai\中转站\image-gen`，默认模型为 `gpt-image-2`，编辑端点为 `/v1/images/edits`。

## 输出结构

```text
所选文件夹\output\YYYY-MM-DD\
├─ intermediate\
│  ├─ 商品A_white.png
│  └─ 商品B_white.png
├─ final\
│  ├─ 商品A_pattern.png
│  └─ 商品B_pattern.png
├─ checked\
│  ├─ 商品A_checked.png
│  ├─ 商品B_checked.png
│  └─ reports\
│     └─ 每张图片的检测结果和定向修复Prompt.json
├─ failed\
│  └─ 失败任务的输入原图
├─ 商品A\
│  └─ final\
│     ├─ 03_main.png
│     ├─ 04_detail_01.png
│     ├─ 04_detail_02.png
│     ├─ 04_detail_03.png
│     ├─ 04_detail_04.png
│     └─ 04_detail_05.png
└─ 商品B\
   └─ final\
      └─ 同上6张图片
```

白底图和印花替换图按批次集中保存，不再为每张图片创建独立文件夹。只有一次生成6张图片的模式3按初始图片名称建立任务文件夹。任意模式中处理失败的任务，会把该任务的输入原图复制到当前日期批次下的 `failed` 文件夹，方便后续单独重跑。

模式4会自动读取同一日期目录中的前后图做逐槽位对比。它兼容三种前图命名：`intermediate\原图名_white.png`、`intermediate\原图名.png/jpg/jpeg/webp`，或日期根目录中的 `原图名.png/jpg/jpeg/webp`；并与 `final\原图名_pattern.png` 自动配对。请选择该日期文件夹，或其中的 `final` 文件夹。它同时检查两类问题：旧纹样遗漏替换，以及图2中被错误新增到图1原本没有纹样的位置的新元素。文字检测规则为 LOUIS VUITTON → ARRE LUXURY、PAIRS → CHINA。检测没有发现明确问题时，程序直接复制原印花成品图到 `checked`，不会额外调用生图接口。检测和修复规则可在 `prompts\05_check.txt` 中编辑。

日期按照台北时区在批次启动时确定。

## 命令行

```powershell
node run.mjs --mode white --input "D:\产品图"
node run.mjs --mode pattern --input "D:\产品图"
node run.mjs --mode gallery --input "D:\产品图"
node run.mjs --mode check --input "D:\产品图"
```

仅检查任务和目录，不调用接口：

```powershell
node run.mjs --mode pattern --input "D:\产品图" --dry-run
```

单独执行一次图片编辑：

```powershell
node edit.mjs --prompt-file prompts\01_white.txt --image input.png --out output.png
```
