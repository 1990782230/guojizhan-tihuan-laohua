import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USER_CONFIG_PATH = path.join(os.homedir(), '.img-gen', 'config.json');
const REFERENCE_CONFIG_PATH = 'D:\\ai\\中转站\\image-gen\\config.example.json';

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/png';
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export async function resolveApiConfig(overrides = {}) {
  const stored = await readJson(USER_CONFIG_PATH);
  const reference = await readJson(REFERENCE_CONFIG_PATH);
  const usableKey = value => typeof value === 'string'
    && /^sk-[\x21-\x7e]+$/.test(value)
    && !value.includes('你的key');
  const baseUrl = overrides.baseUrl
    || process.env.IMAGE_API_BASE_URL
    || process.env.OPENAI_BASE_URL
    || stored.base_url
    || stored.baseUrl
    || reference.base_url
    || reference.baseUrl
    || '';
  const candidates = [
    overrides.apiKey,
    process.env.IMAGE_API_KEY,
    process.env.OPENAI_API_KEY,
    stored.api_key,
    stored.apiKey,
    reference.api_key,
    reference.apiKey,
  ];
  const apiKey = candidates.find(usableKey)
    || overrides.apiKey
    || process.env.IMAGE_API_KEY
    || process.env.OPENAI_API_KEY
    || '';

  if (!baseUrl || !apiKey) {
    throw new Error(`缺少生图 API 配置，请配置环境变量，或填写 ${USER_CONFIG_PATH}`);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

function extractErrorMessage(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed?.error?.message || parsed?.message || `HTTP ${status}`;
  } catch {
    return bodyText.slice(0, 500) || `HTTP ${status}`;
  }
}

async function saveImageItem(item, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (item.b64_json) {
    await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
    return;
  }
  if (item.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`);
    await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return;
  }
  throw new Error('接口响应中没有 b64_json 或 url');
}

export async function editImage({
  prompt,
  images,
  outputPath,
  model = 'gpt-image-2',
  size = '1024x1024',
  quality = 'high',
  timeoutMs = 300000,
  endpoint = '/images/edits',
  imageField = 'image[]',
  baseUrl,
  apiKey,
}) {
  if (!prompt?.trim()) throw new Error('Prompt 为空');
  if (!Array.isArray(images) || images.length === 0) throw new Error('至少需要一张输入图片');

  const api = await resolveApiConfig({ baseUrl, apiKey });
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('response_format', 'b64_json');
  if (quality && quality !== 'auto') form.append('quality', quality);

  for (const imagePath of images) {
    const bytes = await fs.readFile(imagePath);
    form.append(imageField, new Blob([bytes], { type: mimeType(imagePath) }), path.basename(imagePath));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${api.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}秒）`);
    throw new Error(`网络请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`图像编辑接口失败：${extractErrorMessage(response.status, bodyText)}`);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('图像编辑接口返回了无效 JSON');
  }
  const item = data?.data?.[0];
  if (!item) throw new Error('图像编辑接口没有返回图片');
  await saveImageItem(item, outputPath);

  return {
    outputPath: path.resolve(outputPath),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    revisedPrompt: item.revised_prompt || null,
    usage: data.usage || null,
  };
}
