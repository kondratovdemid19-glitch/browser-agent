import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { BrowserController, type PageState, type ElementInfo } from './browser-controller.js';
import { SYSTEM_PROMPT, TOOLS } from './prompts.js';
import * as readline from 'readline/promises';

// --- Terminal colors ---

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color: string, label: string, msg: string) {
  console.log(`${color}${C.bold}[${label}]${C.reset} ${msg}`);
}

// --- Format page state for the LLM ---

function formatElement(el: ElementInfo): string {
  const parts: string[] = [`[${el.index}]`, `<${el.tag}>`];

  if (el.role && el.role !== el.tag) parts.push(`role="${el.role}"`);
  if (el.type) parts.push(`type="${el.type}"`);
  if (el.text) parts.push(`"${el.text}"`);
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
  if (el.ariaLabel && el.ariaLabel !== el.text)
    parts.push(`aria-label="${el.ariaLabel}"`);
  if (el.title && el.title !== el.text) parts.push(`title="${el.title}"`);
  if (el.href) {
    const short = el.href.length > 70 ? el.href.slice(0, 70) + '...' : el.href;
    parts.push(`href="${short}"`);
  }
  if (el.value) parts.push(`value="${el.value}"`);

  return parts.join(' ');
}

function formatPageState(state: PageState): string {
  const lines: string[] = [
    `URL: ${state.url}`,
    `Title: ${state.title}`,
    `Scroll: ${state.scrollY}/${state.scrollMaxY}px`,
  ];

  if (state.dialogMessage) {
    lines.push(`\n>>> ${state.dialogMessage}`);
  }

  lines.push('', `Interactive elements (${state.elements.length}):`);

  for (const el of state.elements) {
    lines.push('  ' + formatElement(el));
  }

  if (state.elements.length === 0) {
    lines.push('  (no interactive elements found on this page)');
  }

  return lines.join('\n');
}

// --- Agent ---

export class BrowserAgent {
  private client: Anthropic;
  private browser: BrowserController;
  private messages: Anthropic.MessageParam[] = [];
  private rl: readline.Interface;
  private failureCount: Map<string, number> = new Map();

  constructor() {
    if (!config.apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY not set. Create a .env file with your key (see .env.example).',
      );
    }
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.browser = new BrowserController();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    await this.browser.launch();
    log(C.green, 'BROWSER', 'Launched with persistent session');
    log(C.dim, 'INFO', `Model: ${config.model} | Max steps: ${config.maxSteps}`);
  }

  async stop(): Promise<void> {
    await this.browser.close();
    this.rl.close();
    log(C.green, 'BROWSER', 'Closed');
  }

  async prompt(query: string): Promise<string> {
    return this.rl.question(query);
  }

  // --- Main task execution loop ---

  async executeTask(task: string): Promise<void> {
    log(C.cyan, 'TASK', task);
    this.messages = [];
    this.failureCount.clear();

    // Get initial page state
    const initialState = await this.browser.getState();
    const stateText = formatPageState(initialState);

    // First message: task + current page state + screenshot
    this.messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `TASK: ${task}\n\nCurrent page state:\n${stateText}`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: initialState.screenshot,
          },
        },
        {
          type: 'text',
          text: 'Analyze the page and start working on the task. Think step by step.',
        },
      ],
    });

    let consecutiveApiErrors = 0;

    for (let step = 1; step <= config.maxSteps; step++) {
      log(C.blue, `STEP ${step}/${config.maxSteps}`, 'Thinking...');

      // --- Call LLM ---
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: config.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: this.messages,
        });
      } catch (e: any) {
        log(C.red, 'ERROR', `API call failed: ${e.message}`);
        consecutiveApiErrors++;
        if (consecutiveApiErrors >= 3) {
          log(C.red, 'ABORT', 'Too many consecutive API errors, stopping');
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      consecutiveApiErrors = 0;

      // Add assistant response to conversation
      this.messages.push({ role: 'assistant', content: response.content });

      // Extract reasoning and tool call
      let reasoning = '';
      let toolUse: Anthropic.ToolUseBlock | null = null;

      for (const block of response.content) {
        if (block.type === 'text') {
          reasoning += block.text;
        } else if (block.type === 'tool_use') {
          toolUse = block;
        }
      }

      if (reasoning) {
        const display =
          reasoning.length > 600
            ? reasoning.slice(0, 600) + '...'
            : reasoning;
        log(C.magenta, 'THINK', display);
      }

      // No tool call — nudge the model
      if (!toolUse) {
        log(C.yellow, 'WARN', 'No action taken, prompting agent to act');
        this.messages.push({
          role: 'user',
          content: 'Please use one of the available tools to take an action.',
        });
        continue;
      }

      const toolName = toolUse.name;
      const toolInput = toolUse.input as Record<string, any>;

      log(C.yellow, 'ACTION', `${toolName}(${JSON.stringify(toolInput)})`);

      // ===== Handle done =====
      if (toolName === 'done') {
        const summary = toolInput.summary || 'Task completed';
        console.log('');
        log(C.green, 'DONE', summary);
        this.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Task marked as complete.',
            },
          ],
        });
        break;
      }

      // ===== Handle ask_user =====
      if (toolName === 'ask_user') {
        const question = toolInput.question || 'Need more info';
        console.log('');
        log(C.cyan, 'QUESTION', question);
        const answer = await this.prompt(`${C.cyan}> ${C.reset}`);
        log(C.cyan, 'ANSWER', answer);

        const state = await this.browser.getState();
        this.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `User replied: ${answer}`,
            },
            {
              type: 'text',
              text: `Current page state:\n${formatPageState(state)}`,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: state.screenshot,
              },
            },
          ],
        });
        continue;
      }

      // ===== Handle confirm_action (Security Layer) =====
      if (toolName === 'confirm_action') {
        const description = toolInput.action_description;
        const risk = toolInput.risk_level || 'medium';
        const riskIcon: Record<string, string> = {
          medium: '!',
          high: '!!',
          critical: '!!!',
        };

        console.log('');
        console.log(
          `${C.red}${C.bold}${'='.repeat(50)}${C.reset}`,
        );
        log(
          C.red,
          `CONFIRM ${riskIcon[risk] || '!'}`,
          description,
        );
        console.log(
          `${C.red}${C.bold}${'='.repeat(50)}${C.reset}`,
        );

        const answer = await this.prompt(
          `${C.red}${C.bold}Allow this action? (yes/no): ${C.reset}`,
        );
        const allowed = ['yes', 'y', 'да', 'д'].includes(
          answer.toLowerCase().trim(),
        );

        log(allowed ? C.green : C.red, 'USER', allowed ? 'Approved' : 'Denied');

        this.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: allowed
                ? 'User APPROVED the action. You may proceed.'
                : 'User DENIED the action. Do NOT proceed with this action. Ask the user what to do instead or find an alternative.',
            },
          ],
        });
        continue;
      }

      // ===== Handle query_dom (Sub-agent) =====
      if (toolName === 'query_dom') {
        const question = toolInput.question;
        log(C.blue, 'SUB-AGENT', `Analyzing: "${question}"`);

        const answer = await this.queryDomSubAgent(question);
        const displayAnswer =
          answer.length > 300 ? answer.slice(0, 300) + '...' : answer;
        log(C.blue, 'SUB-AGENT', displayAnswer);

        this.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: answer,
            },
          ],
        });
        continue;
      }

      // ===== Execute browser action =====
      const result = await this.executeAction(toolName, toolInput);
      log(C.green, 'RESULT', result);

      // --- Error recovery tracking ---
      const actionKey = `${toolName}:${JSON.stringify(toolInput)}`;
      if (result.includes('failed:') || result.includes('error:')) {
        const count = (this.failureCount.get(actionKey) || 0) + 1;
        this.failureCount.set(actionKey, count);
        if (count >= 3) {
          log(
            C.red,
            'RECOVERY',
            `Same action failed ${count} times — agent will be told to change approach`,
          );
        }
      } else {
        // Reset on success
        this.failureCount.delete(actionKey);
      }

      // --- Get updated page state ---
      const newState = await this.browser.getState();
      const newStateText = formatPageState(newState);

      // Build error recovery hint
      let hint = '';
      const failCount = this.failureCount.get(actionKey) || 0;
      if (failCount >= 2) {
        hint = `\n\nThis action has failed ${failCount} times. Try a completely different approach — different element, different strategy, or go back and start over.`;
      }

      this.messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result + hint,
          },
          {
            type: 'text',
            text: `Updated page state:\n${newStateText}`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: newState.screenshot,
            },
          },
        ],
      });

      // --- Context management: trim old exchanges ---
      this.trimContext();
    }
  }

  // --- Sub-agent for DOM analysis ---

  private async queryDomSubAgent(question: string): Promise<string> {
    try {
      // Get both structured elements and raw text content
      const [textContent, state] = await Promise.all([
        this.browser.getTextContent(),
        this.browser.getState(),
      ]);

      const elementsText = state.elements
        .map((e) => formatElement(e))
        .join('\n');

      const response = await this.client.messages.create({
        model: config.model,
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are a DOM analysis sub-agent. Answer the question about this web page concisely and precisely.

URL: ${state.url}
Title: ${state.title}

Page text content:
${textContent}

Interactive elements:
${elementsText}

Question: ${question}

Answer the question based on what you can see in the page content and screenshot. Be specific — mention element [index] numbers when referring to interactive elements.`,
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: state.screenshot,
                },
              },
            ],
          },
        ],
      });

      const block = response.content[0];
      return block.type === 'text' ? block.text : 'Could not analyze page.';
    } catch (e: any) {
      return `Sub-agent error: ${e.message}`;
    }
  }

  // --- Execute a browser action ---

  private async executeAction(
    name: string,
    input: Record<string, any>,
  ): Promise<string> {
    try {
      switch (name) {
        case 'navigate':
          return await this.browser.navigate(input.url);
        case 'click':
          return await this.browser.click(input.element_id);
        case 'type_text':
          return await this.browser.typeText(
            input.element_id,
            input.text,
            input.press_enter ?? false,
          );
        case 'select_option':
          return await this.browser.selectOption(input.element_id, input.value);
        case 'scroll':
          return await this.browser.scroll(input.direction, input.amount);
        case 'go_back':
          return await this.browser.goBack();
        case 'press_key':
          return await this.browser.pressKey(input.key);
        case 'wait':
          return await this.browser.wait(input.seconds ?? 2);
        default:
          return `Unknown action: ${name}`;
      }
    } catch (e: any) {
      return `Action error: ${e.message}`;
    }
  }

  // --- Context management ---

  private trimContext(): void {
    // Each exchange = assistant message + user message (2 messages per pair)
    // First message [0] is the initial user task message
    // Pairs start at index 1: [1]=assistant, [2]=user, [3]=assistant, [4]=user, ...
    const maxPairs = config.maxContextPairs;
    const pairCount = Math.floor((this.messages.length - 1) / 2);
    if (pairCount <= maxPairs) return;

    const pairsToRemove = pairCount - maxPairs;

    // Collect summaries of removed actions
    const summaryParts: string[] = [];
    const oldMessages = this.messages.slice(1, 1 + pairsToRemove * 2);

    for (const msg of oldMessages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const blocks = msg.content as Anthropic.ContentBlock[];
      const toolBlock = blocks.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (toolBlock) {
        const inputStr = JSON.stringify(toolBlock.input);
        const short =
          inputStr.length > 100 ? inputStr.slice(0, 100) + '...' : inputStr;
        summaryParts.push(`- ${toolBlock.name}(${short})`);
      }
    }

    // Extract original task text
    const firstMsg = this.messages[0];
    let taskText = '';
    if (typeof firstMsg.content === 'string') {
      taskText = firstMsg.content;
    } else if (Array.isArray(firstMsg.content)) {
      const textBlock = firstMsg.content.find(
        (b): b is Anthropic.TextBlockParam => b.type === 'text',
      );
      if (textBlock) taskText = textBlock.text;
    }

    const summary = summaryParts.join('\n');
    const updatedTask = `${taskText}\n\nPREVIOUS ACTIONS (${summaryParts.length} steps summarized):\n${summary}`;

    // Rebuild: updated first message + recent exchanges
    const recentMessages = this.messages.slice(1 + pairsToRemove * 2);
    this.messages = [
      { role: 'user', content: updatedTask },
      ...recentMessages,
    ];

    log(
      C.dim,
      'CONTEXT',
      `Trimmed ${pairsToRemove} old steps, keeping ${maxPairs} recent`,
    );
  }
}
