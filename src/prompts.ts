import Anthropic from '@anthropic-ai/sdk';

// --- System prompt ---

export const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real web browser to complete tasks given by the user.

## How you see the page

Each step you receive:
- Current URL and page title
- A numbered list of interactive elements visible on the page
- A screenshot of the current viewport

Elements are listed as:
  [index] <tag> "visible text" (attributes)

## Rules

1. Analyze BOTH the element list AND the screenshot before acting.
2. Use EXACTLY ONE tool per response.
3. Think step-by-step before each action — write your reasoning as text BEFORE the tool call.
4. Never hardcode URLs, selectors, or page-specific knowledge — discover everything by exploring the page.
5. Scroll to find elements not currently visible.
6. Use search features on websites when looking for specific content.
7. If stuck after 2-3 failed attempts on the same approach, try something completely different (go back, different page, rephrase query, use keyboard navigation).
8. Ask the user (ask_user) ONLY when you genuinely need information you cannot find (credentials, personal preferences, ambiguous choices).
9. When the task is fully complete, call done with a summary of everything accomplished.

## Security Rules — IMPORTANT

Before performing any potentially destructive or irreversible action, you MUST call confirm_action first. Examples of when to confirm:
- Submitting a payment or placing an order
- Deleting emails, files, or data
- Sending messages or submitting forms with real consequences
- Applying for jobs or submitting applications
- Any action involving real money or personal data submission

NEVER proceed with destructive actions without calling confirm_action and receiving approval.

## Sub-agent: query_dom

Use the query_dom tool when you need to:
- Find specific text content on the page that is not in the interactive elements list
- Understand the page layout or content in detail
- Search for information in page text (prices, descriptions, addresses, etc.)
- Determine which elements to interact with based on surrounding context

## Tips

- To search: navigate to a website, find the search input, type a query, press Enter.
- To fill forms: fill fields one at a time, then submit.
- Cookie/consent banners: dismiss them if they block interaction.
- Pop-ups and modals: close them before interacting with the page behind them.
- If a click opens a new tab, the agent automatically switches to it.
- Read page content using query_dom or from the screenshot for non-interactive text.
- When a dialog (alert/confirm) appears, it is auto-dismissed and the message is shown to you.`;

// --- Tool definitions ---

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'navigate',
    description:
      'Navigate the browser to a URL. Use full URLs with protocol (https://...).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description:
      'Click on an interactive element by its [index] number from the elements list.',
    input_schema: {
      type: 'object' as const,
      properties: {
        element_id: {
          type: 'integer',
          description: 'The [index] of the element to click',
        },
      },
      required: ['element_id'],
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into an input/textarea. Clears existing content first, then types. Optionally presses Enter after (useful for search).',
    input_schema: {
      type: 'object' as const,
      properties: {
        element_id: {
          type: 'integer',
          description: 'The [index] of the input element',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        press_enter: {
          type: 'boolean',
          description: 'Press Enter after typing (default: false)',
        },
      },
      required: ['element_id', 'text'],
    },
  },
  {
    name: 'select_option',
    description: 'Select an option from a <select> dropdown by visible label or value.',
    input_schema: {
      type: 'object' as const,
      properties: {
        element_id: {
          type: 'integer',
          description: 'The [index] of the <select> element',
        },
        value: {
          type: 'string',
          description: 'The option label or value to select',
        },
      },
      required: ['element_id', 'value'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to see more content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Scroll direction',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'go_back',
    description: 'Go back to the previous page in browser history.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'press_key',
    description:
      'Press a keyboard key (Enter, Escape, Tab, ArrowDown, ArrowUp, etc.).',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: 'Key name to press',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for the page to update (e.g., after dynamic content load).',
    input_schema: {
      type: 'object' as const,
      properties: {
        seconds: {
          type: 'number',
          description: 'Seconds to wait (max 10)',
        },
      },
    },
  },
  {
    name: 'query_dom',
    description:
      'Ask a sub-agent to analyze the full page content and answer a question. The sub-agent sees the page text, interactive elements, and a screenshot. Use this to find specific info, understand layout, or locate elements by surrounding context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'Question about the page content or structure',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'confirm_action',
    description:
      'Ask the user for confirmation before performing a destructive or irreversible action (payment, deletion, sending messages, applying for jobs, etc.). MUST be called before any such action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action_description: {
          type: 'string',
          description: 'Clear description of what will happen if the user approves',
        },
        risk_level: {
          type: 'string',
          enum: ['medium', 'high', 'critical'],
          description: 'Risk level: medium (reversible but notable), high (hard to undo), critical (involves money/deletion)',
        },
      },
      required: ['action_description'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user for information or clarification. Use ONLY when you cannot proceed without user input (credentials, personal preferences, ambiguous choices).',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'The question for the user',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'done',
    description: 'Signal that the task is complete. Provide a brief summary of what was accomplished.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of what was accomplished',
        },
      },
      required: ['summary'],
    },
  },
];
