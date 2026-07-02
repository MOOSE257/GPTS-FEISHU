const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ---------- 内存缓存 ----------
let cachedTenantToken = { token: '', expire: 0 };
// 简单内存存储（生产环境建议用数据库）
const historyMap = new Map();
const processedEvents = new Set();

// ---------- 飞书 token ----------
const getTenantToken = async () => {
  if (cachedTenantToken.token && Date.now() < cachedTenantToken.expire) {
    return cachedTenantToken.token;
  }
  const res = await axios.post('https://open.feishu.cn/open-apis/v3/auth/tenant_access_token/internal/', {
    app_id: process.env.FEISHU_APPID,
    app_secret: process.env.FEISHU_SECRET,
  });
  cachedTenantToken = {
    token: res.data.tenant_access_token,
    expire: Date.now() + (res.data.expire - 300) * 1000,
  };
  return cachedTenantToken.token;
};

// ---------- 回复飞书消息 ----------
const feishuReply = async ({ msgId, content, openId }) => {
  const token = await getTenantToken();
  let text = content;
  if (openId) {
    text = `<at user_id="${openId}"></at> ${text}`;
  }
  await axios.post(
    `https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reply`,
    { msg_type: 'text', content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}` } }
  );
};

// ---------- 对话历史（内存版） ----------
function getHistory(sessionId) {
  return historyMap.get(sessionId) || [];
}
function saveHistory(sessionId, messages) {
  const trimmed = messages.slice(-40);
  historyMap.set(sessionId, trimmed);
}

// ---------- OpenAI 流式请求 ----------
const streamOpenAI = async (sessionId, onDelta, onDone) => {
  const messages = getHistory(sessionId);
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: '你是飞书中的 AI 助手，回答简洁准确。' });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      messages,
    }),
  });

  if (!response.body) throw new Error('OpenAI 服务无响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  const processLine = (line) => {
    if (!line.startsWith('data: ')) return;
    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]') {
      onDone(fullContent);
      return;
    }
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        onDelta(delta);
      }
    } catch {}
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        onDone(fullContent);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        processLine(part);
      }
    }
  } catch (err) {
    console.error('OpenAI 流式错误:', err);
    throw err;
  } finally {
    reader.releaseLock();
  }
};

// ---------- 飞书事件回调 ----------
app.post('/feishu/event', async (req, res) => {
  const body = req.body;

  // 飞书首次验证
  if (body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  // 立即返回 200，避免飞书超时重试
  res.json({ code: 0 });

  try {
    const event = body.event;
    if (!event || body.header?.event_type !== 'im.message.receive_v1') return;

    const message = event.message;
    if (message.message_type !== 'text') return;

    let content;
    try {
      const msgContent = JSON.parse(message.content);
      content = msgContent.text?.replace(/@_user_\d+\s*/g, '').trim();
    } catch {
      return;
    }
    if (!content) return;

    const eventId = body.header.event_id;
    const senderOpenId = event.sender.sender_id.open_id;
    const msgId = message.message_id;

    // 幂等
    if (processedEvents.has(eventId)) return;
    processedEvents.add(eventId);
    // 定期清理，防止内存溢出
    if (processedEvents.size > 10000) processedEvents.clear();

    const sessionId = message.chat_id || senderOpenId;

    // 存用户消息
    const history = getHistory(sessionId);
    history.push({ role: 'user', content });
    saveHistory(sessionId, history);

    // 分段配置
    const MAX_LEN = 2000;
    let firstReply = true;

    await streamOpenAI(
      sessionId,
      () => {},
      async (fullReply) => {
        const updatedHistory = getHistory(sessionId);
        updatedHistory.push({ role: 'assistant', content: fullReply });
        saveHistory(sessionId, updatedHistory);

        let remaining = fullReply;
        while (remaining.length > 0) {
          let chunk = remaining;
          if (remaining.length > MAX_LEN) {
            chunk = remaining.slice(0, MAX_LEN);
            const lastBreak = Math.max(
              chunk.lastIndexOf('\n'),
              chunk.lastIndexOf('。'),
              chunk.lastIndexOf(' ')
            );
            if (lastBreak > MAX_LEN / 2) {
              chunk = remaining.slice(0, lastBreak + 1);
            }
            remaining = remaining.slice(chunk.length);
          } else {
            remaining = '';
          }

          const atUser = firstReply ? senderOpenId : null;
          await feishuReply({ msgId, content: chunk, openId: atUser });
          firstReply = false;
        }
      }
    );
  } catch (err) {
    console.error('处理消息出错:', err);
  }
});

// ---------- 启动服务 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feishu GPT Bot running on port ${PORT}`);
});
