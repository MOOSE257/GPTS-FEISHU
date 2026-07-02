const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ========== 基础配置 ==========
const PORT = process.env.PORT || 8080;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是飞书中的 AI 助手，回答要简洁、准确、实用。默认使用中文回答。';

// ========== 内存缓存 ==========
let cachedTenantToken = {
  token: '',
  expire: 0,
};

// 简单内存上下文。Railway 重启后会丢失，正式生产建议换数据库。
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
    time: new Date().toISOString(),
  });
});

// ========== 工具函数 ==========
function requireEnv(name) {
  if (!process.env[name]) {
    console.warn(`环境变量缺失: ${name}`);
  }
}

requireEnv('FEISHU_APPID');
requireEnv('FEISHU_SECRET');
requireEnv('OPENAI_API_KEY');

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

function buildOpenAIMessages(sessionId) {
  const history = getHistory(sessionId);

  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    ...history,
  ];
}

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

function extractTextFromFeishuContent(rawContent) {
  if (!rawContent) return '';

  try {
    const parsed = JSON.parse(rawContent);
    let text = parsed.text || '';

    text = text
      // 飞书 @ 机器人的一种格式
      .replace(/<at[^>]*><\/at>/g, '')
      // 部分事件里可能出现的旧格式
      .replace(/@_user_\d+\s*/g, '')
      .trim();

    return text;
  } catch (err) {
    console.error('解析飞书消息 content 失败:', err.message, rawContent);
    return '';
  }
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

  // 群聊里第一条回复可以 @ 用户
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

      console.log('飞书私聊发送结果:', JSON.stringify(res.data));
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

    console.log('飞书群聊回复结果:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error('发送飞书消息失败:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 调用 OpenAI ==========
async function callOpenAI(sessionId) {
  const messages = buildOpenAIMessages(sessionId);

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
      }
    );

    const reply = res.data?.choices?.[0]?.message?.content;

    if (!reply) {
      console.error('OpenAI 返回为空:', JSON.stringify(res.data));
      return 'OpenAI 没有返回有效内容。';
    }

    return reply.trim();
  } catch (err) {
    console.error('OpenAI API 调用失败:', err.response?.data || err.message);
    throw err;
  }
}

// ========== 处理飞书事件 ==========
async function handleFeishuEvent(body) {
  console.log('开始处理飞书事件');

  // 如果你在飞书开放平台开启了 Encrypt Key，这里会收到 encrypt 字段。
  // 这份代码没有做解密，所以建议先不要开启 Encrypt Key。
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
      content: '我目前只能处理文本消息。',
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

  // 清空上下文指令
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

  // 保存用户消息
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
    aiReply = 'OpenAI 调用失败，请检查 Railway 的 OPENAI_API_KEY、模型名称、账户额度，以及 Runtime Logs。';
  }

  // 保存 AI 回复
  const updatedHistory = getHistory(sessionId);
  updatedHistory.push({
    role: 'assistant',
    content: aiReply,
  });
  saveHistory(sessionId, updatedHistory);

  // 分段发送，避免单条过长
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

  console.log('本次消息处理完成');
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
  // 如果你在 Railway 配了 FEISHU_VERIFICATION_TOKEN，就会进行校验。
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
