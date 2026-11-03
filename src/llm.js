const { tools: actionTools } = require('./aiTools');

const MAX_TOOL_CALLS = 3;

function getLlmConfig(env = process.env) {
  return {
    enabled: /^(1|true|yes)$/i.test(env.LLM_ENABLED || ''),
    baseUrl: (env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || 'ollama',
    model: env.LLM_MODEL || '',
    timeoutMs: Math.max(5_000, Math.min(120_000, Number(env.LLM_TIMEOUT_MS) || 45_000)),
  };
}

class LlmClient {
  constructor(config = getLlmConfig()) {
    this.config = config;
  }

  isConfigured() {
    return this.config.enabled && Boolean(this.config.model);
  }

  async complete(messages, { withTools = false } = {}) {
    if (!this.isConfigured()) {
      throw new Error('LLM is disabled or missing LLM_MODEL configuration.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...(withTools ? { tools: actionTools, tool_choice: 'auto' } : {}),
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data.error?.message || data.message || `HTTP ${response.status}`;
        throw new Error(`LLM request failed: ${detail}`);
      }
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('The LLM returned an empty response.');
      return message;
    } finally {
      clearTimeout(timeout);
    }
  }

  async respond({ system, user, context, executeTool }) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Game context (JSON): ${JSON.stringify(context)}\n\nPlayer: ${user}` },
    ];
    for (let callCount = 0; callCount < MAX_TOOL_CALLS; callCount += 1) {
      const message = await this.complete(messages, { withTools: true });
      if (!message.tool_calls?.length) return message.content?.trim() || 'I am not sure what to do.';
      messages.push(message);
      const calls = message.tool_calls.slice(0, MAX_TOOL_CALLS - callCount);
      let requiresApproval = false;
      for (const call of calls) {
        let args;
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        const result = await executeTool(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (result.requiresApproval) requiresApproval = true;
      }
      if (requiresApproval) break;
    }
    const finalMessage = await this.complete(messages);
    return finalMessage.content?.trim() || 'I have prepared the next step.';
  }
}

module.exports = { LlmClient, getLlmConfig };
