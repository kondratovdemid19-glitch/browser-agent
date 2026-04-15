import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { BrowserController, type PageState } from './browser-controller.js';
import { SYSTEM_PROMPT, TOOLS } from './prompts.js';
import { formatElement, formatPageState, truncate } from './formatters.js';
import { log, C, resetTimer, separator } from './logger.js';
import * as readline from 'readline/promises';

// Return type for tool handlers: true = task finished, false = continue
type ToolHandlerResult = boolean;

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

  // ===== Main task execution loop =====

  async executeTask(task: string): Promise<void> {
    log(C.cyan, 'TASK', task);
    this.messages = [];
    this.failureCount.clear();

    await this.initConversation(task);

    let consecutiveApiErrors = 0;

    for (let step = 1; step <= config.maxSteps; step++) {
      resetTimer();
      log(C.blue, `STEP ${step}/${config.maxSteps}`, 'Thinking...');

      const response = await this.callLLM();
      if (!response) {
        consecutiveApiErrors++;
        if (consecutiveApiErrors >= 3) {
          log(C.red, 'ABORT', 'Too many consecutive API errors, stopping');
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      consecutiveApiErrors = 0;

      this.messages.push({ role: 'assistant', content: response.content });

      const { reasoning, toolUse } = this.parseResponse(response);

      if (reasoning) {
        log(C.magenta, 'THINK', truncate(reasoning, 600));
      }

      if (!toolUse) {
        log(C.yellow, 'WARN', 'No action taken, prompting agent to act');
        this.messages.push({
          role: 'user',
          content: 'Please use one of the available tools to take an action.',
        });
        continue;
      }

      log(C.yellow, 'ACTION', `${toolUse.name}(${truncate(JSON.stringify(toolUse.input), 200)})`);

      const taskDone = await this.handleTool(toolUse);
      if (taskDone) break;

      this.trimContext();
    }
  }

  // ===== Conversation setup =====

  private async initConversation(task: string): Promise<void> {
    const state = await this.browser.getState();
    this.messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `TASK: ${task}\n\nCurrent page state:\n${formatPageState(state)}`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: state.screenshot,
          },
        },
        {
          type: 'text',
          text: 'Analyze the page and start working on the task. Think step by step.',
        },
      ],
    });
  }

  // ===== LLM call =====

  private async callLLM(): Promise<Anthropic.Message | null> {
    try {
      return await this.client.messages.create({
        model: config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: this.messages,
      });
    } catch (e: any) {
      log(C.red, 'ERROR', `API call failed: ${e.message}`);
      return null;
    }
  }

  // ===== Response parsing =====

  private parseResponse(response: Anthropic.Message) {
    let reasoning = '';
    let toolUse: Anthropic.ToolUseBlock | null = null;

    for (const block of response.content) {
      if (block.type === 'text') reasoning += block.text;
      else if (block.type === 'tool_use') toolUse = block;
    }

    return { reasoning, toolUse };
  }

  // ===== Tool dispatch =====

  private async handleTool(toolUse: Anthropic.ToolUseBlock): Promise<ToolHandlerResult> {
    const input = toolUse.input as Record<string, any>;

    switch (toolUse.name) {
      case 'done':
        return this.handleDone(toolUse, input);
      case 'ask_user':
        return this.handleAskUser(toolUse, input);
      case 'confirm_action':
        return this.handleConfirmAction(toolUse, input);
      case 'query_dom':
        return this.handleQueryDom(toolUse, input);
      default:
        return this.handleBrowserAction(toolUse, input);
    }
  }

  // ----- done -----

  private async handleDone(
    toolUse: Anthropic.ToolUseBlock,
    input: Record<string, any>,
  ): Promise<ToolHandlerResult> {
    const summary = input.summary || 'Task completed';
    console.log('');
    log(C.green, 'DONE', summary);
    this.pushToolResult(toolUse.id, 'Task marked as complete.');
    return true;
  }

  // ----- ask_user -----

  private async handleAskUser(
    toolUse: Anthropic.ToolUseBlock,
    input: Record<string, any>,
  ): Promise<ToolHandlerResult> {
    console.log('');
    log(C.cyan, 'QUESTION', input.question || 'Need more info');
    const answer = await this.prompt(`${C.cyan}> ${C.reset}`);
    log(C.cyan, 'ANSWER', answer);

    const state = await this.browser.getState();
    this.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUse.id, content: `User replied: ${answer}` },
        { type: 'text', text: `Current page state:\n${formatPageState(state)}` },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: state.screenshot },
        },
      ],
    });
    return false;
  }

  // ----- confirm_action (Security Layer) -----

  private async handleConfirmAction(
    toolUse: Anthropic.ToolUseBlock,
    input: Record<string, any>,
  ): Promise<ToolHandlerResult> {
    const risk = input.risk_level || 'medium';
    const icons: Record<string, string> = { medium: '!', high: '!!', critical: '!!!' };

    separator(C.red);
    log(C.red, `CONFIRM ${icons[risk] || '!'}`, input.action_description);
    separator(C.red);

    const answer = await this.prompt(`${C.red}${C.bold}Allow this action? (yes/no): ${C.reset}`);
    const allowed = ['yes', 'y', 'да', 'д'].includes(answer.toLowerCase().trim());

    log(allowed ? C.green : C.red, 'USER', allowed ? 'Approved' : 'Denied');

    this.pushToolResult(
      toolUse.id,
      allowed
        ? 'User APPROVED the action. You may proceed.'
        : 'User DENIED the action. Do NOT proceed. Ask the user what to do instead.',
    );
    return false;
  }

  // ----- query_dom (Sub-agent) -----

  private async handleQueryDom(
    toolUse: Anthropic.ToolUseBlock,
    input: Record<string, any>,
  ): Promise<ToolHandlerResult> {
    const question = input.question;
    log(C.blue, 'SUB-AGENT', `Analyzing: "${truncate(question, 100)}"`);

    const answer = await this.runDomSubAgent(question);
    log(C.blue, 'SUB-AGENT', truncate(answer, 300));

    this.pushToolResult(toolUse.id, answer);
    return false;
  }

  // ----- Browser actions (navigate, click, type, etc.) -----

  private async handleBrowserAction(
    toolUse: Anthropic.ToolUseBlock,
    input: Record<string, any>,
  ): Promise<ToolHandlerResult> {
    const result = await this.executeBrowserAction(toolUse.name, input);
    log(C.green, 'RESULT', result);

    // Error recovery tracking
    const actionKey = `${toolUse.name}:${JSON.stringify(input)}`;
    this.trackFailure(actionKey, result);

    const state = await this.browser.getState();
    const hint = this.getFailureHint(actionKey);

    this.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUse.id, content: result + hint },
        { type: 'text', text: `Updated page state:\n${formatPageState(state)}` },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: state.screenshot },
        },
      ],
    });
    return false;
  }

  // ===== Sub-agent =====

  private async runDomSubAgent(question: string): Promise<string> {
    try {
      const [textContent, state] = await Promise.all([
        this.browser.getTextContent(),
        this.browser.getState(),
      ]);

      const elementsText = state.elements.map((e) => formatElement(e)).join('\n');

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

Be specific — mention element [index] numbers when referring to interactive elements.`,
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: state.screenshot },
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

  // ===== Browser action dispatch =====

  private async executeBrowserAction(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case 'navigate':     return await this.browser.navigate(input.url);
        case 'click':        return await this.browser.click(input.element_id);
        case 'type_text':    return await this.browser.typeText(input.element_id, input.text, input.press_enter ?? false);
        case 'select_option': return await this.browser.selectOption(input.element_id, input.value);
        case 'hover':        return await this.browser.hover(input.element_id);
        case 'scroll':       return await this.browser.scroll(input.direction, input.amount);
        case 'go_back':      return await this.browser.goBack();
        case 'press_key':    return await this.browser.pressKey(input.key);
        case 'wait':         return await this.browser.wait(input.seconds ?? 2);
        default:             return `Unknown action: ${name}`;
      }
    } catch (e: any) {
      return `Action error: ${e.message}`;
    }
  }

  // ===== Error recovery =====

  private trackFailure(actionKey: string, result: string): void {
    if (result.includes('failed:') || result.includes('error:')) {
      const count = (this.failureCount.get(actionKey) || 0) + 1;
      this.failureCount.set(actionKey, count);
      if (count >= 3) {
        log(C.red, 'RECOVERY', `Same action failed ${count} times`);
      }
    } else {
      this.failureCount.delete(actionKey);
    }
  }

  private getFailureHint(actionKey: string): string {
    const count = this.failureCount.get(actionKey) || 0;
    if (count < 2) return '';
    return `\n\nThis action has failed ${count} times. Try a completely different approach — different element, different strategy, or go back and start over.`;
  }

  // ===== Helpers =====

  private pushToolResult(toolUseId: string, content: string): void {
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    });
  }

  // ===== Context management =====

  private trimContext(): void {
    const maxPairs = config.maxContextPairs;
    const pairCount = Math.floor((this.messages.length - 1) / 2);
    if (pairCount <= maxPairs) return;

    const pairsToRemove = pairCount - maxPairs;

    // Summarize removed actions
    const summaryParts: string[] = [];
    const oldMessages = this.messages.slice(1, 1 + pairsToRemove * 2);

    for (const msg of oldMessages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const blocks = msg.content as Anthropic.ContentBlock[];
      const toolBlock = blocks.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (toolBlock) {
        summaryParts.push(`- ${toolBlock.name}(${truncate(JSON.stringify(toolBlock.input), 100)})`);
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

    const recentMessages = this.messages.slice(1 + pairsToRemove * 2);
    this.messages = [{ role: 'user', content: updatedTask }, ...recentMessages];

    log(C.dim, 'CONTEXT', `Trimmed ${pairsToRemove} old steps, keeping ${maxPairs} recent`);
  }
}
