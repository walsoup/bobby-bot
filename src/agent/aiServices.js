import { getOpenAIClient, getAIConfig } from './config.js';

function stripThinkTags(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Summarize an array of Discord messages using the active server AI model.
 */
export async function summarizeMessages({ messages = [], guildId = null }) {
  if (messages.length === 0) {
    return 'No messages provided to summarize.';
  }

  const formatted = messages.map((m) => {
    const author = m.author?.username || m.author || 'User';
    const text = (m.content || '').slice(0, 300);
    return `${author}: ${text}`;
  }).join('\n');

  const client = getOpenAIClient({}, guildId);
  const cfg = getAIConfig(guildId);

  const response = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: 'You are an accurate, objective Discord conversation summarizer. Summarize the chat log concisely using markdown bullet points. Highlight key topics discussed, agreements or decisions made, and any pending questions. Keep the tone natural and clean, under 1200 characters.'
      },
      {
        role: 'user',
        content: `Summarize these ${messages.length} channel messages:\n\n${formatted}`
      }
    ],
    max_tokens: 650,
    temperature: 0.3
  });

  const raw = response.choices?.[0]?.message?.content || 'Unable to generate summary.';
  return stripThinkTags(raw);
}

/**
 * Translate arbitrary text into a target language using the server AI model.
 */
export async function translateText({ text, targetLang = 'English', guildId = null }) {
  if (!text || !text.trim()) {
    return 'No text provided for translation.';
  }

  const client = getOpenAIClient({}, guildId);
  const cfg = getAIConfig(guildId);

  const response = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: `You are an expert translator. Translate the text into ${targetLang}. Preserve Discord mentions, code blocks, emojis, and slang. Output ONLY the translated text, without quotes or commentary.`
      },
      {
        role: 'user',
        content: text.trim()
      }
    ],
    max_tokens: 800,
    temperature: 0.2
  });

  const raw = response.choices?.[0]?.message?.content || 'Translation unavailable.';
  return stripThinkTags(raw);
}

/**
 * Analyze an incoming user modmail message and produce a structured triage assessment.
 */
export async function triageModmail({ userMessage, username = 'User', userId = '', guildName = 'Server', guildId = null }) {
  const fallback = {
    summary: userMessage.slice(0, 100),
    severity: 'Medium',
    category: 'Question/Help',
    recommendedAction: 'Review user request and reply via !reply.'
  };

  try {
    const client = getOpenAIClient({}, guildId);
    const cfg = getAIConfig(guildId);

    const response = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        {
          role: 'system',
          content: 'You are a Discord staff triage assistant. Analyze the incoming user message to staff and return ONLY a valid JSON object with keys: "summary" (1 sentence summary), "severity" ("Low" | "Medium" | "High" | "Urgent"), "category" ("Role/Access" | "Question/Help" | "Moderation/Appeal" | "Report" | "Other"), and "recommendedAction" (short suggested staff action).'
        },
        {
          role: 'user',
          content: `Sender: ${username} (ID: ${userId})\nServer: ${guildName}\nMessage:\n"${userMessage}"`
        }
      ],
      max_tokens: 250,
      temperature: 0.1
    });

    const raw = stripThinkTags(response.choices?.[0]?.message?.content || '');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || fallback.summary,
        severity: ['Low', 'Medium', 'High', 'Urgent'].includes(parsed.severity) ? parsed.severity : 'Medium',
        category: parsed.category || fallback.category,
        recommendedAction: parsed.recommendedAction || fallback.recommendedAction
      };
    }
  } catch (err) {
    console.error('[AI Triage Error]', err.message);
  }

  return fallback;
}

/**
 * Generate a natural, casual message to chime in on a channel's recent conversation.
 */
export async function generateChatterMessage({ messages = [], customEmojis = [], guildName = 'Server', guildId = null }) {
  const client = getOpenAIClient({}, guildId);
  const cfg = getAIConfig(guildId);
  const personaMode = cfg?.persona_mode || 'vro';

  let personaGuide = 'You talk casually, friendly, and naturally like a real human on Discord. You are into the "vro" vibe and Mei Mei the cat.';
  if (personaMode === 'serious') {
    personaGuide = 'You speak calmly, directly, and concisely.';
  } else if (personaMode === 'pirate') {
    personaGuide = 'You speak with witty pirate slang and nautical humor.';
  }

  const formatted = messages.slice(-15).map((m) => {
    const author = m.author?.username || m.author || 'User';
    const text = (m.content || '').slice(0, 250);
    return `${author}: ${text}`;
  }).filter((line) => line.trim().length > 0).join('\n');

  const emojiGuide = customEmojis && customEmojis.length > 0
    ? `\nCustom server emojis available:\n${customEmojis.join(' ')}\nYou are explicitly encouraged and preferred to use the server's custom Mei Mei / Tole Tole emojis (like meimei_vro, meimei_stare, meimei_crochat, etc.) to bring out the Tole Tole vibe!`
    : '\nYou love the Mei Mei / Tole Tole cat ("vro") vibe!';

  const systemPrompt = `You are Bobby, hanging out casually in #${guildName}. You are dropping a single message into the chat based on the conversation context.
Rules:
1. Sound like a real human Discord member dropping a comment or thought.
2. Extremely concise (1 to 2 short sentences).
3. Do NOT ping or tag (@) anyone.
4. CUSTOM SERVER EMOJIS PREFERRED: Use the server's custom Mei Mei / Tole Tole emojis freely and frequently to bring out the Tole Tole vibe! Avoid generic unicode emoji spam (no sparkles ✨, rockets 🚀, robots 🤖).
5. ${personaGuide}${emojiGuide}
6. If the channel is talking about a topic, chime in on that topic naturally. If quiet, share a brief casual remark.
7. Output ONLY your message without quotes or prefixes.`;

  const userPrompt = formatted
    ? `Recent messages:\n${formatted}\n\nYour casual comment:`
    : `The channel has been quiet. Drop a brief thought:`;

  try {
    const response = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 150,
      temperature: 0.8
    });

    const raw = response.choices?.[0]?.message?.content || '';
    return stripThinkTags(raw).trim();
  } catch (err) {
    console.error('[AI Chatter Error]', err.message);
    return '';
  }
}
