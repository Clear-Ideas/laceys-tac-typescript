import twilio from 'twilio';
import { defineTool, TACTool } from 'twilio-agent-connect';

interface EndCallResult {
  success: boolean;
  reason?: string;
}

function getTwilioClient() {
  return twilio(process.env.TWILIO_API_KEY!, process.env.TWILIO_API_SECRET!, {
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
  });
}

/**
 * Ends the active voice call a few seconds after being called, giving the
 * assistant's final goodbye message time to finish playing before hangup.
 * Looks up the in-progress call by the REAL caller address
 * (session.authorInfo.address), not any mock customer phone number.
 */
export async function endCallForCaller(callerAddress: string | undefined): Promise<EndCallResult> {
  if (!callerAddress) {
    return { success: false, reason: 'No caller address available for this call.' };
  }

  setTimeout(() => {
    void (async () => {
      try {
        const client = getTwilioClient();
        const calls = await client.calls.list({
          from: callerAddress,
          status: 'in-progress',
          limit: 1,
        });
        if (calls.length > 0) {
          await client.calls(calls[0]!.sid).update({ status: 'completed' });
        } else {
          console.error(`[end_call] No in-progress call found for from=${callerAddress}`);
        }
      } catch (err) {
        console.error('[end_call] error:', err);
      }
    })();
  }, 7000);

  return { success: true };
}

export function makeEndCallTool(callerAddress: string | undefined): TACTool {
  return defineTool(
    'end_call',
    'Ends the phone call. Call this ONLY as your very last action, right after saying ' +
      'goodbye to the customer — never call this before your goodbye message has been sent.',
    {
      type: 'object',
      properties: {},
      required: [],
    },
    async (): Promise<EndCallResult> => endCallForCaller(callerAddress)
  );
}