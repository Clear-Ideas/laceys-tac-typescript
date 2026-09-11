export interface LaceysState {
  callerNumber?: string;
  callbackNumber?: string;
  callerName?: string;
  callReason?: string;
  emailSent?: boolean;
  callEnding?: boolean;
}

const state: Record<string, LaceysState> = {};

export function getState(conversationId: string): LaceysState {
  if (!state[conversationId]) {
    state[conversationId] = {};
  }
  return state[conversationId];
}

export function clearState(conversationId: string): void {
  delete state[conversationId];
}