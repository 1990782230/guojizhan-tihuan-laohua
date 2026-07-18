import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiConfig } from '../../lib/image-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = 'C:\\Users\\19907\\AppData\\Local\\Temp\\codex-clipboard-398614f8-81e3-493a-8f8f-c78cbd299cea.png';
const referencePath = 'C:\\Users\\19907\\AppData\\Local\\Temp\\codex-clipboard-49953fae-1c84-48f2-902b-79944188b62b.png';
const outputPath = path.join(here, 'pro-pattern-result.png');
const summaryPath = path.join(here, 'response-summary.json');

function asDataUrl(bytes) {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const [prompt, source, reference, api] = await Promise.all([
  fs.readFile(path.join(here, 'prompt.txt'), 'utf8'),
  fs.readFile(sourcePath),
  fs.readFile(referencePath),
  resolveApiConfig(),
]);

const body = {
  model: 'gpt-5.6',
  reasoning: { effort: 'max' },
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: asDataUrl(source) },
        { type: 'input_image', image_url: asDataUrl(reference) },
      ],
    },
  ],
  tools: [
    {
      type: 'image_generation',
      action: 'edit',
      quality: 'high',
      size: '1024x1024',
    },
  ],
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 900_000);
const startedAt = Date.now();

try {
  const response = await fetch(`${api.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${api.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`接口返回无效JSON：${responseText.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`);
  }

  const imageCall = (data.output || []).find(item => item.type === 'image_generation_call' && item.result);
  if (!imageCall) {
    const types = (data.output || []).map(item => `${item.type}:${item.status || ''}`).join(', ');
    throw new Error(`响应中没有生成图片。输出类型：${types || 'empty'}`);
  }

  await fs.writeFile(outputPath, Buffer.from(imageCall.result, 'base64'));
  const summary = {
    ok: true,
    response_id: data.id || null,
    response_model: data.model || null,
    requested_model: body.model,
    reasoning_effort: body.reasoning.effort,
    image_action: body.tools[0].action,
    image_quality: body.tools[0].quality,
    image_size: body.tools[0].size,
    elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    revised_prompt: imageCall.revised_prompt || null,
    usage: data.usage || null,
    output_path: outputPath,
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  clearTimeout(timer);
}
