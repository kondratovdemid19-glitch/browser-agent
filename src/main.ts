import { BrowserAgent } from './agent.js';

const BANNER = `
\x1b[36m\x1b[1m+------------------------------------------+
|       Browser Agent v1.0                 |
|   Autonomous AI Browser Automation      |
+------------------------------------------+\x1b[0m

Type a task in natural language and watch the agent work.
Commands:
  \x1b[33mexit\x1b[0m / \x1b[33mвыход\x1b[0m  — quit the program
`;

async function main() {
  console.log(BANNER);

  const agent = new BrowserAgent();

  try {
    await agent.start();

    while (true) {
      const task = await agent.prompt('\n\x1b[36m\x1b[1mTask:\x1b[0m ');
      const trimmed = task.trim();

      if (!trimmed) continue;
      if (['exit', 'quit', 'выход', 'q'].includes(trimmed.toLowerCase())) {
        break;
      }

      try {
        await agent.executeTask(trimmed);
      } catch (e: any) {
        console.error(`\x1b[31m[ERROR]\x1b[0m ${e.message}`);
      }
    }
  } finally {
    await agent.stop();
  }

  console.log('\nGoodbye!');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\x1b[31mFatal error:\x1b[0m ${e.message}`);
  process.exit(1);
});
