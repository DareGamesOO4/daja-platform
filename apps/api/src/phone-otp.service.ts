import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '@daja/security';

export type PhoneOtpPurpose = 'login' | 'link';
type PhoneOtpInput = {
  organizationId: string;
  phone: string;
  purpose: PhoneOtpPurpose;
  customerId?: string;
};

// Reject both operations, including codes issued before the SMS provider was removed.
@Injectable()
export class PhoneOtpService {
  async start(_input: PhoneOtpInput): Promise<{
    status: 'sent'; expiresInSeconds: number; resendAfterSeconds: number;
  }> {
    throw new ValidationFailedError('SMS verifikacija trenutno nije dostupna. Koristite email ili Google prijavu.');
  }

  async verify(_input: PhoneOtpInput & { code: string }): Promise<{ status: 'verified' }> {
    throw new ValidationFailedError('SMS verifikacija trenutno nije dostupna. Koristite email ili Google prijavu.');
  }
}
