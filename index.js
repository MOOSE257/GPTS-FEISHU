const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ========== 基础配置 ==========
const PORT = process.env.PORT || 8080;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'low';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是飞书中的 AI 助手，回答要简洁、准确、实用。默认使用中文回答。';

// ========== 内存缓存 ==========
let cachedTenantToken = {
  token: '',
  expire: 0,
};

// Railway 重启后内存会清空，正式生产建议改成数据库
const historyMap = new Map();
const processedEvents = new Set();

// ========== 健康检查 ==========
app.get('/', (req, res) => {
  res.send('Feishu GPT Bot is running');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'feishu-gpt-bot',
    text_model: OPENAI_MODEL,
    image_model: OPENAI_IMAGE_MODEL,
    image_size: OPENAI_IMAGE_SIZE,
    image_quality: OPENAI_IMAGE_QUALITY,
    time: new Date().toISOString(),
  });
});

// ========== 环境变量检查 ==========
function requireEnv(name) {
  if (!process.env[name]) {
    console.warn(`环境变量缺失: ${name}`);
  }
}

requireEnv('FEISHU_APPID');
requireEnv('FEISHU_SECRET');
requireEnv('OPENAI_API_KEY');

// ========== 对话历史 ==========
function getHistory(sessionId) {
  return historyMap.get(sessionId) || [];
}

function saveHistory(sessionId, messages) {
  const trimmed = messages.slice(-40);
  historyMap.set(sessionId, trimmed);
}

function clearHistory(sessionId) {
  historyMap.delete(sessionId);
}

function buildResponsesInput(sessionId) {
  const history = getHistory(sessionId);

  return history.map((item) => ({
    role: item.role,
    content: item.content,
  }));
}

// ========== 文本切分 ==========
function splitText(text, maxLen = 1800) {
  if (!text) return [''];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let chunk = remaining.slice(0, maxLen);

    const lastBreak = Math.max(
      chunk.lastIndexOf('\n'),
      chunk.lastIndexOf('。'),
      chunk.lastIndexOf('！'),
      chunk.lastIndexOf('？'),
      chunk.lastIndexOf('. '),
      chunk.lastIndexOf(' ')
    );

    if (lastBreak > maxLen * 0.5) {
      chunk = remaining.slice(0, lastBreak + 1);
    }

    chunks.push(chunk.trim());
    remaining = remaining.slice(chunk.length);
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

// ========== 解析飞书文本消息 ==========
function extractTextFromFeishuContent(rawContent) {
  if (!rawContent) return '';

  try {
    const parsed = JSON.parse(rawContent);
    let text = parsed.text || '';

    text = text
      // 飞书 @ 机器人格式
      .replace(/<at[^>]*><\/at>/g, '')
      // 兼容部分旧格式
      .replace(/@_user_\d+\s*/g, '')
      .trim();

    return text;
  } catch (err) {
    console.error('解析飞书消息 content 失败:', err.message, rawContent);
    return '';
  }
}

// ========== 判断是否是画图请求 ==========
function isImageRequest(text) {
  if (!text) return false;

  return (
    text.startsWith('/image ') ||
    text.startsWith('画图 ') ||
    text.startsWith('生成图片 ') ||
    text.startsWith('出图 ') ||
    text.startsWith('做图 ')
  );
}

function extractImagePrompt(text) {
  return text
    .replace(/^\/image\s+/i, '')
    .replace(/^画图\s+/, '')
    .replace(/^生成图片\s+/, '')
    .replace(/^出图\s+/, '')
    .replace(/^做图\s+/, '')
    .trim();
}

// ========== 获取飞书 tenant_access_token ==========
async function getTenantToken() {
  if (cachedTenantToken.token && Date.now() < cachedTenantToken.expire) {
    return cachedTenantToken.token;
  }

  try {
    const res = await axios.post(
      'https://open.feishu.cn/open-apis/v3/auth/tenant_access_token/internal/',
      {
        app_id: process.env.FEISHU_APPID,
        app_secret: process.env.FEISHU_SECRET,
      },
      {
        timeout: 15000,
      }
    );

    const data = res.data;

    if (data.code !== 0) {
      throw new Error(`飞书 token 获取失败: code=${data.code}, msg=${data.msg}`);
    }

    cachedTenantToken = {
      token: data.tenant_access_token,
      expire: Date.now() + (data.expire - 300) * 1000,
    };

    console.log('飞书 tenant_access_token 获取成功');
    return cachedTenantToken.token;
  } catch (err) {
    console.error('获取飞书 token 出错:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 发送飞书文本消息 ==========
async function sendFeishuText({
  msgId,
  openId,
  chatType,
  content,
  atUser = false,
}) {
  const token = await getTenantToken();

  let text = content || '没有生成回复。';

  // 群聊第一条回复 @ 用户，私聊不需要 @
  if (atUser && openId && chatType !== 'p2p') {
    text = `<at user_id="${openId}"></at> ${text}`;
  }

  const payload = {
    msg_type: 'text',
    content: JSON.stringify({ text }),
  };

  try {
    // 私聊：直接发给用户
    if (chatType === 'p2p') {
      const res = await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: openId,
          ...payload,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      console.log('飞书私聊文本发送结果:', JSON.stringify(res.data));
      return res.data;
    }

    // 群聊：回复原消息
    const res = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reply`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    console.log('飞书群聊文本回复结果:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error('发送飞书文本失败:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 解析 OpenAI Responses API 回复 ==========
function extractResponsesText(data) {
  if (!data) return '';

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.output)) {
    const texts = [];

    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            texts.push(content.text);
          }

          if (content.type === 'text' && content.text) {
            texts.push(content.text);
          }
        }
      }
    }

    return texts.join('\n').trim();
  }

  return '';
}

// ========== 调用 OpenAI Responses API ==========
async function callOpenAI(sessionId) {
  const input = buildResponsesInput(sessionId);

  try {
    console.log('准备调用 OpenAI Responses API，模型:', OPENAI_MODEL);
    console.log('OPENAI_API_KEY 是否存在:', !!process.env.OPENAI_API_KEY);
    console.log(
      'OPENAI_API_KEY 开头:',
      process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.slice(0, 8) : '不存在'
    );

    const res = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: OPENAI_MODEL,
        instructions: SYSTEM_PROMPT,
        input,
        store: false,
        max_output_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    console.log('OpenAI Responses API 调用成功');

    const reply = extractResponsesText(res.data);

    if (!reply) {
      console.error('OpenAI Responses API 返回为空:', JSON.stringify(res.data));
      return 'OpenAI 没有返回有效内容。';
    }

    return reply.trim();
  } catch (err) {
    console.error('OpenAI Responses API 调用失败状态码:', err.response?.status);
    console.error(
      'OpenAI Responses API 调用失败详情:',
      JSON.stringify(err.response?.data || err.message)
    );

    throw err;
  }
}

// ========== 调用 OpenAI 图片生成 ==========
async function generateImageWithOpenAI(prompt) {
  try {
    console.log('准备调用 OpenAI 图片生成');
    console.log('图片模型:', OPENAI_IMAGE_MODEL);
    console.log('图片尺寸:', OPENAI_IMAGE_SIZE);
    console.log('图片质量:', OPENAI_IMAGE_QUALITY);
    console.log('图片提示词:', prompt);

    const res = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: OPENAI_IMAGE_MODEL,
        prompt,
        size: OPENAI_IMAGE_SIZE,
        quality: OPENAI_IMAGE_QUALITY,
        output_format: 'png',
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 180000,
      }
    );

    const b64 = res.data?.data?.[0]?.b64_json;

    if (!b64) {
      console.error('OpenAI 图片生成返回为空:', JSON.stringify(res.data));
      throw new Error('OpenAI 没有返回图片 base64');
    }

    console.log('OpenAI 图片生成成功');
    return Buffer.from(b64, 'base64');
  } catch (err) {
    console.error('OpenAI 图片生成失败状态码:', err.response?.status);
    console.error('OpenAI 图片生成失败详情:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 上传图片到飞书 ==========
async function uploadImageToFeishu(imageBuffer) {
  const token = await getTenantToken();

  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', imageBuffer, {
    filename: 'openai-image.png',
    contentType: 'image/png',
  });

  try {
    const res = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/images',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        timeout: 60000,
      }
    );

    console.log('飞书图片上传结果:', JSON.stringify(res.data));

    const imageKey = res.data?.data?.image_key;

    if (!imageKey) {
      throw new Error(`飞书没有返回 image_key: ${JSON.stringify(res.data)}`);
    }

    return imageKey;
  } catch (err) {
    console.error('上传图片到飞书失败:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 发送飞书图片消息 ==========
async function sendFeishuImage({
  msgId,
  openId,
  chatType,
  imageKey,
}) {
  const token = await getTenantToken();

  const payload = {
    msg_type: 'image',
    content: JSON.stringify({
      image_key: imageKey,
    }),
  };

  try {
    // 私聊：直接发给用户
    if (chatType === 'p2p') {
      const res = await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: openId,
          ...payload,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      console.log('飞书私聊图片发送结果:', JSON.stringify(res.data));
      return res.data;
    }

    // 群聊：回复原消息
    const res = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reply`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log('飞书群聊图片回复结果:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error('发送飞书图片失败:', err.response?.data || err.message);
    throw err;
  }
}

// ========== OpenAI 文字测试接口 ==========
app.get('/test-openai', async (req, res) => {
  try {
    const result = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: OPENAI_MODEL,
        input: '请只回复 OK',
        store: false,
        max_output_tokens: 50,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    res.json({
      ok: true,
      model: OPENAI_MODEL,
      reply: extractResponsesText(result.data),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: err.response?.status || null,
      error: err.response?.data || err.message,
    });
  }
});

// ========== OpenAI 图片测试接口 ==========
app.get('/test-image', async (req, res) => {
  const prompt =
    req.query.prompt ||
    '一只橘猫坐在海边，干净的电商风格，方形构图';

  try {
    const imageBuffer = await generateImageWithOpenAI(prompt);
    const imageKey = await uploadImageToFeishu(imageBuffer);

    res.json({
      ok: true,
      image_key: imageKey,
      message: '图片已生成并上传到飞书。这个接口只测试上传，不会主动发到飞书聊天。',
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: err.response?.status || null,
      error: err.response?.data || err.message,
    });
  }
});

// ========== 处理飞书事件 ==========
async function handleFeishuEvent(body) {
  console.log('开始处理飞书事件');

  // 如果飞书事件订阅开启了 Encrypt Key，会收到 encrypt 字段
  // 本代码暂不做解密，所以建议先关闭事件加密
  if (body.encrypt) {
    console.error('检测到飞书加密事件 encrypt。请先关闭事件加密，或增加解密逻辑。');
    return;
  }

  const eventType = body.header?.event_type;
  console.log('事件类型:', eventType);

  if (eventType !== 'im.message.receive_v1') {
    console.log('非消息接收事件，跳过');
    return;
  }

  const event = body.event;
  const message = event?.message;

  if (!event || !message) {
    console.log('事件体缺少 event 或 message，跳过');
    return;
  }

  if (event.sender?.sender_type === 'bot') {
    console.log('机器人自己的消息，跳过');
    return;
  }

  const msgType = message.message_type;
  const chatType = message.chat_type;
  const msgId = message.message_id;
  const chatId = message.chat_id;
  const openId = event.sender?.sender_id?.open_id;
  const eventId = body.header?.event_id || msgId;

  console.log('消息类型:', msgType);
  console.log('聊天类型:', chatType);
  console.log('消息 ID:', msgId);
  console.log('发送人 open_id:', openId);

  if (!msgId) {
    console.log('缺少 message_id，无法回复');
    return;
  }

  if (!openId) {
    console.log('缺少 sender open_id，无法私聊回复');
    return;
  }

  if (processedEvents.has(eventId)) {
    console.log('重复事件，跳过:', eventId);
    return;
  }

  processedEvents.add(eventId);

  if (processedEvents.size > 10000) {
    processedEvents.clear();
  }

  if (msgType !== 'text') {
    await sendFeishuText({
      msgId,
      openId,
      chatType,
      content: '我目前只能处理文本消息。你可以发送：画图 一只坐在海边的橘猫',
      atUser: true,
    });
    return;
  }

  const userText = extractTextFromFeishuContent(message.content);
  console.log('用户消息:', userText);

  if (!userText) {
    console.log('用户消息为空，跳过');
    return;
  }

  const sessionId = chatId || openId;

  // ========== 图片生成指令 ==========
  if (isImageRequest(userText)) {
    const imagePrompt = extractImagePrompt(userText);

    if (!imagePrompt) {
      await sendFeishuText({
        msgId,
        openId,
        chatType,
        content: '请在画图指令后面输入图片描述，例如：画图 一只坐在海边的橘猫',
        atUser: true,
      });
      return;
    }

    try {
      await sendFeishuText({
        msgId,
        openId,
        chatType,
        content: '正在生成图片，请稍等。',
        atUser: true,
      });

      const imageBuffer = await generateImageWithOpenAI(imagePrompt);
      const imageKey = await uploadImageToFeishu(imageBuffer);

      await sendFeishuImage({
        msgId,
        openId,
        chatType,
        imageKey,
      });

      console.log('图片生成并发送完成');
    } catch (err) {
      await sendFeishuText({
        msgId,
        openId,
        chatType,
        content:
          '图片生成或发送失败，请检查 OpenAI 图片模型权限、API 额度、飞书图片上传权限，以及 Railway Runtime Logs。',
        atUser: true,
      });
    }

    return;
  }

  // ========== 清空上下文指令 ==========
  if (
    userText === '/clear' ||
    userText === '清空上下文' ||
    userText === '清除上下文'
  ) {
    clearHistory(sessionId);

    await sendFeishuText({
      msgId,
      openId,
      chatType,
      content: '已清空当前会话上下文。',
      atUser: true,
    });

    return;
  }

  // ========== 保存用户消息 ==========
  const history = getHistory(sessionId);
  history.push({
    role: 'user',
    content: userText,
  });
  saveHistory(sessionId, history);

  let aiReply;

  try {
    aiReply = await callOpenAI(sessionId);
  } catch (err) {
    aiReply =
      'OpenAI 调用失败，请检查 Railway 的 OPENAI_API_KEY、OPENAI_MODEL、API 账户额度，以及 Runtime Logs。';
  }

  // ========== 保存 AI 回复 ==========
  const updatedHistory = getHistory(sessionId);
  updatedHistory.push({
    role: 'assistant',
    content: aiReply,
  });
  saveHistory(sessionId, updatedHistory);

  // ========== 分段发送，避免飞书单条消息过长 ==========
  const chunks = splitText(aiReply, 1800);

  for (let i = 0; i < chunks.length; i++) {
    await sendFeishuText({
      msgId,
      openId,
      chatType,
      content: chunks[i],
      atUser: i === 0,
    });
  }

  console.log('本次文字消息处理完成');
}

// ========== 飞书事件入口 ==========
app.post('/feishu/event', async (req, res) => {
  const body = req.body;

  console.log('收到飞书请求:', JSON.stringify(body));

  // 飞书 URL 首次验证
  if (body.challenge) {
    console.log('飞书 URL 验证 challenge:', body.challenge);
    return res.json({
      challenge: body.challenge,
    });
  }

  // 可选：校验飞书 Verification Token
  // 如果你在 Railway 配了 FEISHU_VERIFICATION_TOKEN，就会进行校验
  if (process.env.FEISHU_VERIFICATION_TOKEN) {
    const incomingToken = body.header?.token || body.token;

    if (incomingToken && incomingToken !== process.env.FEISHU_VERIFICATION_TOKEN) {
      console.error('飞书 Verification Token 不匹配');
      return res.status(403).json({
        code: 403,
        msg: 'invalid verification token',
      });
    }
  }

  // 先返回 200，避免飞书超时重试
  res.json({
    code: 0,
  });

  // 后台继续处理
  setImmediate(() => {
    handleFeishuEvent(body).catch((err) => {
      console.error('处理飞书事件总错误:', err.response?.data || err.message || err);
    });
  });
});

// ========== 启动服务 ==========
app.listen(PORT, () => {
  console.log(`Feishu GPT Bot running on port ${PORT}`);
});
