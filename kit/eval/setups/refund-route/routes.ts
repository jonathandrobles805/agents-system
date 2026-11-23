import { PaymentService } from '../domain/payment';
export function routes(s: PaymentService) {
  return { charge: (u: string) => s.charge(u), refund: (id: string) => s.refund(id) };
}
