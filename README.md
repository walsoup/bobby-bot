# Bobby Bot

Bobby is an autonomous Discord community bot, auto-moderator, and AI companion designed for 24/7 uptime on strict resource limits (<100MB RAM).

Supports both `!` and `?` prefixes as well as direct conversational `@Bobby` mentions.

---

## Features

### Moderation & Protection
- **Discipline:** `!warn`, `!warnings`, `!clearwarns`, `!history`, `!timeout`, `!untimeout`, `!kick`, `!ban`, `!unban`, `!softban`, `!nick`.
- **Channel Controls:** `!purge <1-100>`, `!slowmode <secs|off>`, `!lock`, `!unlock`, `!hide`, `!unhide`, `!nuke`.
- **Emergency Lockdown:** `!lockdown` and `!unlockall` for server-wide emergency response.
- **Fast Heuristic Auto-Mod:** Sub-millisecond mass-mention and spam flood dampening without consuming LLM API calls.
- **Permission Auditing:** `!audit` checks administrator privileges, orphan roles, and role hierarchy safety.

### Community Automation
- **Custom Tags:** `!tag <name>`, `!tag add <name> <content>`, `!tag edit`, `!tag delete`, `!tags` with usage counters.
- **Suggestions & Voting:** `!suggest <text>`, staff `!approve <id> [reason]`, and `!deny <id> [reason]` with dynamic embed updates.
- **Ticket System:** `!ticket [reason]` opens private channels for user and staff; `!close` archives; `!transcript` exports text logs.
- **Crash-Resilient Giveaways:** `!gway <time> <winners> <prize>` with human time formats (`30m`, `2h`, `1d`), live reactions (`🎉`), automatic winner selection, and `!reroll`. Survived restarts automatically resume.
- **Starboard:** `!starboard setup <#channel> [threshold]` and `!starboard off` tracks `⭐` reactions and posts pinned highlights.

### Server & Reaction Roles
- **Native Reaction Roles:** Instant role self-assignment on emoji reaction (supports batch mapping).
- **Server Backup & Restore:** `!backup` exports complete configuration (welcome settings, auto-roles, reaction roles, server memories) as JSON. `!restore` imports backups instantly.
- **Server & User Info:** `!serverinfo`, `!channelinfo`, `!userinfo`, `!avatar`, `!members`, `!roles`, `!roleinfo`.
- **Custom Emojis:** `!emojis`, `!enlarge <emoji>`, `!addemoji <name> <url>`, and `!tole` quotes.

### AI Superpowers & Chat Architecture
- **Per-Guild Provider Switcher:** `!model [name]` and `!apiconfig` let you switch models (DeepSeek, OpenAI, OpenRouter, local endpoints) per server without restarting.
- **Discussion Summarizer:** `!summarize [#channel] [count]` (or `!tldr`) extracts bullet-point summaries of recent channel discussions.
- **Multi-Language Translation:** `!translate <lang> <text>` (or `!tr`) translates messages while preserving Discord formatting and mentions.
- **AI Modmail Triage:** Incoming user DMs are forwarded to a staff channel with structured AI triage cards (severity, category, summary, suggested actions) and staff `!reply <userId> <message>`.
- **Dedicated Auto-Response Channel:** `!aichannel #channel` lets Bobby respond to every message in a designated channel without requiring pings.
- **Random Contextual Chatter:** `!chatter set [#ch] <count> <startTime> <endTime>` (e.g. `!chatter set #general 2 10am 11pm`) makes Bobby read chat context and drop casual, human-like comments within specified daily hours.
- **Burst Debounce & Abstract Synthesis:** In auto-chat channels, rapid-fire messages from the same user are buffered (~1.8s) and synthesized into a single coherent prompt before running the agent. Direct `@Bobby` mentions and replies execute immediately with zero delay.

---

## Command Reference

| Category | Commands |
| :--- | :--- |
| **Moderation** | `!warn`, `!warnings`, `!clearwarns`, `!history`, `!timeout`, `!untimeout`, `!kick`, `!ban`, `!unban`, `!softban`, `!nick`, `!purge`, `!slowmode`, `!lock`, `!unlock`, `!hide`, `!unhide`, `!nuke`, `!lockdown`, `!unlockall` |
| **Community** | `!tag`, `!tags`, `!suggest`, `!approve`, `!deny`, `!ticket`, `!close`, `!transcript`, `!gway`, `!reroll`, `!starboard` |
| **Server & Roles** | `!roles`, `!roleinfo`, `!giverole`, `!takerole`, `!emojis`, `!enlarge`, `!addemoji`, `!serverinfo`, `!channelinfo`, `!members`, `!audit`, `!config`, `!backup`, `!restore` |
| **Utility & Fun** | `!remind`, `!poll`, `!choose`, `!math`, `!userinfo`, `!avatar`, `!roll`, `!flip`, `!8ball`, `!tole` |
| **AI & Chat** | `!summarize`, `!translate`, `!modmail`, `!reply`, `!aichannel`, `!chatter`, `!ask`, `!model`, `!apiconfig`, `!mode`, `!remember`, `!recall`, `!memories`, `!forget`, `!about` |

---

## Installation & Setup

### Prerequisites
- Node.js 18+ (tested on Node 20 / 22 / 24)
- A Discord Bot Token from [Discord Developer Portal](https://discord.com/developers/applications) with:
  - **Message Content Intent** (Privileged)
  - **Server Members Intent** (Privileged)

### 1. Clone & Install
```bash
git clone https://github.com/walsoup/bobby-bot.git
cd bobby-bot
npm install
```

### 2. Configure Environment
Copy the example environment file:
```bash
cp .env.example .env
```
Fill in your credentials:
```env
DISCORD_BOT_TOKEN=your_bot_token_here
OWNER_DISCORD_ID=your_discord_user_id

OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=deepseek/deepseek-chat
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

### 3. Run Verification Tests
```bash
npm test
```
All 20 test suites should pass cleanly.

### 4. Start the Bot
```bash
npm start
```

---

## Deployment (Discloud)

Bobby includes a production [`discloud.config`](discloud.config) configured for a 100MB RAM container:

```ini
NAME=BobbyBot
TYPE=bot
MAIN=src/index.js
RAM=100
AUTORESTART=false
VERSION=latest
APT=tools
```

To create a Discloud upload package:
```bash
tar -a -c -f bobby-bot.zip src assets data package.json package-lock.json discloud.config .discloudignore .env
```
Upload `bobby-bot.zip` directly to Discloud via dashboard or CLI.

---

## License

MIT
