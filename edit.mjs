#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { editImage } from './lib/image-api.mjs';

function parseArgs(argv) {
  const args = { _: [], image: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === 'help' || key === 'json') {
      args[key] = true;
      continue;
    }
    const next = argv[++i];
    if (next === undefined) throw new Error(`参数 --${key} 缺少值`);
    if (key === 'image') args.image.push(next);
    else args[key] = next;
  }
  return args;
}

const HELP = `包袋图像编辑 CLI

用法：
  node edit.mjs "PROMPT" --image input.png --out output.png
  node edit.mjs --prompt-file prompts/02_pattern.txt --image white.png --image elements.png --out pattern.png

参数：
  --image <path>         输入图片，可重复使用
  --out <path>           输出图片路径
  --prompt-file <path>   从文件读取 Prompt
  --model <name>         默认 gpt-image-2
  --size <WxH>           默认 1024x1024
  --quality <value>      默认 high
  --json                 输出 JSON 结果
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const prompt = args['prompt-file']
    ? await fs.readFile(path.resolve(args['prompt-file']), 'utf8')
    : args._.join(' ').trim();
  if (!prompt) throw new Error('缺少 Prompt 或 --prompt-file');
  if (!args.image.length) throw new Error('至少需要一个 --image');
  if (!args.out) throw new Error('缺少 --out');

  const result = await editImage({
    prompt,
    images: args.image.map(value => path.resolve(value)),
    outputPath: path.resolve(args.out),
    model: args.model,
    size: args.size,
    quality: args.quality,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.outputPath);
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
