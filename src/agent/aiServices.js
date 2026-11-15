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
7. NO "STAFF" JARGON: Never mention or talk about "the staff" or "staff team". You are just a casual homie hanging out.
8. Output ONLY your message without quotes or prefixes.`;

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

// ---------------------------------------------------------------------------
// Fallback Pools for Trivia & Riddles (Resilience when offline or rate-limited)
// ---------------------------------------------------------------------------

export const FALLBACK_TRIVIA_QUESTIONS = [
  {
    question: 'What was the original name of Mario when he first debuted in the 1981 arcade game Donkey Kong?',
    topic: 'Gaming',
    difficulty: 'Medium',
    options: [
      { key: 'A', text: 'Luigi' },
      { key: 'B', text: 'Jumpman' },
      { key: 'C', text: 'Plumber Pete' },
      { key: 'D', text: 'Red Hat' }
    ],
    correctKey: 'B',
    explanation: 'Shigeru Miyamoto originally named him Jumpman before Nintendo of America renamed him Mario after their landlord Mario Segale.'
  },
  {
    question: 'Which planet in our solar system has the most confirmed moons as recognized by the IAU?',
    topic: 'Science',
    difficulty: 'Medium',
    options: [
      { key: 'A', text: 'Jupiter' },
      { key: 'B', text: 'Saturn' },
      { key: 'C', text: 'Uranus' },
      { key: 'D', text: 'Neptune' }
    ],
    correctKey: 'B',
    explanation: 'Saturn leads our solar system with over 140 confirmed moons, overtaking Jupiter in recent astronomical discoveries.'
  },
  {
    question: 'In Minecraft, which item is required alongside obsidian and diamonds to craft an Enchantment Table?',
    topic: 'Gaming',
    difficulty: 'Easy',
    options: [
      { key: 'A', text: 'Book' },
      { key: 'B', text: 'Ender Pearl' },
      { key: 'C', text: 'Lapis Lazuli' },
      { key: 'D', text: 'Gold Ingot' }
    ],
    correctKey: 'A',
    explanation: 'You need 1 Book placed at the top, 2 Diamonds, and 4 Obsidian blocks to craft an Enchantment Table vro.'
  },
  {
    question: 'What is the official national animal of Scotland?',
    topic: 'Geography & Culture',
    difficulty: 'Hard',
    options: [
      { key: 'A', text: 'Red Deer' },
      { key: 'B', text: 'Golden Eagle' },
      { key: 'C', text: 'Unicorn' },
      { key: 'D', text: 'Highland Cow' }
    ],
    correctKey: 'C',
    explanation: 'The mythical unicorn has been a Scottish heraldic symbol since the 12th century and remains Scotland’s official national animal.'
  },
  {
    question: 'What does the abbreviation "HTTP" stand for in web network protocols?',
    topic: 'Technology',
    difficulty: 'Easy',
    options: [
      { key: 'A', text: 'HyperText Transfer Protocol' },
      { key: 'B', text: 'High Tech Transport Process' },
      { key: 'C', text: 'HyperText Technical Program' },
      { key: 'D', text: 'Host To Terminal Packet' }
    ],
    correctKey: 'A',
    explanation: 'HTTP stands for HyperText Transfer Protocol, the foundational protocol used for data transmission across the World Wide Web.'
  }
];

export const FALLBACK_RIDDLES = [
  {
    riddle: 'I have cities, but no houses.\nI have mountains, but no trees.\nI have water, but no fish.\nWhat am I?',
    theme: 'Everyday Objects',
    acceptedAnswers: ['map', 'a map', 'atlas', 'an atlas'],
    hint: 'You unfold me or zoom in on me to find your way.',
    explanation: 'A map depicts cities, mountains, and oceans without living beings or structures.'
  },
  {
    riddle: 'The more of me you take, the more you leave behind.\nWhat am I?',
    theme: 'Concepts',
    acceptedAnswers: ['footsteps', 'footstep', 'steps', 'step'],
    hint: 'Look down behind you as you walk along the beach.',
    explanation: 'Every step you take leaves behind another footstep in your path.'
  },
  {
    riddle: 'I speak without a mouth and hear without ears.\nI have no body, but I come alive with wind.\nWhat am I?',
    theme: 'Nature',
    acceptedAnswers: ['echo', 'an echo'],
    hint: 'Shout into a canyon and I will shout right back.',
    explanation: 'An echo is sound bouncing back off surfaces without physical form.'
  },
  {
    riddle: 'I have keys, but no locks.\nI have space, but no room.\nYou can enter, but you can never go outside.\nWhat am I?',
    theme: 'Technology',
    acceptedAnswers: ['keyboard', 'a keyboard', 'computer keyboard'],
    hint: 'You are likely using one right now to type messages in chat.',
    explanation: 'A computer keyboard has letter keys, a space bar, and an Enter key.'
  },
  {
    riddle: 'I am tall when I am young, and I am short when I am old.\nWhat am I?',
    theme: 'Everyday Objects',
    acceptedAnswers: ['candle', 'a candle', 'pencil', 'a pencil'],
    hint: 'I melt away as I bring light to the dark.',
    explanation: 'A candle burns down from tall to short as time passes.'
  }
];

/**
 * Generate an interactive AI multiple-choice trivia question.
 */
export async function generateTriviaQuestion({ topic = 'general', difficulty = 'Medium', guildId = null } = {}) {
  const cfg = getAIConfig(guildId);
  const client = getOpenAIClient({}, guildId);

  const systemPrompt = `You are Bobby's Trivia Engine. Generate an engaging, high-quality multiple choice trivia question.
Return ONLY valid JSON matching this exact structure with NO markdown or extra text wrappers:
{
  "question": "The question text",
  "topic": "The category or topic name",
  "difficulty": "Easy" | "Medium" | "Hard",
  "options": [
    { "key": "A", "text": "Option 1" },
    { "key": "B", "text": "Option 2" },
    { "key": "C", "text": "Option 3" },
    { "key": "D", "text": "Option 4" }
  ],
  "correctKey": "A" | "B" | "C" | "D",
  "explanation": "A short, fun 1-2 sentence explanation of why this answer is correct in Bobby's casual vro style."
}`;

  const userPrompt = topic && topic.toLowerCase() !== 'general' && topic.toLowerCase() !== 'random'
    ? `Generate a ${difficulty} trivia question about: ${topic}.`
    : `Generate a fun, surprising ${difficulty} trivia question on a random interesting topic (gaming, pop culture, science, geography, history, anime, music).`;

  try {
    const response = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 500,
      temperature: 0.8
    });

    const raw = stripThinkTags(response.choices?.[0]?.message?.content || '');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI returned non-JSON output');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length !== 4 || !parsed.correctKey) {
      throw new Error('AI returned incomplete trivia structure');
    }
    return parsed;
  } catch (err) {
    const pool = FALLBACK_TRIVIA_QUESTIONS;
    const item = pool[Math.floor(Math.random() * pool.length)];
    return { ...item, topic: topic && topic !== 'general' ? topic : item.topic };
  }
}

/**
 * Generate an interactive AI riddle with accepted answer keywords and hint.
 */
export async function generateRiddle({ theme = 'general', guildId = null } = {}) {
  const cfg = getAIConfig(guildId);
  const client = getOpenAIClient({}, guildId);

  const systemPrompt = `You are Bobby's Riddle Master. Generate a clever, poetic, original riddle.
Return ONLY valid JSON matching this exact structure with NO markdown or extra text wrappers:
{
  "riddle": "The riddle lines (2-4 lines of poetic or clever clues)",
  "theme": "The theme or subject category",
  "acceptedAnswers": ["main answer", "alternative answer 1", "alternative answer 2"],
  "hint": "A subtle, helpful clue that doesn't give away the whole answer",
  "explanation": "Brief explanation of the answer in Bobby's chill style"
}`;

  const userPrompt = theme && theme.toLowerCase() !== 'general' && theme.toLowerCase() !== 'random'
    ? `Generate a clever riddle themed around: ${theme}.`
    : `Generate a fun, clever, engaging riddle on a classic or everyday object, concept, or element.`;

  try {
    const response = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 500,
      temperature: 0.85
    });

    const raw = stripThinkTags(response.choices?.[0]?.message?.content || '');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI returned non-JSON output');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.riddle || !Array.isArray(parsed.acceptedAnswers) || parsed.acceptedAnswers.length === 0) {
      throw new Error('AI returned incomplete riddle structure');
    }
    return parsed;
  } catch (err) {
    const pool = FALLBACK_RIDDLES;
    const item = pool[Math.floor(Math.random() * pool.length)];
    return { ...item, theme: theme && theme !== 'general' ? theme : item.theme };
  }
}
