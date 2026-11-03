import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '@daja/security';

export interface TransactionalSms {
  phone: string;
  message: string;
  tag: string;
}

@Injectable()
export class SmsDeliveryService {
  async send(_input: TransactionalSms): Promise<void> {
    throw new ValidationFailedError('SMS obaveštenja trenutno nisu dostupna. Izaberite email.');
  }
}
