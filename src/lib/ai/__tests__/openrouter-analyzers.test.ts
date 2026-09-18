import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/providers/factory', () => ({
  buildProvider: vi.fn(),
  resolveApiKey: vi.fn(() => null),
}));

vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock('@/lib/canonical/encryption.server', () => ({
  decryptKey: (k: string) => k,
}));

import { buildProvider } from '@/lib/ai/providers/factory';
import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { routeAI, invalidateProviderCaches } from '@/lib/ai/router.server';
import { callGroq } from '@/lib/groq.server';

function mockDb() {
  const providerRows = [
    {
      id: 'p-groq',
      provider_type: 'groq',
      display_name: 'Groq',
      enabled: true,
      priority: 1,
      base_url: null,
      default_model: 'llama-3.3-70b-specdec',
      secret_name: 'GROQ_API_KEY',
      api_key_encrypted: null,
    },
    {
      id: 'p-openrouter',
      provider_type: 'openrouter',
      display_name: 'OpenRouter',
      enabled: true,
      priority: 2,
      base_url: null,
      default_model: 'deepseek/deepseek-chat-v3:free',
      secret_name: 'OPENROUTER_API_KEY',
      api_key_encrypted: null,
    },
  ];

  const userKeys = [
    { provider: 'groq', encrypted_key: 'groq-key-test', is_active: true, created_at: '2026-01-01' },
    { provider: 'openrouter', encrypted_key: 'openrouter-key-test', is_active: true, created_at: '2026-01-02' },
  ];

  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === 'ai_providers') {
      const c: Record<string, unknown> = {
        select: () => c,
        order: () => Promise.resolve({ data: providerRows, error: null }),
      };
      return c as never;
    }
    if (table === 'user_ai_keys') {
      const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        order: () => Promise.resolve({ data: userKeys, error: null }),
      };
      return c as never;
    }
    if (table === 'ai_task_routing') {
      const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        maybeSingle: () => Promise.resolve({ data: { provider_id: 'p-openrouter', model: 'anthropic/claude-3.5-sonnet' }, error: null }),
      };
      return c as never;
    }
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      order: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return c as never;
  });
}

describe('OpenRouter routing for Legal Analyzing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProviderCaches();
    mockDb();
  });

  it('routes through OpenRouter when forceProvider is set to openrouter', async () => {
    const chatMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({ key_findings: [] }),
      latencyMs: 15,
      model: 'deepseek/deepseek-chat-v3:free',
    });

    vi.mocked(buildProvider).mockImplementation((row) => ({
      type: row.provider_type,
      capabilities: {
        jsonMode: true,
        reasoning: true,
        streaming: false,
        toolCalling: false,
        vision: false,
        maxContextTokens: 60000,
      },
      chat: chatMock,
      testConnection: vi.fn(),
    } as unknown as import("@/lib/ai/providers/types").AIProvider));

    const result = await callGroq({
      apiKey: 'groq-runtime-key',
      forceProvider: 'openrouter',
      task: 'analysis',
      userContent: 'Analyze legal case',
      userId: 'test-user',
      cache: false,
    });

    expect(result.provider).toBe('openrouter');
    expect(chatMock).toHaveBeenCalled();
    const callArg = vi.mocked(buildProvider).mock.calls[0][0];
    expect(callArg.provider_type).toBe('openrouter');
  });

  it('applies task model routing when task is analysis', async () => {
    const chatMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({ result: 'ok' }),
      latencyMs: 10,
      model: 'anthropic/claude-3.5-sonnet',
    });

    vi.mocked(buildProvider).mockImplementation((row) => ({
      type: row.provider_type,
      capabilities: {
        jsonMode: true,
        reasoning: true,
        streaming: false,
        toolCalling: false,
        vision: false,
        maxContextTokens: 60000,
      },
      chat: chatMock,
      testConnection: vi.fn(),
    } as unknown as import("@/lib/ai/providers/types").AIProvider));

    const result = await routeAI({
      forceProvider: 'openrouter',
      task: 'analysis',
      userContent: 'Legal text analysis',
      userId: 'test-user',
      cache: false,
    });

    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe('anthropic/claude-3.5-sonnet');
  });
});
