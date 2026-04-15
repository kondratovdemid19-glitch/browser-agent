# Browser Agent

Autonomous AI agent that controls a web browser to complete complex multi-step tasks.

The agent uses **Claude** (Anthropic API) with tool use to analyze web pages and take actions — navigating, clicking, typing, scrolling — all autonomously, while you watch in a real browser window.

## Features

### Browser Automation (Playwright)
- Visible browser window — watch the agent work in real-time
- **Persistent sessions** — log in manually once, the agent continues with your session across runs
- Numbered element markers overlaid on the page for transparency
- Auto-handling of dialogs, popups, and new tabs

### Autonomous AI Agent (Claude + Tool Use)
- Accepts any task in natural language
- Multi-step reasoning with step-by-step execution
- No hardcoded selectors, URLs, or action sequences — the agent discovers everything by exploring

### Context Management
- Smart extraction of interactive elements (not raw HTML)
- Screenshots for visual understanding
- Automatic context trimming with action summarization when conversation grows

### Advanced Patterns
- **Sub-agent architecture** — `query_dom` tool delegates page analysis to a separate Claude call, extracting full page text content and answering questions about it
- **Security layer** — `confirm_action` tool requires explicit user approval before destructive actions (payments, deletions, form submissions)
- **Error recovery** — tracks repeated failures on same actions and prompts the agent to change strategy

## Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure API key

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 3. Run

```bash
npm start
```

A browser window opens. Type a task in the terminal and watch the agent work.

## Usage Examples

```
Task: Go to google.com and search for "best restaurants in Moscow"

Task: Open hh.ru, find 3 AI engineer vacancies and summarize them

Task: Go to yandex.ru/lavka, find hot dogs, add one to cart

Task: Read the last 10 emails in my inbox and identify spam
```

## Architecture

```
src/
  main.ts              — CLI entry point, readline chat loop
  agent.ts             — Main agent loop: Claude API calls, tool dispatch,
                         sub-agent, security layer, context management
  browser-controller.ts — Playwright wrapper: persistent sessions, element
                         extraction, text extraction, screenshots, actions
  prompts.ts           — System prompt and tool definitions for Claude
  config.ts            — Configuration from environment variables
```

### Agent Loop

1. User types a task
2. Agent extracts interactive elements + takes a screenshot
3. Sends page state to Claude with tool definitions
4. Claude reasons step-by-step and calls exactly one tool
5. Agent executes the action in the browser
6. Repeat until task is done or user intervention needed

### Tools Available to the Agent

| Tool | Description |
|------|-------------|
| `navigate` | Go to a URL |
| `click` | Click an element by index |
| `type_text` | Type into an input field |
| `select_option` | Select from a dropdown |
| `scroll` | Scroll up/down |
| `go_back` | Browser back button |
| `press_key` | Press a keyboard key |
| `wait` | Wait for page updates |
| `query_dom` | Sub-agent: analyze page content |
| `confirm_action` | Security: ask user before destructive actions |
| `ask_user` | Ask the user for information |
| `done` | Mark task as complete |

## Configuration

All settings are in `.env` (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required. Your Anthropic API key |
| `MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `MAX_STEPS` | `50` | Max actions per task |
| `HEADLESS` | `false` | Run browser without UI |
| `VIEWPORT_WIDTH` | `1280` | Browser viewport width |
| `VIEWPORT_HEIGHT` | `900` | Browser viewport height |
| `SCREENSHOT_QUALITY` | `70` | JPEG quality (1-100) |
| `MAX_CONTEXT_PAIRS` | `12` | Max conversation exchanges before trimming |

## Tech Stack

- **TypeScript** + Node.js
- **Playwright** — browser automation
- **Anthropic Claude API** — AI reasoning with tool use
- **tsx** — TypeScript execution without build step
