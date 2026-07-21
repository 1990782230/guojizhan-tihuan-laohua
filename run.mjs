#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editImage } from './lib/image-api.mjs';
import { reasonedEditImage } from './lib/reasoned-image-api.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MODES = {
  white: '白底图',
  pattern: '印花替换',
  gallery: '电商主图与详情图',
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

可选参数：
  --mode <mode>          white | pattern | gallery
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
    '$form.Size = New-Object System.Drawing.Size(430,250)',
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
  };
  return aliases[normalized] || '';
}

function pickFolder(mode) {
  const descriptions = {
    white: '选择原始产品图片文件夹',
    pattern: '选择待替换印花的图片文件夹，或选择上一阶段的日期目录',
    gallery: '选择已完成印花替换的图片文件夹，或选择上一阶段的日期目录',
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
        const isGalleryInput = mode === 'gallery'
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
    reasoningModel: config.reasoning_model || 'gpt-5.5',
    reasoningEffort,
    size: config.size || '1024x1024',
    quality: config.quality || 'high',
    action: 'edit',
    timeoutMs: Number(config.request_timeout_ms) || 900000,
  };
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
    : path.join(taskRoot, 'final');
  const outputDir = mode === 'white' ? intermediateDir : finalDir;
  await fs.mkdir(outputDir, { recursive: true });

  if (dryRun) {
    const plannedOutput = mode === 'white'
      ? path.join(intermediateDir, `${task.taskName}_white.png`)
      : mode === 'pattern'
        ? path.join(finalDir, `${task.taskName}_pattern.png`)
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
      : mode === 'gallery'
        ? '第一层图片或上一阶段 final 文件夹中的印花图'
        : '第一层PNG/JPG/JPEG/WEBP图片';
    throw new Error(`所选文件夹中没有找到${fallback}：${inputDir}`);
  }

  const tasks = assignTaskNames(images);
  const prompts = await readPrompts(mode);
  const concurrency = Math.max(1, Number(config.task_concurrency) || 5);
  const elementReference = mode === 'pattern'
    ? await resolveFixedElementReference(config)
    : null;

  console.log(`处理模式：${MODES[mode]}`);
  console.log(`输入目录：${inputDir}`);
  if (mode === 'pattern') {
    console.log(`固定元素参考图（图2）：${elementReference}`);
    console.log(`推理参数：${config.reasoning_model || 'gpt-5.5'} / ${config.pattern_reasoning_effort || 'xhigh'}`);
  }
  if (mode === 'gallery') {
    console.log(`推理参数：${config.reasoning_model || 'gpt-5.5'} / ${config.gallery_reasoning_effort || 'xhigh'}`);
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
