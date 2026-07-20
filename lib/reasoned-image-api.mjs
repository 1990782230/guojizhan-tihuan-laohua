import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveApiConfig } from './image-api.mjs';

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/png';
  }
}

async function imageDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  return `data:${mimeType(filePath)};base64,${bytes.toString('base64')}`;
}

function extractErrorMessage(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed?.error?.message || parsed?.message || `HTTP ${status}`;
  } catch {
    return bodyText.slice(0, 500) || `HTTP ${status}`;
  }
}

export async function reasonedEditImage({
  prompt,
  images,
  outputPath,
  reasoningModel = 'gpt-5.5',
  reasoningEffort = 'max',
  size = '1024x1024',
  quality = 'high',
  action = 'edit',
  timeoutMs = 900000,
  baseUrl,
  apiKey,
}) {
  if (!prompt?.trim()) throw new Error('Prompt 为空');
  if (!Array.isArray(images) || images.length === 0) throw new Error('至少需要一张输入图片');

  const api = await resolveApiConfig({ baseUrl, apiKey });
  const inputImages = await Promise.all(images.map(imageDataUrl));
  const body = {
    model: reasoningModel,
    reasoning: { effort: reasoningEffort },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...inputImages.map(imageUrl => ({ type: 'input_image', image_url: imageUrl })),
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        action,
        quality,
        size,
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${api.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`推理生图请求超时（>${Math.round(timeoutMs / 1000)}秒）`);
    }
    throw new Error(`推理生图网络请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Responses图像编辑失败：${extractErrorMessage(response.status, bodyText)}`);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('Responses接口返回了无效JSON');
  }

  const imageCall = (data.output || [])
    .find(item => item.type === 'image_generation_call' && item.result);
  if (!imageCall) {
    const types = (data.output || []).map(item => `${item.type}:${item.status || ''}`).join(', ');
    throw new Error(`Responses接口没有返回图片，输出类型：${types || 'empty'}`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(imageCall.result, 'base64'));

  return {
    outputPath: path.resolve(outputPath),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    responseId: data.id || null,
    responseModel: data.model || reasoningModel,
    reasoningEffort,
    revisedPrompt: imageCall.revised_prompt || null,
    usage: data.usage || null,
  };
}
