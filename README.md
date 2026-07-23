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
prompts\06_lv_detect.txt
```

程序不会把Prompt写死在代码中，每次启动批处理时都会重新读取这些文件，因此保存修改后直接运行即可生效。

支持产品图格式：PNG、JPG、JPEG、WEBP。程序只扫描所选文件夹的第一层。

## 六个处理模式

模式1至模式5互不串行，每次只执行用户选择的一个步骤；模式6按照固定顺序自动完成三个阶段。每张输入图片是一个独立任务，最多同时运行5个任务。

```text
模式1：输入产品图 → intermediate\原图名_white.png
模式2：输入待替换图片＋固定元素参考图＋固定背景参考图 → 完成纹样替换、背景融合和产品居中，输出 final\原图名_pattern.png
模式3：输入印花成品图 → 03_main.png＋5张详情图并发生成
模式4：输入印花替换成品图＋固定新元素参考图 → 检测不属于元素参考图的旧纹样，并定向修复为 checked\原图名_checked.png
模式5：输入待检测图片 → 检测LV相关内容；命中图片从原目录移动到 lv_detected
模式6：输入原始产品图 → 纹样替换与背景融合 → 检测修复 → LV信息纯检测分类
```

模式2和模式3既可以读取所选文件夹第一层的普通图片，也可以直接选择此前的日期目录：

```text
模式2会自动查找：intermediate\原图名_white.png
模式3会自动查找：final\原图名_pattern.png
模式4会自动查找：final\原图名_pattern.png
```

印花替换阶段固定按以下顺序向接口发送图片，不需要用户上传参考图或背景图：

```text
图1：当前任务的白底包袋图
图2：D:\ai\包包处理\assets\element-reference.png
图3：D:\ai\包包处理\assets\微信图片_20260723193827_1219_10.png
```

API调用模式：

```text
模式1：Image API / gpt-image-2 / quality=high
模式2：Responses API / gpt-5.6-terra / reasoning=xhigh / image_generation edit high
模式3：Responses API / gpt-5.6-terra / reasoning=xhigh / image_generation edit high
模式4：先用 Responses API / gpt-5.6-terra / reasoning=xhigh 检测，再仅在发现明确遗漏时调用 image_generation edit 修复
模式5：Responses API / gpt-5.6-terra / reasoning=xhigh，仅返回检测分类JSON，不调用生图工具
模式6：依次复用模式2、模式4和模式5的模型、Prompt与最高推理参数
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
├─ lv_detected\
│  └─ 检测到LV相关内容后从输入目录移入的原图
├─ lv_detection_reports\
│  └─ 每张图片的JSON检测报告
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

自动模式统一目录：

auto\
├─ intermediate\
│  ├─ 01_pattern\
│  └─ 02_repaired\
├─ final\
│  ├─ passed\
│  ├─ lv_detected\
│  └─ uncertain\
├─ reports\
│  ├─ check\
│  └─ lv\
└─ failed\
   ├─ 01_pattern\
   ├─ 02_repair\
   ├─ 03_lv_detection\
   └─ unknown\
```

白底图和印花替换图按批次集中保存，不再为每张图片创建独立文件夹。只有一次生成6张图片的模式3按初始图片名称建立任务文件夹。任意模式中处理失败的任务，会把该任务的输入原图复制到当前日期批次下的 `failed` 文件夹，方便后续单独重跑。

模式4只对照印花成品图与固定元素参考图，不再读取或修改替换前图。检测模型只判断残留的对象类型，不生成坐标或矩形编辑范围。发现残留后，程序会复用模式2的完整 `02_pattern.txt` 高质量纹样替换 Prompt，并同时发送固定背景参考图，再通过 `gpt-5.6-terra / xhigh / image_generation edit` 让修复模型重新进行对象级视觉识别和补修；已经属于元素参考图的纹样、固定背景和居中构图全部锁定保留。选择日期文件夹时程序自动读取其中 `final\原图名_pattern.png`；也可直接选择 `final` 文件夹。文字检测规则为 LOUIS VUITTON → ARRE LUXURY、PAIRS → CHINA、MAISON FONDÉE EN 1854 → ESTABLISHED IN 2005、ARTICLES DE VOYAGE → TRAVEL COLLECTION。检测没有发现明确问题时，程序直接复制原印花成品图到 `checked`，不会额外调用生图接口。检测规则可在 `prompts\05_check.txt` 中编辑，实际修复同时复用 `prompts\02_pattern.txt`。

模式5只扫描所选文件夹第一层。检测结果为 `detected` 时，原图会移动到当前日期批次的 `lv_detected`；`not_detected` 和 `uncertain` 均保留在原目录。请求失败时原图不移动，并按通用失败规则保存副本。检测Prompt可在 `prompts\06_lv_detect.txt` 中编辑。

模式6只需选择一次原始图片文件夹。每个图片任务内部按“纹样替换与固定背景融合 → 复检与必要补修 → LV信息纯检测”的顺序执行，不同图片任务之间最多5并发。原始输入文件不移动；所有中间图、最终分类图、检测报告和失败副本统一保存在 `output\YYYY-MM-DD\auto`。最终只需查看 `auto\final`：`passed` 为检测通过，`lv_detected` 为明确检测到相关内容，`uncertain` 为证据不足。

日期按照台北时区在批次启动时确定。

## 命令行

```powershell
node run.mjs --mode white --input "D:\产品图"
node run.mjs --mode pattern --input "D:\产品图"
node run.mjs --mode gallery --input "D:\产品图"
node run.mjs --mode check --input "D:\产品图"
node run.mjs --mode lvcheck --input "D:\产品图"
node run.mjs --mode auto --input "D:\产品图"
```

仅检查任务和目录，不调用接口：

```powershell
node run.mjs --mode pattern --input "D:\产品图" --dry-run
```

单独执行一次图片编辑：

```powershell
node edit.mjs --prompt-file prompts\01_white.txt --image input.png --out output.png
```
