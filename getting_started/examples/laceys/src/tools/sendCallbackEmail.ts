import sgMail from '@sendgrid/mail';
import { defineTool, TACTool } from 'twilio-agent-connect';
import { getState } from '../state.js';

export function makeSendCallbackEmailTool(conversationId: string): TACTool {
  return defineTool(
    'send_callback_email',
    "Sends callback details to the Lacey's team. Only call this once you have BOTH the caller's name AND a validated phone number.",
    {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "The caller's name as confirmed during the conversation",
        },
        phone: {
          type: 'string',
          description: 'The validated callback phone number in E164 format (e.g. +353861234567)',
        },
        transcription: {
          type: 'string',
          description: 'A brief summary of what the caller needed (1-2 sentences)',
        },
      },
      required: ['name', 'phone', 'transcription'],
    },
    async ({ name, phone, transcription }: { name: string; phone: string; transcription: string }) => {
      const state = getState(conversationId);

      if (state.emailSent) {
        console.log(`[${conversationId}] Email already sent, skipping.`);
        return { success: true, skipped: true };
      }

      // Never send with zero usable info — a phone number is the minimum
      // needed to be useful at all. A missing name, though, shouldn't block
      // the email entirely: better to flag it clearly and still give the
      // team a number to call back, than to lose the lead outright.
      if (!phone?.trim()) {
        console.warn(`[${conversationId}] send_callback_email called without a phone number — rejecting.`);
        return {
          success: false,
          error: 'Missing phone number — please confirm the callback number with the caller before calling this tool again.',
        };
      }

      const isIncomplete = !name?.trim();
      if (isIncomplete) {
        console.warn(`[${conversationId}] send_callback_email called without a name — sending anyway, flagged as incomplete.`);
      }

      sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

      const now = new Date().toLocaleString('en-IE', {
        timeZone: 'Europe/Dublin',
        dateStyle: 'full',
        timeStyle: 'short',
      });

      const displayName = isIncomplete ? '(name not captured)' : name;
      const subjectFlag = isIncomplete ? '⚠️ INCOMPLETE — ' : '';

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px;">📞 Lacey's — Callback Request</h1>
            <p style="color: #aaaaaa; margin: 4px 0 0 0; font-size: 14px;">${now}</p>
            ${isIncomplete ? '<p style="color: #ffcc00; margin: 4px 0 0 0; font-size: 13px;">⚠️ Caller name was not captured — call back to confirm identity.</p>' : ''}
          </div>
          <div style="background-color: #f9f9f9; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 10px 0; font-weight: bold; color: #555; width: 140px;">Name</td>
                <td style="padding: 10px 0; color: #222;">${displayName}</td>
              </tr>
              <tr style="border-top: 1px solid #e0e0e0;">
                <td style="padding: 10px 0; font-weight: bold; color: #555;">Callback Number</td>
                <td style="padding: 10px 0; color: #222;">${phone}</td>
              </tr>
              <tr style="border-top: 1px solid #e0e0e0;">
                <td style="padding: 10px 0; font-weight: bold; color: #555;">Reason for Call</td>
                <td style="padding: 10px 0; color: #222;">${transcription || '(not captured)'}</td>
              </tr>
            </table>
            <p style="margin-top: 24px; font-size: 12px; color: #aaaaaa;">
              This message was captured automatically by James, Lacey's AI voice assistant.
            </p>
          </div>
        </div>
      `;

      const msg = {
        to: process.env.CALLBACK_NOTIFY_EMAIL!,
        from: {
          email: process.env.SENDGRID_FROM_EMAIL!,
          name: process.env.SENDGRID_FROM_NAME!,
        },
        subject: `📞 ${subjectFlag}Callback Request — ${displayName} (${phone})`,
        text: `Callback Request${isIncomplete ? ' [INCOMPLETE — no name captured]' : ''}\n\nName: ${displayName}\nPhone: ${phone}\nReason: ${transcription || '(not captured)'}\n\nCaptured: ${now}`,
        html,
      };

      try {
        await sgMail.send(msg);
        state.emailSent = true;
        state.callerName = name || undefined;
        state.callbackNumber = phone;
        state.callReason = transcription;
        console.log(
          `[${conversationId}] Callback email sent for ${displayName} (${phone})${isIncomplete ? ' [INCOMPLETE]' : ''}`,
        );
        return { success: true, incomplete: isIncomplete };
      } catch (err) {
        console.error(`[${conversationId}] SendGrid error:`, err);
        return { success: false, error: 'Failed to send email — please try again' };
      }
    },
  );
}