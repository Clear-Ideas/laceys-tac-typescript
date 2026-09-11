import { defineTool, TACTool } from 'twilio-agent-connect';
import googleLibphonenumber from 'google-libphonenumber';
const { PhoneNumberUtil } = googleLibphonenumber;

// Try the caller's number against these regions, in order, until one parses
// as valid. IE first (Lacey's primary market), then GB as a fallback for
// callers who say a UK number in local format without a country code
// (e.g. "07710 400503" instead of "+44 7710 400503").
const REGION_FALLBACKS = ['IE', 'GB'] as const;

export function makeValidatePhoneNumberTool(): TACTool {
  return defineTool(
    'validate_phone_number',
    'Validates and formats a phone number provided by the caller. Call this before confirming any number back to the caller.',
    {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description:
            'The phone number to validate, as spoken by the caller (e.g. "0861234567" or "+353861234567" or "07710400503")',
        },
      },
      required: ['phone'],
    },
    async ({ phone }: { phone: string }) => {
      const phoneUtil = PhoneNumberUtil.getInstance();

      // Speech-to-text often transcribes "+" as the spoken word "plus"
      // (e.g. "Plus 44 8341 66380") rather than the symbol itself. Normalize
      // that to "+" before stripping non-digit characters, otherwise the
      // country code prefix is silently lost and the number gets
      // misinterpreted as a local number.
      const withPlusSymbol = phone.replace(/\bplus\b/gi, '+');
      const cleaned = withPlusSymbol.replace(/[^\d+]/g, '');

      // If the number already includes a country code (starts with +),
      // the region hint barely matters — libphonenumber will detect it
      // correctly regardless of which hint we pass. If it does NOT include
      // a country code, the hint decides how the number is interpreted, so
      // we try each fallback region in turn until one produces a valid number.
      for (const region of REGION_FALLBACKS) {
        try {
          const parsed = phoneUtil.parseAndKeepRawInput(cleaned, region);
          const isValid =
            phoneUtil.isPossibleNumber(parsed) && phoneUtil.isValidNumber(parsed);

          if (isValid) {
            const formatted = phoneUtil.format(parsed, 1); // E164 e.g. +353861234567
            const friendly = phoneUtil.format(parsed, 2); // National e.g. 086 123 4567
            return { valid: true, formatted, friendly };
          }
        } catch {
          // parsing failed for this region hint — try the next one
        }
      }

      return {
        valid: false,
        reason: 'Number does not appear to be valid — please ask the caller to repeat it',
      };
    },
  );
}