import { config } from 'dotenv';
import twilio from 'twilio';
import {
  TAC,
  TACConfig,
  VoiceChannel,
  ConversationSession,
  ConversationId,
  ChannelType,
  ProfileId,
  TACServer,
  TACTool,
  defineTool,
} from 'twilio-agent-connect';
import { Agent, AgentInputItem, run, setTracingDisabled } from '@openai/agents';
import { systemPrompt } from './systemPrompt.js';
import { makeValidatePhoneNumberTool } from './tools/validatePhoneNumber.js';
import { makeSendCallbackEmailTool } from './tools/sendCallbackEmail.js';
import { makeEndCallTool, endCallForCaller } from './tools/endCall.js';
import { clearState, getState } from './state.js';

//config({ path: '../.env', override: false });
setTracingDisabled(true);

// ---------------------------------------------------------------------------
// Boot-time env validation — fail fast instead of breaking mid-call
// ---------------------------------------------------------------------------
const REQUIRED_ENV_VARS = ['SENDGRID_API_KEY'] as const;
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`FATAL: missing required env var ${key}. Refusing to start.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Global safety net — a bug in a fire-and-forget call should never take
// down every in-progress call on this process.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const tac = await TAC.create({ config: TACConfig.fromEnv() });

const voiceChannel = new VoiceChannel(tac, {
  defaultTwimlOptions: {
    welcomeGreeting: "Thanks for calling Lacey's Plumbing — this is James speaking. How can I help you today?",
    ttsProvider: 'ElevenLabs',
    voice: 'hmMWXCj9K7N5mCPcRkfC',
    transcriptionProvider: 'Deepgram',
    //speechModel: 'nova-3-general',
    // speechTimeout: 'auto',
    // eotThreshold: 0.5,
    //transcriptionProvider: 'Google',
    interruptSensitivity: 'low', // revisar para 'medium' só depois de validar o fix do abortSignal em produção
    ignoreBackchannel: true,
  },
});

tac.registerChannel(voiceChannel);

const conversationHistory: Record<string, AgentInputItem[]> = {};
const agentCache: Record<string, Agent> = {};
const lastActivity: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Tool safety wrapper — impede que uma exceção dentro de uma tool derrube o
// run() inteiro (o que faria conversationHistory nunca ser gravado, e o app
// "esquecer" a mensagem daquele turno). Reconstrói via defineTool() em vez
// de spread, porque TACTool é uma classe — um spread perderia os métodos do
// protótipo (toOpenAIAgentsSDKTool, etc).
// ---------------------------------------------------------------------------
function safeTool<P, R>(tool: TACTool<P, R>): TACTool<P, R> {
  return defineTool<P, R>(
    tool.name,
    tool.description,
    tool.parameters,
    async (params: P) => {
      try {
        return await tool.implementation(params);
      } catch (err) {
        console.error(`[tool:${tool.name}] threw an unexpected error:`, err);
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as R;
      }
    },
  );
}

async function getOrCreateAgent(convId: string, callerAddress: string | undefined): Promise<Agent> {
  if (agentCache[convId]) return agentCache[convId];

  const tools = [
    await safeTool(makeValidatePhoneNumberTool()).toOpenAIAgentsSDKTool(),
    await safeTool(makeSendCallbackEmailTool(convId)).toOpenAIAgentsSDKTool(),
    await safeTool(makeEndCallTool(callerAddress)).toOpenAIAgentsSDKTool(),
  ];

  const agent = new Agent({
    name: "James — Lacey's Assistant",
    instructions: systemPrompt,
    model: 'gpt-5.4-nano',
    //model: 'gpt-5.5',
    //modelSettings: { temperature: 1 },
    tools,
  });

  agentCache[convId] = agent;
  return agent;
}

// ---------------------------------------------------------------------------
// Call recording helpers
// ---------------------------------------------------------------------------
function getTwilioClient() {
  return twilio(process.env.TWILIO_API_KEY!, process.env.TWILIO_API_SECRET!, {
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
  });
}

const recordingStarted = new Set<string>();

async function startRecordingIfNeeded(conversationId: string, callerAddress: string | undefined): Promise<void> {
  if (!callerAddress || recordingStarted.has(conversationId)) return;
  recordingStarted.add(conversationId);

  try {
    const client = getTwilioClient();
    const calls = await client.calls.list({ from: callerAddress, status: 'in-progress', limit: 1 });
    if (calls.length === 0) {
      console.warn(`[recording] No in-progress call found for from=${callerAddress}`);
      recordingStarted.delete(conversationId);
      return;
    }
    const callSid = calls[0]!.sid;
    await client.calls(callSid).recordings.create({ recordingTrack: 'both' });
    console.log(`[recording] Started for call ${callSid}`);
  } catch (err) {
    console.error(`[recording] Failed to start for from=${callerAddress}:`, err);
    recordingStarted.delete(conversationId);
  }
}

// ---------------------------------------------------------------------------
// Fallback safety net — if the call ends before the model ever calls
// send_callback_email (hangup, crash, agent got stuck), fire the email
// anyway with whatever we managed to capture, so the lead isn't lost.
// ---------------------------------------------------------------------------
async function sendFallbackEmail(convId: string, state: ReturnType<typeof getState>): Promise<void> {
  try {
    const tool = makeSendCallbackEmailTool(convId);
    await tool.implementation({
      name: state.callerName || '',
      phone: state.callbackNumber || state.callerNumber || '',
      transcription: state.callReason || '(call ended before details were fully captured)',
    });
  } catch (err) {
    console.error(`[${convId}] Fallback email failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------
async function handleMessageReady(params: {
  conversationId: ConversationId;
  profileId: ProfileId | undefined;
  message: string;
  author: string;
  session: ConversationSession;
  channel: ChannelType;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const { conversationId, message, session, abortSignal } = params;
  const convId = conversationId as string;
  lastActivity[convId] = Date.now();

  const callerNumber = session.authorInfo?.address ?? '';
  const state = getState(convId);
  if (!state.callerNumber && callerNumber) {
    state.callerNumber = callerNumber;
  }

  // The goodbye/end_call has a few seconds of grace period (see
  // endCallForCaller) before the call is actually disconnected. If the
  // caller says anything more in that window, don't run the agent again —
  // the conversation is already considered closed.
  if (state.callEnding) {
    console.log(`[${convId}] Message received after call was already ending — ignoring: "${message}"`);
    return undefined;
  }

  void startRecordingIfNeeded(convId, session.authorInfo?.address);

  console.log(`[${convId}] Customer said: ${message}`);
  const t0 = Date.now();

  const agent = await getOrCreateAgent(convId, session.authorInfo?.address);

  const history = conversationHistory[convId] ?? [];
  const agentInput: AgentInputItem[] = [
    ...history,
    {
      role: 'user',
      content: `[Caller number on file: ${state.callerNumber || 'unknown'}]\n${message}`,
    },
  ];

  const t1 = Date.now();
  let result;
  try {
    result = await run(agent, agentInput, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) {
      console.log(`[${convId}] Turn aborted due to interrupt — discarding, not committing history.`);
      return undefined;
    }
    console.error(`[${convId}] Agent run() threw an error:`, err);
    return 'Sorry, I ran into a problem. Could you say that again?';
  }

  if (abortSignal?.aborted) {
    console.log(`[${convId}] Turn completed but was already interrupted — discarding, not committing history.`);
    return undefined;
  }

  const t2 = Date.now();
  console.log(
    `[${convId}] TIMING setup=${t1 - t0}ms agentRun=${t2 - t1}ms total=${t2 - t0}ms history=${history.length}->${result.history.length}`,
  );

  conversationHistory[convId] = result.history;

  let finalOutput = result.finalOutput;
  if (!finalOutput) {
    finalOutput = "Sorry about that — could you repeat that for me?";
    console.warn(`[${convId}] Empty response from model, using fallback.`);
  }

  console.log(`[${convId}] Assistant said: "${finalOutput}"`);

  const EXACT_CLOSING_LINE =
    "Thanks for calling Lacey's — someone will be in touch with you shortly. Goodbye!";
  const soundsLikeFarewell =
    /goodbye|bye\b|take care|talk soon|have a good|all the best|call.{0,20}(has been |is |now )?end(ed)?|details.{0,20}(sent|through|passed)|successfully (sent|ended)|someone will be in touch/i.test(
      finalOutput,
    );

  // Only trust the farewell heuristic once the call has actually reached
  // Step 6 (email sent). Earlier in the conversation, routine phrasing
  // (e.g. "I'll make sure your details get passed on") can accidentally
  // match the regex and would otherwise force a premature hangup before
  // name/number/email were ever collected.
  if (soundsLikeFarewell && state.emailSent) {
    if (finalOutput.trim() !== EXACT_CLOSING_LINE) {
      console.log(
        `[${convId}] Safety net: model's farewell ("${finalOutput}") didn't match the exact script — overriding.`,
      );
      finalOutput = EXACT_CLOSING_LINE;
    }
    console.log(`[${convId}] Safety net: forcing end_call.`);
    state.callEnding = true;
    void endCallForCaller(session.authorInfo?.address);
  } else if (soundsLikeFarewell && !state.emailSent) {
    console.log(
      `[${convId}] Safety net: response sounded like a farewell but emailSent is still false — ignoring, not ending call.`,
    );
  }

  return finalOutput;
}

tac.onMessageReady(handleMessageReady);

tac.onInterrupt(({ conversationId, utteranceUntilInterrupt, durationUntilInterruptMs }) => {
  console.log(
    `[${conversationId}] Interrupted after ${durationUntilInterruptMs}ms. Caller said: "${utteranceUntilInterrupt}"`,
  );
});

const endedConversations = new Set<string>();
tac.onConversationEnded(async ({ session }) => {
  const convId = session.conversationId;
  if (endedConversations.has(convId)) return;
  endedConversations.add(convId);
  console.log(`Conversation ${convId} ended`);

  // Safety net: if the call ended (hangup, crash, whatever) before
  // send_callback_email was ever called, but we already captured at least
  // a phone number, fire a fallback email so the lead isn't silently lost.
  const state = getState(convId);
  if (!state.emailSent && (state.callbackNumber || state.callerNumber)) {
    console.warn(`[${convId}] Call ended without email being sent — sending fallback with partial data.`);
    void sendFallbackEmail(convId, state);
  }

  delete conversationHistory[convId];
  delete agentCache[convId];
  delete lastActivity[convId];
  recordingStarted.delete(convId);
  endedConversations.delete(convId);
  clearState(convId);
});

// ---------------------------------------------------------------------------
// Watchdog: limpa conversas que nunca dispararam onConversationEnded (ex:
// webhook perdido, múltiplas instâncias do Fly.io).
// ---------------------------------------------------------------------------
const STALE_MS = 2 * 60 * 60 * 1000; // 2 horas
setInterval(() => {
  const now = Date.now();
  for (const convId of Object.keys(lastActivity)) {
    if (now - lastActivity[convId]! > STALE_MS) {
      console.warn(`[watchdog] Cleaning up stale conversation ${convId} (no activity for 2h+)`);
      delete conversationHistory[convId];
      delete agentCache[convId];
      delete lastActivity[convId];
      recordingStarted.delete(convId);
      clearState(convId);
    }
  }
}, 30 * 60 * 1000);

const server = new TACServer(tac);

server
  .start()
  .then(() => {
    console.log("Lacey's assistant started successfully");
  })
  .catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });