// Deterministic subprocess fixture: never contacts a provider.
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (prompt.includes('hang'))
  await new Promise((resolve) => setTimeout(resolve, 60000));
else if (prompt.includes('quota-failure')) {
  send({
    type: 'turn.failed',
    error: { message: 'You have hit your usage limit' },
  });
  process.exitCode = 1;
} else if (prompt.includes('coded-failure')) {
  send({
    type: 'turn.failed',
    error: { code: 'usage_limit_reached', message: 'Try again later.' },
  });
  process.exitCode = 1;
} else if (prompt.includes('no-completion')) {
  send({ type: 'thread.started', thread_id: 'fixture' });
} else {
  process.stdout.write('null\n[]\nnot-json\n');
  if (prompt.includes('recovered')) {
    send({ type: 'error', message: '429 rate limit' });
    process.stderr.write('temporary rate limit recovered\n');
  }
  send({ type: 'thread.started', thread_id: 'fixture' });
  send({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'A document mentioning 429 and quota exceeded is not a provider error. Unicode: café ✓',
    },
  });
  send({
    type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}
