#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editImage } from './lib/image-api.mjs';
import { reasonedAnalyzeImages, reasonedEditImage } from './lib/reasoned-image-api.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MODES = {
  white: '白底图',
  pattern: '印花替换',
  gallery: '电商主图与详情图',
  check: '印花复检修复',
  lvcheck: 'LV信息检测分类',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) throw new Error(`无法识别的参数：${value}`);
    const key = value.slice(2);
    if (key === 'help' || key === 'dry-run') {
      args[key] = true;
      continue;
    }
    const next = argv[++i];
    if (next === undefined) throw new Error(`参数 --${key} 缺少值`);
    args[key] = next;
  }
  return args;
}

const HELP = `包袋电商图片批处理程序

双击 start.bat，依次选择处理模式和图片文件夹。

命令行：
  node run.mjs --mode white --input "D:\\产品图"
  node run.mjs --mode pattern --input "D:\\产品图"
  node run.mjs --mode gallery --input "D:\\产品图"
  node run.mjs --mode check --input "D:\\产品图"
  node run.mjs --mode lvcheck --input "D:\\产品图"

可选参数：
  --mode <mode>          white | pattern | gallery | check | lvcheck
  --input <folder>       直接指定输入文件夹
  --output <folder>      自定义输出根目录
  --dry-run              仅检查任务和目录，不调用生图接口
  --help                 显示帮助
`;

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function runPowerShell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || '选择窗口启动失败');
  return result.stdout.trim();
}

function pickMode() {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$script:choice = ""',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "选择处理模式"',
    '$form.StartPosition = "CenterScreen"',
    '$form.Size = New-Object System.Drawing.Size(430,350)',
    '$form.FormBorderStyle = "FixedDialog"',
    '$form.MaximizeBox = $false',
    '$form.MinimizeBox = $false',
    '$form.TopMost = $true',
    '$label = New-Object System.Windows.Forms.Label',
    '$label.Text = "本次只执行一个独立步骤："',
    '$label.AutoSize = $true',
    '$label.Location = New-Object System.Drawing.Point(28,22)',
    '$form.Controls.Add($label)',
    '$b1 = New-Object System.Windows.Forms.Button',
    '$b1.Text = "1. 生成白底图"',
    '$b1.Size = New-Object System.Drawing.Size(350,38)',
    '$b1.Location = New-Object System.Drawing.Point(28,55)',
    '$b1.Add_Click({ $script:choice = "white"; $form.Close() })',
    '$form.Controls.Add($b1)',
    '$b2 = New-Object System.Windows.Forms.Button',
    '$b2.Text = "2. 印花图案替换"',
    '$b2.Size = New-Object System.Drawing.Size(350,38)',
    '$b2.Location = New-Object System.Drawing.Point(28,103)',
    '$b2.Add_Click({ $script:choice = "pattern"; $form.Close() })',
    '$form.Controls.Add($b2)',
    '$b3 = New-Object System.Windows.Forms.Button',
    '$b3.Text = "3. 生成主图和5张详情图"',
    '$b3.Size = New-Object System.Drawing.Size(350,38)',
    '$b3.Location = New-Object System.Drawing.Point(28,151)',
    '$b3.Add_Click({ $script:choice = "gallery"; $form.Close() })',
    '$form.Controls.Add($b3)',
    '$b4 = New-Object System.Windows.Forms.Button',
    '$b4.Text = "4. 印花复检并修复遗漏"',
    '$b4.Size = New-Object System.Drawing.Size(350,38)',
    '$b4.Location = New-Object System.Drawing.Point(28,199)',
    '$b4.Add_Click({ $script:choice = "check"; $form.Close() })',
    '$form.Controls.Add($b4)',
    '$b5 = New-Object System.Windows.Forms.Button',
    '$b5.Text = "5. 检测并移出LV相关图片"',
    '$b5.Size = New-Object System.Drawing.Size(350,38)',
    '$b5.Location = New-Object System.Drawing.Point(28,247)',
    '$b5.Add_Click({ $script:choice = "lvcheck"; $form.Close() })',
    '$form.Controls.Add($b5)',
    '$form.Add_Shown({ $form.Activate(); $form.BringToFront() })',
    '$null = $form.ShowDialog()',
    'Write-Output $script:choice',
  ].join('; ');
  return runPowerShell(script);
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases = {
    '1': 'white',
    white: 'white',
    '2': 'pattern',
    pattern: 'pattern',
    '3': 'gallery',
    gallery: 'gallery',
    '4': 'check',
    check: 'check',
    '5': 'lvcheck',
    lvcheck: 'lvcheck',
  };
  return aliases[normalized] || '';
}

function pickFolder(mode) {
  const descriptions = {
    white: '选择原始产品图片文件夹',
    pattern: '选择待替换印花的图片文件夹，或选择上一阶段的日期目录',
    gallery: '选择已完成印花替换的图片文件夹，或选择上一阶段的日期目录',
    check: '选择已完成印花替换的图片文件夹，或选择上一阶段的日期目录',
    lvcheck: '选择需要检测并分类LV相关内容的图片文件夹',
  };
  const description = descriptions[mode].replaceAll("'", "''");
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.ShowInTaskbar = $false',
    '$owner.TopMost = $true',
    '$owner.StartPosition = "CenterScreen"',
    '$owner.Size = New-Object System.Drawing.Size(1,1)',
    '$owner.Opacity = 0',
    '$owner.Show()',
    '$owner.Activate()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${description}'`,
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    '$owner.Close()',
  ].join('; ');
  return runPowerShell(script);
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath) {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveFixedElementReference(config) {
  const configured = config.element_reference || 'assets/element-reference.png';
  const resolved = path.resolve(PROJECT_ROOT, configured);
  if (!await fileExists(resolved)) throw new Error(`缺少内置元素参考图：${resolved}`);
  return resolved;
}

function getTaipeiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function readPrompts(mode) {
  const namesByMode = {
    white: ['01_white'],
    pattern: ['02_pattern'],
    check: ['05_check', '02_pattern'],
    lvcheck: ['06_lv_detect'],
    gallery: [
      '03_main',
      '04_detail_01',
      '04_detail_02',
      '04_detail_03',
      '04_detail_04',
      '04_detail_05',
    ],
  };
  const entries = await Promise.all(namesByMode[mode].map(async name => {
    const text = await fs.readFile(path.join(PROJECT_ROOT, 'prompts', `${name}.txt`), 'utf8');
    return [name, text.trim()];
  }));
  return Object.fromEntries(entries);
}

function isImageFile(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function listTopLevelImages(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && isImageFile(entry.name))
    .map(entry => path.join(inputDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-Hant'));
}

async function findCanonicalInputs(inputDir, mode) {
  const found = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const fileName = entry.name.toLowerCase();
        const parentName = path.basename(path.dirname(fullPath)).toLowerCase();
        const isPatternInput = mode === 'pattern'
          && parentName === 'intermediate'
          && (fileName === '01_white.png' || fileName.endsWith('_white.png'));
        const isGalleryInput = (mode === 'gallery' || mode === 'check')
          && parentName === 'final'
          && (fileName === '02_pattern.png' || fileName.endsWith('_pattern.png'));
        if (isPatternInput || isGalleryInput) found.push(fullPath);
      }
    }
  }

  await visit(inputDir);
  return found.sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

async function listModeImages(inputDir, mode) {
  const topLevel = await listTopLevelImages(inputDir);
  if (mode === 'lvcheck') return topLevel;
  if (mode === 'check') {
    // 日期目录的第一层可能同时保留原图；复检必须优先使用 final 中的印花成品图。
    const canonical = await findCanonicalInputs(inputDir, mode);
    return canonical.length ? canonical : topLevel;
  }
  if (topLevel.length || mode === 'white') return topLevel;
  return findCanonicalInputs(inputDir, mode);
}

function baseTaskName(imagePath) {
  const fileName = path.basename(imagePath).toLowerCase();
  const parentName = path.basename(path.dirname(imagePath)).toLowerCase();
  const originalName = path.basename(imagePath, path.extname(imagePath));
  if (parentName === 'intermediate' && fileName.endsWith('_white.png')) {
    return originalName.slice(0, -'_white'.length);
  }
  if (parentName === 'final' && fileName.endsWith('_pattern.png')) {
    return originalName.slice(0, -'_pattern'.length);
  }
  if (parentName === 'checked' && fileName.endsWith('_checked.png')) {
    return originalName.slice(0, -'_checked'.length);
  }
  if (
    (fileName === '01_white.png' && parentName === 'intermediate')
    || (fileName === '02_pattern.png' && parentName === 'final')
  ) {
    return path.basename(path.dirname(path.dirname(imagePath)));
  }
  return path.basename(imagePath, path.extname(imagePath));
}

function assignTaskNames(imagePaths) {
  const counts = new Map();
  return imagePaths.map(imagePath => {
    const base = baseTaskName(imagePath);
    const count = (counts.get(base.toLowerCase()) || 0) + 1;
    counts.set(base.toLowerCase(), count);
    return { imagePath, taskName: count === 1 ? base : `${base}_${count}` };
  });
}

function inferOutputRoot(inputDir, outputFolderName) {
  let current = path.resolve(inputDir);
  while (true) {
    if (path.basename(current).toLowerCase() === outputFolderName.toLowerCase()) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(inputDir, outputFolderName);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(label, retryCount, operation) {
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      if (attempt > 0) console.log(`  ↻ ${label} 重试 ${attempt}/${retryCount}`);
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) await wait(1500);
    }
  }
  throw lastError;
}

function apiOptions(config) {
  return {
    model: config.direct_image_model || 'gpt-image-2',
    size: config.size || '1024x1024',
    quality: config.quality || 'high',
    timeoutMs: Number(config.request_timeout_ms) || 900000,
    endpoint: config.edit_endpoint || '/images/edits',
    imageField: config.edit_image_field || 'image[]',
  };
}

function reasoningOptions(config, reasoningEffort) {
  return {
    reasoningModel: config.reasoning_model || 'gpt-5.6-terra',
    reasoningEffort,
    size: config.size || '1024x1024',
    quality: config.quality || 'high',
    action: 'edit',
    timeoutMs: Number(config.request_timeout_ms) || 900000,
  };
}

function parseCheckResult(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    throw new Error(`复检结果不是有效JSON：${cleaned.slice(0, 300)}`);
  }
  const needsRepair = result.needs_repair === true || String(result.needs_repair).toLowerCase() === 'true';
  return {
    needsRepair,
    findings: Array.isArray(result.findings) ? result.findings.map(String) : [],
    repairPrompt: String(result.repair_prompt || '').trim(),
  };
}

function parseLvDetectionResult(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    throw new Error(`LV检测结果不是有效JSON：${cleaned.slice(0, 300)}`);
  }
  const decision = String(result.decision || '').trim().toLowerCase();
  if (!['detected', 'not_detected', 'uncertain'].includes(decision)) {
    throw new Error(`LV检测结果包含无效decision：${decision || 'empty'}`);
  }
  const confidence = Number(result.confidence);
  return {
    decision,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    evidence: Array.isArray(result.evidence) ? result.evidence.map(String) : [],
    summary: String(result.summary || '').trim(),
  };
}

async function uniqueDestinationPath(dirPath, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(dirPath, fileName);
  let suffix = 2;
  while (await fileExists(candidate)) {
    candidate = path.join(dirPath, `${stem}_${suffix}${extension}`);
    suffix++;
  }
  return candidate;
}

async function moveFile(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
  }
}

function buildCheckRepairPrompt(basePatternPrompt, findings) {
  const objects = findings.length
    ? findings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')
    : '1. 复检模型确认存在不属于元素参考图的残留旧纹样。';
  return `${basePatternPrompt}\n\n【复检修复模式——本节优先级最高】

这是对已经完成一次印花替换的成品图进行补修，不是重新设计或重新生成整张产品图。

图1是待编辑的印花成品图，图2是元素参考图。请使用与首次印花替换相同的识别、材质融合、透视和遮挡能力，自主检查图1中的纹样对象，只补修复检模型确认仍存在的以下对象类型：

${objects}

执行规则：

1. 以“纹样对象”为编辑单位，不以坐标、矩形范围或整片区域为编辑单位。
2. 在图1中自主识别属于上述类型、且外形确实不属于图2五个目标元素的所有残留旧纹样对象，并按照前述映射逐个原位替换。
3. 图1中已经属于图2的正确元素全部锁定保留，包括它们当前的位置、数量、大小和排列布局；即使这些正确元素处于新的布局中也不得删除或重排。
4. 不编辑正确元素周围的皮革区域，不清除整片印花，不重绘整个包身，不改变产品其他区域。
5. 除被确认的残留旧纹样对象和指定旧文字外，图1的包型、颜色、材质纹理、缝线、包边、五金结构、手柄、肩带、挂饰、背景、光影和构图必须保持不变。
6. 必须由你在编辑前完成对象级视觉复核；不要机械照搬复检描述中可能不准确的位置，不要把正确的图2元素再次替换。
7. 修复后的旧纹样对象必须完整变为图2对应元素，同时保持原对象的中心、尺寸、旋转、透视、裁切、材质和遮挡关系。
`;
}

async function processTask({
  mode,
  task,
  index,
  total,
  dateOutputRoot,
  elementReference,
  prompts,
  config,
  dryRun,
}) {
  const prefix = `[${index + 1}/${total}] [${task.taskName}]`;
  const taskRoot = path.join(dateOutputRoot, task.taskName);
  const intermediateDir = mode === 'white'
    ? path.join(dateOutputRoot, 'intermediate')
    : path.join(taskRoot, 'intermediate');
  const finalDir = mode === 'pattern'
    ? path.join(dateOutputRoot, 'final')
    : mode === 'gallery'
      ? path.join(taskRoot, 'final')
      : null;
  const outputDir = mode === 'white' ? intermediateDir : finalDir;
  if (outputDir) await fs.mkdir(outputDir, { recursive: true });

  if (dryRun) {
    const plannedOutput = mode === 'white'
      ? path.join(intermediateDir, `${task.taskName}_white.png`)
      : mode === 'pattern'
      ? path.join(finalDir, `${task.taskName}_pattern.png`)
      : mode === 'check'
        ? path.join(dateOutputRoot, 'checked', `${task.taskName}_checked.png`)
      : mode === 'lvcheck'
        ? path.join(dateOutputRoot, 'lv_detected', path.basename(task.imagePath))
      : taskRoot;
    console.log(`${prefix} ${MODES[mode]}计划完成：${plannedOutput}`);
    return { task: task.taskName, status: 'dry-run', taskRoot: plannedOutput };
  }

  const retries = Math.max(0, Number(config.retry_count) || 0);

  if (mode === 'white') {
    const outputPath = path.join(intermediateDir, `${task.taskName}_white.png`);
    console.log(`${prefix} 生成白底图`);
    await withRetry(`${task.taskName}/白底图`, retries, () => editImage({
      ...apiOptions(config),
      prompt: prompts['01_white'],
      images: [task.imagePath],
      outputPath,
    }));
  }

  if (mode === 'pattern') {
    const outputPath = path.join(finalDir, `${task.taskName}_pattern.png`);
    console.log(`${prefix} 替换印花`);
    await withRetry(`${task.taskName}/印花替换`, retries, () => reasonedEditImage({
      ...reasoningOptions(config, config.pattern_reasoning_effort || 'xhigh'),
      prompt: prompts['02_pattern'],
      images: [task.imagePath, elementReference],
      outputPath,
    }));
  }

  if (mode === 'check') {
    const checkedDir = path.join(dateOutputRoot, 'checked');
    const reportDir = path.join(checkedDir, 'reports');
    const outputPath = path.join(checkedDir, `${task.taskName}_checked.png`);
    const reportPath = path.join(reportDir, `${task.taskName}_check.json`);
    await fs.mkdir(reportDir, { recursive: true });
    const analysisImages = [task.imagePath, elementReference];
    console.log(`${prefix} 按元素参考图复检非目标纹样`);
    const analysis = await withRetry(`${task.taskName}/印花复检`, retries, () => reasonedAnalyzeImages({
      prompt: prompts['05_check'],
      images: analysisImages,
      reasoningModel: config.reasoning_model || 'gpt-5.6-terra',
      reasoningEffort: config.check_reasoning_effort || config.pattern_reasoning_effort || 'xhigh',
      timeoutMs: Number(config.request_timeout_ms) || 900000,
    }));
    const check = parseCheckResult(analysis.text);
    const repairPrompt = check.needsRepair
      ? buildCheckRepairPrompt(prompts['02_pattern'], check.findings)
      : '';
    const report = {
      input_image: task.imagePath,
      checked_at: new Date().toISOString(),
      model: analysis.responseModel,
      needs_repair: check.needsRepair,
      findings: check.findings,
      detector_prompt: check.repairPrompt,
      repair_prompt: repairPrompt,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (!check.needsRepair) {
      await fs.copyFile(task.imagePath, outputPath);
      console.log(`${prefix} 未发现明确遗漏，直接保留原结果`);
    } else {
      console.log(`${prefix} 发现 ${check.findings.length} 类残留对象，按首次纹样替换流程补修`);
      await withRetry(`${task.taskName}/印花修复`, retries, () => reasonedEditImage({
        ...reasoningOptions(config, config.check_reasoning_effort || config.pattern_reasoning_effort || 'xhigh'),
        prompt: repairPrompt,
        images: [task.imagePath, elementReference],
        outputPath,
      }));
    }
  }

  if (mode === 'lvcheck') {
    const detectedDir = path.join(dateOutputRoot, 'lv_detected');
    const reportDir = path.join(dateOutputRoot, 'lv_detection_reports');
    console.log(`${prefix} 检测LV相关信息`);
    const analyzed = await withRetry(`${task.taskName}/LV检测`, retries, async () => {
      const analysis = await reasonedAnalyzeImages({
        prompt: prompts['06_lv_detect'],
        images: [task.imagePath],
        reasoningModel: config.reasoning_model || 'gpt-5.6-terra',
        reasoningEffort: config.lv_detection_reasoning_effort || 'xhigh',
        timeoutMs: Number(config.request_timeout_ms) || 900000,
      });
      return { analysis, detection: parseLvDetectionResult(analysis.text) };
    });

    let movedTo = null;
    if (analyzed.detection.decision === 'detected') {
      await fs.mkdir(detectedDir, { recursive: true });
      movedTo = await uniqueDestinationPath(detectedDir, path.basename(task.imagePath));
      await moveFile(task.imagePath, movedTo);
      console.log(`${prefix} 检测命中，已移动：${movedTo}`);
    } else if (analyzed.detection.decision === 'uncertain') {
      console.log(`${prefix} 检测结果不确定，原图保留`);
    } else {
      console.log(`${prefix} 未检测到，原图保留`);
    }

    try {
      await fs.mkdir(reportDir, { recursive: true });
      await fs.writeFile(
        path.join(reportDir, `${task.taskName}_lv.json`),
        `${JSON.stringify({
          input_image: task.imagePath,
          checked_at: new Date().toISOString(),
          model: analyzed.analysis.responseModel,
          ...analyzed.detection,
          moved_to: movedTo,
        }, null, 2)}\n`,
        'utf8',
      );
    } catch (reportError) {
      console.error(`${prefix} 检测报告保存失败：${reportError.message}`);
    }

    return {
      task: task.taskName,
      status: 'success',
      taskRoot: movedTo || task.imagePath,
      decision: analyzed.detection.decision,
    };
  }

  if (mode === 'gallery') {
    console.log(`${prefix} 并发生成主图和5张详情图`);
    const finalJobs = [
      ['电商场景主图', '03_main', '03_main.png'],
      ['详情图01', '04_detail_01', '04_detail_01.png'],
      ['详情图02', '04_detail_02', '04_detail_02.png'],
      ['详情图03', '04_detail_03', '04_detail_03.png'],
      ['详情图04', '04_detail_04', '04_detail_04.png'],
      ['详情图05', '04_detail_05', '04_detail_05.png'],
    ];
    const options = reasoningOptions(config, config.gallery_reasoning_effort || 'xhigh');
    const settled = await Promise.allSettled(finalJobs.map(([label, promptKey, outputName]) =>
      withRetry(`${task.taskName}/${label}`, retries, () => reasonedEditImage({
        ...options,
        prompt: prompts[promptKey],
        images: [task.imagePath],
        outputPath: path.join(finalDir, outputName),
      }))
    ));
    const failed = settled
      .map((result, jobIndex) => ({ result, label: finalJobs[jobIndex][0] }))
      .filter(item => item.result.status === 'rejected');
    if (failed.length) {
      const detail = failed
        .map(item => `${item.label}: ${item.result.reason?.message || item.result.reason}`)
        .join('；');
      throw new Error(`部分最终图片生成失败：${detail}`);
    }
  }

  const completedOutput = mode === 'white'
    ? path.join(intermediateDir, `${task.taskName}_white.png`)
    : mode === 'pattern'
      ? path.join(finalDir, `${task.taskName}_pattern.png`)
      : mode === 'check'
        ? path.join(dateOutputRoot, 'checked', `${task.taskName}_checked.png`)
      : taskRoot;
  console.log(`${prefix} 完成：${completedOutput}`);
  return { task: task.taskName, status: 'success', taskRoot: completedOutput };
}

async function copyFailedOriginal(dateOutputRoot, task) {
  const failedDir = path.join(dateOutputRoot, 'failed');
  await fs.mkdir(failedDir, { recursive: true });
  const ext = path.extname(task.imagePath) || '.png';
  const outputPath = path.join(failedDir, `${task.taskName}${ext}`);
  await fs.copyFile(task.imagePath, outputPath);
  return outputPath;
}

async function runPool(items, concurrency, worker, onFailure) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        let failedOriginalPath = null;
        if (onFailure) {
          try {
            failedOriginalPath = await onFailure(items[index], error, index);
          } catch (copyError) {
            console.error(`[${index + 1}/${items.length}] [${items[index].taskName}] 失败原图复制失败：${copyError.message}`);
          }
        }
        results[index] = { task: items[index].taskName, status: 'failed', error: error.message, failedOriginalPath };
        console.error(`[${index + 1}/${items.length}] [${items[index].taskName}] 失败：${error.message}`);
        if (failedOriginalPath) console.error(`  失败原图：${failedOriginalPath}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (!args.mode) console.log('正在打开处理模式选择窗口，请在弹出的窗口中选择……');
  const mode = normalizeMode(args.mode || pickMode());
  if (!mode) throw new Error('未选择处理模式，任务已取消');

  if (!args.input) console.log('正在打开图片文件夹选择窗口，请选择要批量处理的文件夹……');
  const inputDir = args.input ? path.resolve(args.input) : pickFolder(mode);
  if (!inputDir) throw new Error('未选择图片文件夹，任务已取消');
  if (!await directoryExists(inputDir)) throw new Error(`图片文件夹不存在：${inputDir}`);

  const config = await readJson(path.join(PROJECT_ROOT, 'config.json'));
  const outputFolderName = config.output_folder || 'output';
  const outputRoot = args.output
    ? path.resolve(args.output)
    : inferOutputRoot(inputDir, outputFolderName);
  const batchDate = getTaipeiDate();
  const dateOutputRoot = path.join(outputRoot, batchDate);
  await fs.mkdir(dateOutputRoot, { recursive: true });

  const images = await listModeImages(inputDir, mode);
  if (!images.length) {
    const fallback = mode === 'pattern'
      ? '第一层图片或上一阶段 intermediate 文件夹中的白底图'
      : (mode === 'gallery' || mode === 'check')
        ? '第一层图片或上一阶段 final 文件夹中的印花图'
        : '第一层PNG/JPG/JPEG/WEBP图片';
    throw new Error(`所选文件夹中没有找到${fallback}：${inputDir}`);
  }

  const tasks = assignTaskNames(images);
  const prompts = await readPrompts(mode);
  const concurrency = Math.max(1, Number(config.task_concurrency) || 5);
  const elementReference = (mode === 'pattern' || mode === 'check')
    ? await resolveFixedElementReference(config)
    : null;

  console.log(`处理模式：${MODES[mode]}`);
  console.log(`输入目录：${inputDir}`);
  if (mode === 'pattern' || mode === 'check') {
    console.log(`固定元素参考图（图2）：${elementReference}`);
    const effort = mode === 'check'
      ? (config.check_reasoning_effort || config.pattern_reasoning_effort || 'xhigh')
      : (config.pattern_reasoning_effort || 'xhigh');
    console.log(`推理参数：${config.reasoning_model || 'gpt-5.6-terra'} / ${effort}`);
  }
  if (mode === 'gallery') {
    console.log(`推理参数：${config.reasoning_model || 'gpt-5.6-terra'} / ${config.gallery_reasoning_effort || 'xhigh'}`);
  }
  if (mode === 'lvcheck') {
    console.log(`检测参数：${config.reasoning_model || 'gpt-5.6-terra'} / ${config.lv_detection_reasoning_effort || 'xhigh'}`);
    console.log('仅移动 decision=detected 的图片；not_detected 和 uncertain 保留原位。');
  }
  console.log(`输出目录：${dateOutputRoot}`);
  console.log(`图片任务：${tasks.length}，任务并发：${concurrency}`);
  if (args['dry-run']) console.log('当前为 dry-run，不调用生图接口。');

  const results = await runPool(
    tasks,
    concurrency,
    (task, index) => processTask({
      mode,
      task,
      index,
      total: tasks.length,
      dateOutputRoot,
      elementReference,
      prompts,
      config,
      dryRun: Boolean(args['dry-run']),
    }),
    args['dry-run'] ? null : task => copyFailedOriginal(dateOutputRoot, task),
  );

  const succeeded = results.filter(result => result.status === 'success' || result.status === 'dry-run').length;
  const failed = results.filter(result => result.status === 'failed');
  console.log(`\n批次结束：成功 ${succeeded}，失败 ${failed.length}`);
  console.log(`产物目录：${dateOutputRoot}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
